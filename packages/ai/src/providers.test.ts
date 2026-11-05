import { strict as assert } from 'node:assert';
import { networkPolicyStorage } from '@siglo/core';
import { createAiProvider, AiProviderError, STRUCTURED_OUTPUT_TOOL, aiStep } from '@siglo/ai';
import type { AiProvider, ChatMessage } from '@siglo/ai';

const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false };
const base = { messages: [{ role: 'user' as const, content: 'hello' }], model: 'test', signal: new AbortController().signal };
function fixture(provider: AiProvider, data: any, status = 200) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  };
  const adapter = createAiProvider({ provider, model: 'test', baseUrl: 'https://provider.example/v1', apiKey: 'secret' }, {
    fetch: fetcher, span: { spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }) }
  });
  return { adapter, calls };
}
const openai = { choices: [{ finish_reason: 'stop', message: { content: '{"n":2}' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } };
const anthropic = { content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } };
const gemini = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'answer' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 1 } };

describe('@siglo/ai provider adapters (offline transport)', () => {
  it('serializes OpenAI native output/tool schemas, history, credentials and trace headers', async () => {
    const { adapter, calls } = fixture('openai', openai);
    const result = await adapter.generate({ ...base, temperature: 0.2, maxTokens: 100, jsonSchema: schema,
      tools: [{ name: 'calculate', description: 'calculate', parameters: schema }],
      messages: [ { role: 'system', content: 'system' }, ...base.messages,
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'calculate', arguments: { n: 1 } }] },
        { role: 'tool', content: '{"value":2}', toolCallId: 'c1', name: 'calculate' } ] });
    assert.equal(result.text, '{"n":2}'); assert.equal(result.promptTokens, 4);
    const { body, init, url } = calls[0];
    assert.equal(url, 'https://provider.example/v1/chat/completions');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema, schema);
    assert.equal(body.max_completion_tokens, 100); assert.equal(body.temperature, 0.2);
    assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"n":1}');
    assert.equal(body.messages[3].tool_call_id, 'c1'); assert.equal(body.tools[0].function.name, 'calculate');
    assert.equal((init.headers as any).authorization, 'Bearer secret');
    assert.match((init.headers as any).traceparent, /^00-aaaa/);
    assert.equal(init.redirect, 'error'); assert.equal(init.signal, base.signal);
  });

  it('supports generic/Ollama max_tokens and parses malformed tool arguments without executing them', async () => {
    for (const provider of ['custom', 'ollama'] as const) {
      const { adapter, calls } = fixture(provider, { choices: [{ finish_reason: 'tool_calls', message: { content: null,
        tool_calls: [{ id: '1', function: { name: 'a', arguments: '{"n":1}' } }, { id: '2', function: { name: 'a', arguments: 'bad JSON' } },
          { id: '3', function: { name: 'a', arguments: { n: 2 } } }] } }] });
      const result = await adapter.generate({ ...base, maxTokens: 10 });
      assert.equal(calls[0].body.max_tokens, 10); assert.equal(result.text, '');
      assert.deepEqual(result.toolCalls?.map(c => c.arguments), [{ n: 1 }, 'bad JSON', { n: 2 }]);
      assert.equal(result.promptTokens, 0);
    }
  });

  it('serializes Anthropic multi-tool results as a single user message and extracts final schema tool', async () => {
    const { adapter, calls } = fixture('anthropic', { ...anthropic,
      content: [{ type: 'tool_use', id: 'final', name: STRUCTURED_OUTPUT_TOOL, input: { n: 4 } }] });
    const history: ChatMessage[] = [ { role: 'system', content: 'first' }, { role: 'system', content: 'second' },
      ...base.messages, { role: 'assistant', content: 'thinking', toolCalls: [
        { id: '1', name: 'a', arguments: { n: 1 } }, { id: '2', name: 'a', arguments: { n: 2 } }] },
      { role: 'tool', content: '1', toolCallId: '1', name: 'a' }, { role: 'tool', content: '2', toolCallId: '2', name: 'a' } ];
    const result = await adapter.generate({ ...base, messages: history, jsonSchema: schema, tools: [{ name: 'a', description: 'a', parameters: schema }] });
    assert.equal(result.text, '{"n":4}'); assert.equal(result.completionTokens, 2);
    assert.equal(calls[0].url, 'https://provider.example/v1/v1/messages');
    const body = calls[0].body;
    assert.equal(body.system, 'first\n\nsecond'); assert.equal(body.max_tokens, 4096);
    assert.equal(body.tool_choice.type, 'any'); assert.equal(body.tools.length, 2);
    assert.equal(body.messages.length, 3); assert.equal(body.messages[2].content.length, 2);
    assert.equal(body.messages[1].content[1].type, 'tool_use');
    assert.equal((calls[0].init.headers as any)['x-api-key'], 'secret');
    assert.equal((calls[0].init.headers as any)['anthropic-version'], '2023-06-01');
  });

  it('parses ordinary Anthropic text and real tool calls independently of schema output', async () => {
    const first = fixture('anthropic', anthropic);
    assert.equal((await first.adapter.generate(base)).text, 'answer'); assert.equal(first.calls[0].body.tools, undefined);
    const tool = fixture('anthropic', { ...anthropic, content: [{ type: 'tool_use', id: '1', name: 'a', input: { n: 1 } }] });
    assert.deepEqual((await tool.adapter.generate(base)).toolCalls, [{ id: '1', name: 'a', arguments: { n: 1 } }]);
  });

  it('serializes Gemini JSON Schema, tools and thought signatures without modifying signed parts', async () => {
    const parts = [{ thought: true, text: 'private reasoning', thoughtSignature: 'sig' },
      { functionCall: { id: 'c1', name: 'a', args: { n: 1 } }, thoughtSignature: 'signature' },
      { functionCall: { name: 'a', args: { n: 2 } } }];
    const first = fixture('gemini', { ...gemini, candidates: [{ finishReason: 'STOP', content: { parts } }] });
    const result = await first.adapter.generate(base);
    assert.equal(result.text, ''); assert.equal(result.completionTokens, 3); assert.equal(result.toolCalls?.length, 2);
    const followup = fixture('gemini', gemini);
    const history: ChatMessage[] = [ { role: 'system', content: 'system' }, ...base.messages,
      { role: 'assistant', content: result.text, toolCalls: result.toolCalls, providerState: result.providerState },
      ...result.toolCalls!.map(c => ({ role: 'tool' as const, toolCallId: c.id, name: c.name, content: '{"value":2}' })) ];
    const final = await followup.adapter.generate({ ...base, model: 'model/name', messages: history, jsonSchema: schema,
      tools: [{ name: 'a', description: 'a', parameters: schema }], maxTokens: 20 });
    assert.equal(final.text, 'answer');
    const { body, init, url } = followup.calls[0];
    assert.match(url, /model%2Fname:generateContent$/);
    assert.deepEqual(body.contents[1].parts, parts);
    assert.equal(body.contents[2].parts[0].functionResponse.id, 'c1');
    assert.equal(body.contents[2].parts[1].functionResponse.id, undefined);
    assert.deepEqual(body.contents[2].parts[0].functionResponse.response, { result: { value: 2 } });
    assert.deepEqual(body.generationConfig.responseJsonSchema, schema);
    assert.deepEqual(body.tools[0].functionDeclarations[0].parametersJsonSchema, schema);
    assert.equal(body.systemInstruction.parts[0].text, 'system');
    assert.equal((init.headers as any)['x-goog-api-key'], 'secret');
    await followup.adapter.generate({ ...base, messages: [{ role: 'assistant', content: 'text', toolCalls: [{ id: 'x', name: 'a', arguments: {} }] }] });
    assert.equal(followup.calls[1].body.contents[0].parts[1].functionCall.name, 'a');
  });

  it('fails closed on provider refusals, truncation, malformed payloads and invalid token accounting', async () => {
    const invalid: [AiProvider, any][] = [
      ['openai', {}], ['openai', { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }],
      ['openai', { choices: [{ finish_reason: 'stop', message: { content: '', refusal: 'no' } }] }],
      ['openai', { choices: [{ finish_reason: 'stop', message: { content: 123 } }] }],
      ['openai', { ...openai, usage: { prompt_tokens: -1 } }],
      ['anthropic', {}], ['anthropic', { ...anthropic, stop_reason: 'refusal' }],
      ['anthropic', { ...anthropic, stop_reason: 'max_tokens' }],
      ['anthropic', { ...anthropic, content: [{ type: 'text', text: 3 }] }],
      ['anthropic', { ...anthropic, content: [1, 2].map(id => ({ type: 'tool_use', id, name: STRUCTURED_OUTPUT_TOOL, input: {} })) }],
      ['anthropic', { ...anthropic, content: [{ type: 'tool_use', id: '1', name: STRUCTURED_OUTPUT_TOOL, input: {} }, { type: 'tool_use', id: '2', name: 'a', input: {} }] }],
      ['gemini', {}], ['gemini', { candidates: [{ finishReason: 'SAFETY' }] }],
      ['gemini', { ...gemini, usageMetadata: { promptTokenCount: '10' } }]
    ];
    for (const [provider, data] of invalid) await assert.rejects(fixture(provider, data).adapter.generate(base));
    const failure = fixture('openai', { secret: 'do not echo' }, 429);
    await assert.rejects(failure.adapter.generate(base), (err: any) => err instanceof AiProviderError && err.status === 429 && !err.message.includes('echo'));
    await assert.rejects(fixture('openai', {}, 302).adapter.generate(base), (err: any) => err.status === 302);
  });

  it('envelopes primitive and array native schemas while preserving the public data shape', async () => {
    const arraySchema = { type: 'array', items: { type: 'number' } };
    const first = fixture('openai', { ...openai, choices: [{ finish_reason: 'stop', message: { content: '{"data":[1,2]}' } }] });
    assert.equal((await first.adapter.generate({ ...base, jsonSchema: arraySchema })).text, '[1,2]');
    assert.deepEqual(first.calls[0].body.response_format.json_schema.schema.properties.data, arraySchema);
    const second = fixture('anthropic', { ...anthropic, content: [{ type: 'tool_use', id: '1', name: STRUCTURED_OUTPUT_TOOL, input: { data: 42 } }] });
    assert.equal((await second.adapter.generate({ ...base, jsonSchema: { type: 'number' } })).text, '42');
    for (const text of ['malformed', '{}', 'null']) {
      const invalid = fixture('openai', { ...openai, choices: [{ finish_reason: 'stop', message: { content: text } }] });
      assert.equal((await invalid.adapter.generate({ ...base, jsonSchema: { type: 'number' } })).text, text);
    }
  });

  it('checks network policy again at the actual destination and aborts before dispatch', async () => {
    const { adapter, calls } = fixture('openai', openai);
    await networkPolicyStorage.run({ enabled: true, defaultPolicy: 'deny', allowedHosts: ['other.example'], allowLocalhost: false, stepName: 'ai' }, async () => {
      await assert.rejects(adapter.generate(base));
    });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(adapter.generate({ ...base, signal: controller.signal }));
    assert.equal(calls.length, 0);
  });

  it('uses the built-in adapter through aiStep without any global network egress', async () => {
    const original = globalThis.fetch;
    const recorded: any[] = [];
    try {
      globalThis.fetch = async (_url, init) => { recorded.push(init); return new Response(JSON.stringify(openai)); };
      const result = await aiStep('rest', { model: { provider: 'custom', model: 'test', baseUrl: 'https://mock.example/v1' }, prompt: 'test' }).action({});
      assert.equal(result.data, '{"n":2}'); assert.equal(recorded.length, 1);
      assert.equal(recorded[0].headers.authorization, undefined);
    } finally { globalThis.fetch = original; }
  });
});
