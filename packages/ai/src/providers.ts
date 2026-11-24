import { randomUUID } from 'node:crypto';
import { isPlainObject } from '@siglo/core';
import { assertNetworkPolicy, injectTraceHeaders, type SpanLike } from '@siglo/http';
import { AiProviderError } from './execution';
import type { AiModelConfig, AiProviderAdapter, AiProviderRequest, AiProviderResponse, ChatMessage } from './types';

export const STRUCTURED_OUTPUT_TOOL = 'siglo_structured_output';
export type ResolvedAiModel = Omit<AiModelConfig, 'apiKey'> & { baseUrl: string; apiKey?: string };
export interface ProviderTransportOptions {
    fetch?: typeof fetch;
    span?: SpanLike;
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
    const result: { role: string; content: unknown[] }[] = [];
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
    const result: { role: string; parts: unknown[] }[] = [];
    for (const message of messages.filter(m => m.role !== 'system')) {
        const role = message.role === 'assistant' ? 'model' : 'user';
        const parts =
            message.providerState?.provider === 'gemini'
                ? Array.isArray(message.providerState.content)
                    ? message.providerState.content
                    : []
                : message.role === 'tool'
                  ? [
                        {
                            functionResponse: {
                                name: message.name,
                                id: message.toolCallId?.startsWith('siglo_') ? undefined : message.toolCallId,
                                response: { result: parseArgs(message.content) },
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
            let body: Record<string, unknown>;
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
            const rawData: unknown = await response.json();
            if (!isPlainObject(rawData)) {
                throw new Error(`Invalid ${provider} response`);
            }
            const data = rawData as Record<string, unknown>;
            if (provider === 'anthropic') {
                if (!Array.isArray(data.content)) throw new Error('Invalid Anthropic response');
                if (data.stop_reason === 'refusal') throw new Error('Anthropic refused the response');
                if (data.stop_reason === 'max_tokens') throw new Error('Anthropic response was truncated');
                const blocks = data.content.filter(isPlainObject);
                const final = blocks.filter(p => p.type === 'tool_use' && p.name === STRUCTURED_OUTPUT_TOOL);
                const calls = blocks.filter(p => p.type === 'tool_use' && p.name !== STRUCTURED_OUTPUT_TOOL);
                if (final.length > 1 || (final.length && calls.length))
                    throw new Error('Ambiguous Anthropic structured output');
                const usage = isPlainObject(data.usage) ? data.usage : undefined;
                return {
                    text: unwrap(
                        final.length
                            ? JSON.stringify(final[0].input)
                            : blocks
                                  .filter(p => p.type === 'text')
                                  .map(p => requireText(p.text))
                                  .join(''),
                    ),
                    toolCalls: calls.map(p => ({
                        id: String(p.id ?? ''),
                        name: String(p.name ?? ''),
                        arguments: p.input,
                    })),
                    promptTokens: tokens(usage?.input_tokens),
                    completionTokens: tokens(usage?.output_tokens),
                };
            }
            if (provider === 'gemini') {
                const candidates = Array.isArray(data.candidates) ? data.candidates : undefined;
                const candidate = candidates && isPlainObject(candidates[0]) ? candidates[0] : undefined;
                const candContent = candidate && isPlainObject(candidate.content) ? candidate.content : undefined;
                if (
                    !candContent ||
                    !Array.isArray(candContent.parts) ||
                    (candidate?.finishReason && candidate.finishReason !== 'STOP')
                ) {
                    throw new Error('Gemini response was blocked, truncated or empty');
                }
                const parts = candContent.parts;
                const objParts = parts.filter(isPlainObject);
                const usageMeta = isPlainObject(data.usageMetadata) ? data.usageMetadata : undefined;
                return {
                    text: objParts
                        .filter(p => typeof p.text === 'string' && !p.thought)
                        .map(p => String(p.text))
                        .join(''),
                    toolCalls: objParts
                        .filter(p => isPlainObject(p.functionCall))
                        .map(p => {
                            const fc = p.functionCall as Record<string, unknown>;
                            return {
                                id: typeof fc.id === 'string' ? fc.id : `siglo_${randomUUID()}`,
                                name: String(fc.name ?? ''),
                                arguments: fc.args,
                            };
                        }),
                    providerState: { provider: 'gemini', content: parts },
                    promptTokens: tokens(usageMeta?.promptTokenCount),
                    completionTokens: tokens(usageMeta?.candidatesTokenCount) + tokens(usageMeta?.thoughtsTokenCount),
                };
            }
            const choices = Array.isArray(data.choices) ? data.choices : undefined;
            const choice = choices && isPlainObject(choices[0]) ? choices[0] : undefined;
            const choiceMsg = choice && isPlainObject(choice.message) ? choice.message : undefined;
            if (
                !choiceMsg ||
                choiceMsg.refusal ||
                typeof choice?.finish_reason !== 'string' ||
                !['stop', 'tool_calls'].includes(choice.finish_reason)
            ) {
                throw new Error('OpenAI-compatible response was refused, truncated or invalid');
            }
            const rawToolCalls = Array.isArray(choiceMsg.tool_calls)
                ? choiceMsg.tool_calls.filter(isPlainObject)
                : undefined;
            const usage = isPlainObject(data.usage) ? data.usage : undefined;
            return {
                text: unwrap(choiceMsg.content === null && rawToolCalls?.length ? '' : requireText(choiceMsg.content)),
                toolCalls: rawToolCalls?.map(c => {
                    const fn = isPlainObject(c.function) ? c.function : undefined;
                    return {
                        id: String(c.id ?? ''),
                        name: String(fn?.name ?? ''),
                        arguments: parseArgs(fn?.arguments),
                    };
                }),
                promptTokens: tokens(usage?.prompt_tokens),
                completionTokens: tokens(usage?.completion_tokens),
            };
        },
    };
}
