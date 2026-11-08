import { randomUUID } from 'node:crypto';
import { assertNetworkPolicy, injectTraceHeaders } from '@siglo/http';
import { AiProviderError } from './execution';
import type { AiModelConfig, AiProviderAdapter, AiProviderRequest, AiProviderResponse, ChatMessage } from './types';

export const STRUCTURED_OUTPUT_TOOL = 'siglo_structured_output';
export type ResolvedAiModel = Omit<AiModelConfig, 'apiKey'> & { baseUrl: string; apiKey?: string };
export interface ProviderTransportOptions {
    fetch?: typeof fetch;
    span?: any;
    stepName?: string;
}

function tokens(value: unknown): number {
    if (value === undefined) return 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new Error('Invalid provider token usage');
    return value;
}
function parseArgs(value: unknown): unknown {
    // Keep malformed JSON as a string; the engine rejects it before tool execution.
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}
function requireText(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Provider returned no text response');
    return value;
}
function openaiMessages(messages: ChatMessage[]) {
    return messages.map(m => ({
        role: m.role,
        content: m.content,
        name: m.name,
        tool_call_id: m.toolCallId,
        tool_calls: m.toolCalls?.map(c => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
    }));
}
function anthropicMessages(messages: ChatMessage[]) {
    const result: { role: string; content: any[] }[] = [];
    for (const message of messages.filter(m => m.role !== 'system')) {
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        const content =
            message.role === 'tool'
                ? [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }]
                : [
                      ...(message.content ? [{ type: 'text', text: message.content }] : []),
                      ...(message.toolCalls ?? []).map(c => ({
                          type: 'tool_use',
                          id: c.id,
                          name: c.name,
                          input: c.arguments,
                      })),
                  ];
        const last = result[result.length - 1];
        if (last?.role === role) last.content.push(...content);
        else result.push({ role, content });
    }
    return result;
}
function geminiMessages(messages: ChatMessage[]) {
    const result: { role: string; parts: any[] }[] = [];
    for (const message of messages.filter(m => m.role !== 'system')) {
        const role = message.role === 'assistant' ? 'model' : 'user';
        const parts =
            message.providerState?.provider === 'gemini'
                ? (message.providerState.content as any[])
                : message.role === 'tool'
                  ? [
                        {
                            functionResponse: {
                                name: message.name,
                                id: message.toolCallId?.startsWith('siglo_') ? undefined : message.toolCallId,
                                response: { result: JSON.parse(message.content) },
                            },
                        },
                    ]
                  : [
                        ...(message.content ? [{ text: message.content }] : []),
                        ...(message.toolCalls ?? []).map(c => ({
                            functionCall: { id: c.id, name: c.name, args: c.arguments },
                        })),
                    ];
        const last = result[result.length - 1];
        if (last?.role === role) last.parts.push(...parts);
        else result.push({ role, parts: [...parts] });
    }
    return result;
}

/** Stateless REST adapter. The execution engine owns all retry and tool decisions. */
export function createAiProvider(model: ResolvedAiModel, transport: ProviderTransportOptions = {}): AiProviderAdapter {
    return {
        async generate(request: AiProviderRequest): Promise<AiProviderResponse> {
            const provider = model.provider;
            // OpenAI/Anthropic require object roots; preserve primitive/array schemas via an envelope.
            const envelope = provider !== 'gemini' && request.jsonSchema && request.jsonSchema.type !== 'object';
            const nativeSchema = envelope
                ? {
                      type: 'object',
                      properties: { data: request.jsonSchema },
                      required: ['data'],
                      additionalProperties: false,
                  }
                : request.jsonSchema;
            const unwrap = (text: string): string => {
                if (!envelope) return text;
                try {
                    const parsed = JSON.parse(text);
                    return Object.hasOwn(parsed, 'data') ? JSON.stringify(parsed.data) : text;
                } catch {
                    return text;
                }
            };
            const system = request.messages
                .filter(m => m.role === 'system')
                .map(m => m.content)
                .join('\n\n');
            let path: string;
            let body: any;
            const headers: Record<string, string> = { 'content-type': 'application/json' };
            if (provider === 'anthropic') {
                path = '/v1/messages';
                if (model.apiKey) headers['x-api-key'] = model.apiKey;
                headers['anthropic-version'] = '2023-06-01';
                const tools = (request.tools ?? []).map(t => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.parameters,
                }));
                if (nativeSchema)
                    tools.push({
                        name: STRUCTURED_OUTPUT_TOOL,
                        description: 'Return the final structured response',
                        input_schema: nativeSchema,
                    });
                body = {
                    model: request.model,
                    system: system || undefined,
                    messages: anthropicMessages(request.messages),
                    max_tokens: request.maxTokens ?? 4096,
                    temperature: request.temperature,
                    tools: tools.length ? tools : undefined,
                    tool_choice: request.jsonSchema ? { type: 'any' } : undefined,
                };
            } else if (provider === 'gemini') {
                path = `/models/${encodeURIComponent(request.model)}:generateContent`;
                if (model.apiKey) headers['x-goog-api-key'] = model.apiKey;
                body = {
                    contents: geminiMessages(request.messages),
                    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
                    generationConfig: {
                        temperature: request.temperature,
                        maxOutputTokens: request.maxTokens,
                        responseMimeType: request.jsonSchema ? 'application/json' : undefined,
                        responseJsonSchema: request.jsonSchema,
                    },
                    tools: request.tools?.length
                        ? [
                              {
                                  functionDeclarations: request.tools.map(t => ({
                                      name: t.name,
                                      description: t.description,
                                      parametersJsonSchema: t.parameters,
                                  })),
                              },
                          ]
                        : undefined,
                };
            } else {
                path = '/chat/completions';
                if (model.apiKey) headers.authorization = `Bearer ${model.apiKey}`;
                body = {
                    model: request.model,
                    messages: openaiMessages(request.messages),
                    temperature: request.temperature,
                    ...(provider === 'openai'
                        ? { max_completion_tokens: request.maxTokens }
                        : { max_tokens: request.maxTokens }),
                    response_format: request.jsonSchema
                        ? {
                              type: 'json_schema',
                              json_schema: {
                                  name: 'siglo_output',
                                  strict: true,
                                  schema: nativeSchema,
                              },
                          }
                        : undefined,
                    tools: request.tools?.length
                        ? request.tools.map(t => ({
                              type: 'function',
                              function: {
                                  name: t.name,
                                  description: t.description,
                                  parameters: t.parameters,
                              },
                          }))
                        : undefined,
                };
            }
            const url = new URL(`${model.baseUrl.replace(/\/$/, '')}${path}`);
            assertNetworkPolicy(transport.stepName ?? 'ai', url.href, url.hostname, url.port || undefined);
            request.signal.throwIfAborted();
            const response = await (transport.fetch ?? globalThis.fetch)(url.href, {
                method: 'POST',
                headers: injectTraceHeaders(headers, transport.span),
                body: JSON.stringify(body),
                signal: request.signal,
                redirect: 'error',
            });
            if (!response.ok) {
                // Provider bodies can echo prompts or credentials. Never attach them to errors/telemetry.
                await response.body?.cancel();
                throw new AiProviderError(`AI provider ${provider} returned HTTP ${response.status}`, response.status);
            }
            const data: any = await response.json();
            if (provider === 'anthropic') {
                if (!Array.isArray(data.content)) throw new Error('Invalid Anthropic response');
                if (data.stop_reason === 'refusal') throw new Error('Anthropic refused the response');
                if (data.stop_reason === 'max_tokens') throw new Error('Anthropic response was truncated');
                const final = data.content.filter(
                    (p: any) => p.type === 'tool_use' && p.name === STRUCTURED_OUTPUT_TOOL,
                );
                const calls = data.content.filter(
                    (p: any) => p.type === 'tool_use' && p.name !== STRUCTURED_OUTPUT_TOOL,
                );
                if (final.length > 1 || (final.length && calls.length))
                    throw new Error('Ambiguous Anthropic structured output');
                return {
                    text: unwrap(
                        final.length
                            ? JSON.stringify(final[0].input)
                            : data.content
                                  .filter((p: any) => p.type === 'text')
                                  .map((p: any) => requireText(p.text))
                                  .join(''),
                    ),
                    toolCalls: calls.map((p: any) => ({ id: p.id, name: p.name, arguments: p.input })),
                    promptTokens: tokens(data.usage?.input_tokens),
                    completionTokens: tokens(data.usage?.output_tokens),
                };
            }
            if (provider === 'gemini') {
                const candidate = data.candidates?.[0];
                if (!candidate?.content?.parts || (candidate.finishReason && candidate.finishReason !== 'STOP')) {
                    throw new Error('Gemini response was blocked, truncated or empty');
                }
                const parts = candidate.content.parts;
                return {
                    text: parts
                        .filter((p: any) => typeof p.text === 'string' && !p.thought)
                        .map((p: any) => p.text)
                        .join(''),
                    toolCalls: parts
                        .filter((p: any) => p.functionCall)
                        .map((p: any) => ({
                            id: p.functionCall.id ?? `siglo_${randomUUID()}`,
                            name: p.functionCall.name,
                            arguments: p.functionCall.args,
                        })),
                    providerState: { provider: 'gemini', content: parts },
                    promptTokens: tokens(data.usageMetadata?.promptTokenCount),
                    completionTokens:
                        tokens(data.usageMetadata?.candidatesTokenCount) +
                        tokens(data.usageMetadata?.thoughtsTokenCount),
                };
            }
            const choice = data.choices?.[0];
            if (!choice?.message || choice.message.refusal || !['stop', 'tool_calls'].includes(choice.finish_reason)) {
                throw new Error('OpenAI-compatible response was refused, truncated or invalid');
            }
            return {
                text: unwrap(
                    choice.message.content === null && choice.message.tool_calls?.length
                        ? ''
                        : requireText(choice.message.content),
                ),
                toolCalls: choice.message.tool_calls?.map((c: any) => ({
                    id: c.id,
                    name: c.function?.name,
                    arguments: parseArgs(c.function?.arguments),
                })),
                promptTokens: tokens(data.usage?.prompt_tokens),
                completionTokens: tokens(data.usage?.completion_tokens),
            };
        },
    };
}
