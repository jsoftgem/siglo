import { strict as assert } from 'node:assert';
import { Step, flow, WorkflowEventEmitter, defaultCompensationManager, useStorage } from '@siglo/core';
import { WorkflowHarness, InMemoryStorageFake } from '@siglo/testing';
import type { StandardSchemaV1 } from '@siglo/http';
import { aiStep, AiOutputValidationError, AiProviderError, AiRequestTimeoutError, defineAiTool, estimateTokenCost } from '@siglo/ai';
import { MockAiProvider } from '@siglo/ai/testing';

const schema: StandardSchemaV1<unknown, { n: number }> = { '~standard': {
  version: 1, vendor: 'test', validate: v => typeof (v as any)?.n === 'number'
    ? { value: v as { n: number } } : { issues: [{ message: 'Expected number', path: ['n'] }] }
} };
const jsonSchema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false };
const reply = (text: string, toolCalls?: any[]) => ({ text, toolCalls, promptTokens: 10, completionTokens: 5 });
const config = (adapter: any) => ({ provider: 'openai' as const, model: 'gpt-4o', adapter });
const toolFor = (name: string, log: string[]) => defineAiTool({ name, description: name, inputSchema: schema, jsonSchema,
  step: Step.create(name, ({ n }: { n: number }) => { log.push(name); return { value: n * 2 }; })
    .compensate(() => { log.push(`undo:${name}`); }), mapInput: (args: { n: number }, _ctx: any) => args });

describe('@siglo/ai runtime', () => {
  afterEach(() => { useStorage(); defaultCompensationManager.clear(); });

  it('executes through WorkflowHarness, types structured outputs and retains step metrics', async () => {
    const mock = new MockAiProvider([reply('{"n":4}')]);
    const step = aiStep('structured', { model: config(mock), schema, jsonSchema, prompt: (ctx: { topic: string }) => ctx.topic });
    const harness = new WorkflowHarness(flow(step));
    const result = await harness.run({ topic: 'hello' });
    assert.deepEqual(result.data, { n: 4 });
    assert.equal(result.$steps.structured.aiMetrics.totalTokens, 15);
    assert.equal(result.aiMetrics.estimatedCostUsd, 0.000075);
    assert.equal(mock.requests[0].messages[0].content, 'hello');
    mock.assertDone(); harness.assertStepExecuted('structured', 1);
  });

  it('repairs JSON syntax and schema failures with diagnostics and accounts for every turn', async () => {
    const mock = new MockAiProvider([reply('{oops'), reply('{"n":"wrong"}'), reply('{"n":7}')]);
    const step = aiStep('repair', { model: config(mock), schema, jsonSchema, prompt: 'test' });
    const result = await step.run({});
    assert.equal(result.data.n, 7); assert.equal(result.aiMetrics.repairAttempts, 2);
    assert.equal(result.aiMetrics.totalTokens, 45);
    assert.match(mock.requests[1].messages[2].content, /corrected JSON/);
    assert.match(mock.requests[2].messages[4].content, /Expected number/);
    assert.equal(mock.requests[0].messages.length, 1);
  });

  it('fails after the bounded repair budget, including zero attempts', async () => {
    for (const attempts of [0, 1]) {
      const mock = new MockAiProvider(Array.from({ length: attempts + 1 }, () => reply('invalid')));
      const step = aiStep('bad', { model: config(mock), prompt: 'test', schema, jsonSchema, maxRepairAttempts: attempts });
      await assert.rejects(step.run({}), (err: any) => err instanceof AiOutputValidationError && !err.retryable);
      mock.assertDone();
    }
  });

  it('cascades on rate limits and request timeouts without resetting repair history', async () => {
    const primary = new MockAiProvider([reply('invalid'), new AiProviderError('rate limited', 429)]);
    const secondary = new MockAiProvider([new AiRequestTimeoutError(10)]);
    const final = new MockAiProvider([reply('{"n":9}')]);
    const step = aiStep('cascade', { model: config(primary), fallbackModels: [
      { ...config(secondary), provider: 'anthropic', model: 'test' },
      { ...config(final), provider: 'gemini', model: 'test', pricing: { inputPerMillion: 1, outputPerMillion: 2 } }
    ], schema, jsonSchema, prompt: 'test' });
    const result = await step.run({});
    assert.equal(result.aiMetrics.fallbackCount, 2); assert.equal(result.aiMetrics.repairAttempts, 1);
    assert.equal(result.aiMetrics.modelUsed, 'test'); assert.equal(result.aiMetrics.providerUsed, 'gemini');
    assert.equal(result.aiMetrics.totalTokens, 30);
    assert.equal(final.requests[0].messages.length, 3);
    assert.ok(Math.abs(result.aiMetrics.estimatedCostUsd - 0.000095) < 1e-12);
  });

  it('propagates authentication errors and exhausted fallback errors', async () => {
    for (const status of [401, 503]) {
      const secondary = new MockAiProvider([reply('unused')]);
      const step = aiStep('failure', { model: config(new MockAiProvider([new AiProviderError('bad', status)])),
        fallbackModels: status === 401 ? [config(secondary)] : [], prompt: 'test' });
      await assert.rejects(step.run({}), (err: any) => err.status === status);
      assert.equal(secondary.requests.length, 0);
    }
  });

  it('uses schema-free text, disabled native enforcement and transformed primitive outputs', async () => {
    const text = await aiStep('text', { model: config(new MockAiProvider([reply('plain text')])), prompt: [{ role: 'user', content: 'test' }] }).run({});
    assert.equal(text.data, 'plain text');
    const transform: StandardSchemaV1<unknown, number> = { '~standard': { version: 1, vendor: 'test', validate: () => ({ value: 42 }) } };
    const mock = new MockAiProvider([reply('null')]);
    const result = await aiStep('primitive', { model: config(mock), prompt: 'test', schema: transform, enforceNativeStructuredOutputs: false }).run({});
    assert.equal(result.data, 42); assert.equal(mock.requests[0].jsonSchema, undefined);
    assert.equal(estimateTokenCost('custom', 'unknown', 1, 1), undefined);
    assert.throws(() => estimateTokenCost('custom', 'unknown', 1, 1, { inputPerMillion: -1, outputPerMillion: 1 }));
  });

  it('preflights all fallback destinations before any inference, even with user before hooks', async () => {
    const mock = new MockAiProvider([reply('unused')]);
    const step = aiStep('blocked', { model: config(mock), fallbackModels: [{ ...config(mock), provider: 'anthropic' }], prompt: 'test' });
    step.onBefore(() => true);
    await assert.rejects(flow(step).networkPolicy({ allowedHosts: ['api.openai.com'] }).run({}), (e: any) => e.phase === 'before');
    assert.equal(mock.requests.length, 0);
  });

  it('rejects invalid configuration, prompts, input schemas and adapters before using results', async () => {
    const badOptions = [ { maxRepairAttempts: -1 }, { maxToolTurns: 0.5 }, { maxTokens: 0 }, { temperature: 3 },
      { prompt: [] }, { prompt: [{ role: 'wrong', content: 4 }] }, { schema },
      { inputSchema: schema }, { model: { ...config(new MockAiProvider()), pricing: { inputPerMillion: Infinity, outputPerMillion: 0 } } } ];
    for (const changes of badOptions) {
      const mock = new MockAiProvider([reply('unused')]);
      const step = aiStep('invalid', { model: config(mock), prompt: 'test', ...changes } as any);
      await assert.rejects(step.run({})); assert.equal(mock.requests.length, 0);
    }
    for (const bad of [{ ...reply('x'), text: null }, { ...reply('x'), completionTokens: -1 }, { ...reply('x'), promptTokens: NaN }]) {
      await assert.rejects(aiStep('badAdapter', { model: config(new MockAiProvider([bad as any])), prompt: 'x' }).run({}), /Invalid AI adapter/);
    }
  });

  it('executes tool turns sequentially, serializes results and preserves rollback on later model failure', async () => {
    const log: string[] = [];
    const a = toolFor('a', log), b = toolFor('b', log);
    const mock = new MockAiProvider([reply('', [{ id: '1', name: 'a', arguments: { n: 3 } }, { id: '2', name: 'b', arguments: { n: 4 } }]), reply('done')]);
    const step = aiStep('agent', { model: config(mock), tools: [a, b], prompt: 'test' });
    const result = await step.run({}); assert.equal(result.data, 'done');
    assert.deepEqual(log, ['a', 'b']);
    assert.deepEqual(mock.requests[1].messages.slice(2).map(m => JSON.parse(m.content)), [{ value: 6 }, { value: 8 }]);
    assert.equal(result.aiMetrics.totalTokens, 30);
    for (const downstream of [false, true]) {
      log.length = 0;
      const failure = new MockAiProvider([reply('', [{ id: '1', name: 'a', arguments: { n: 1 } }]),
        downstream ? reply('done') : new Error('inference failed')]);
      const agent = aiStep('rollback', { model: config(failure), tools: [a], prompt: 'test' });
      const fail = Step.create('fail', () => { throw new Error('later failure'); });
      await assert.rejects(flow(agent, ...(downstream ? [fail] : [])).run({}));
      assert.deepEqual(log, ['a', 'undo:a']);
    }
  });

  it('validates a complete tool batch before side effects and rejects repeated IDs/turn overruns', async () => {
    const log: string[] = []; const tool = toolFor('a', log);
    for (const bad of [{ id: '2', name: 'unknown', arguments: { n: 1 } }, { id: '', name: 'a', arguments: { n: 1 } },
      { id: '1', name: 'a', arguments: { n: 1 } }, { id: '2', name: 'a', arguments: { n: 'bad' } }]) {
      const mock = new MockAiProvider([reply('', [{ id: '1', name: 'a', arguments: { n: 1 } }, bad])]);
      await assert.rejects(aiStep('batch', { model: config(mock), prompt: 'test', tools: [tool] }).run({}));
      assert.deepEqual(log, []);
    }
    const call = reply('', [{ id: '1', name: 'a', arguments: { n: 1 } }]);
    for (const limit of [0, 1]) {
      const mock = new MockAiProvider([call, reply('', [{ id: '2', name: 'a', arguments: { n: 1 } }])]);
      await assert.rejects(aiStep('turns', { model: config(mock), tools: [tool], maxToolTurns: limit, prompt: 'test' }).run({}), /turn limit/);
    }
  });

  it('forbids tool caching, retries, idempotency and reserved tool names', async () => {
    const tool = toolFor('a', []);
    const step = aiStep('tools', { model: config(new MockAiProvider()), tools: [tool], prompt: 'test' });
    assert.throws(() => step.cache(), /cannot be cached/);
    assert.throws(() => step.onFail({ maxAttempts: 2 } as any), /cannot use/);
    assert.throws(() => step.idempotent('id'), /cannot use/);
    step.cachedLast = 100;
    await assert.rejects(step.run({}), /cannot use caching/);
    const reserved = aiStep('reserved', { model: config(new MockAiProvider()), prompt: 'test', tools: [{ ...tool, name: 'siglo_structured_output' }] });
    await assert.rejects(reserved.run({}), /Reserved/);
  });

  it('aborts hanging requests on workflow cancellation without attempting fallback', async () => {
    const controller = new AbortController(); const fallback = new MockAiProvider([reply('unused')]);
    let signal: AbortSignal | undefined;
    const adapter = { generate: async (request: any) => { signal = request.signal; controller.abort(new Error('cancelled')); return new Promise<any>(() => {}); } };
    const step = aiStep('cancel', { model: config(adapter), fallbackModels: [config(fallback)], prompt: 'test' });
    await assert.rejects(step.run({}, { signal: controller.signal }));
    assert.equal(signal?.aborted, true); assert.equal(fallback.requests.length, 0);
  });

  it('uses actual request deadlines to fall back and leaves unknown costs undefined', async () => {
    const mock = new MockAiProvider([reply('ok')]);
    const step = aiStep('timeout', { model: { ...config({ generate: async () => new Promise<any>(() => {}) }), requestTimeoutMs: 5 },
      fallbackModels: [{ provider: 'custom', model: 'unknown', baseUrl: 'https://mock.example/v1', adapter: mock }], prompt: 'test' });
    const result = await step.run({}); assert.equal(result.aiMetrics.fallbackCount, 1);
    assert.equal(result.aiMetrics.estimatedCostUsd, undefined);
  });

  it('hashes prompt/model/context cache inputs, avoids network on hits, and checks policy on hits', async () => {
    const storage = new InMemoryStorageFake(); useStorage(storage);
    const mock = new MockAiProvider([reply('first'), reply('second'), reply('third')]);
    let version = 'one';
    const step = aiStep('cached', { model: config(mock), prompt: (ctx: { q: string }) => version + ctx.q }).cache({ ttl: 1000, keySerializer: (_id, ctx) => ctx.q });
    assert.equal((await step.run({ q: 'a' })).data, 'first');
    assert.equal((await step.run({ q: 'a' })).data, 'first');
    assert.equal(mock.requests.length, 1);
    version = 'two'; assert.equal((await step.run({ q: 'a' })).data, 'second');
    assert.equal((await step.run({ q: 'b' })).data, 'third');
    await assert.rejects(flow(step).networkPolicy({ allowedHosts: [] }).run({ q: 'b' }));
    assert.equal(mock.requests.length, 3);
    const cached = aiStep('simpleCache', { model: config(new MockAiProvider([reply('ok')])), prompt: 'x' }).cache(1000);
    assert.equal((await cached.run({})).data, 'ok');
  });

  it('retains inference lifecycle controls on text steps and propagates transformed input', async () => {
    const mock = new MockAiProvider([reply('ok')]);
    const step = aiStep('controls', { model: config(mock), prompt: (ctx: any) => ctx.query,
      inputSchema: { '~standard': { version: 1, vendor: 'test', validate: () => ({ value: { query: 'transformed' } }) } } });
    step.onBefore(() => true).onFail({ maxAttempts: 1 } as any).idempotent('ai-foundation-controls');
    assert.equal((await step.run({})).data, 'ok');
    assert.equal(mock.requests[0].messages[0].content, 'transformed');
    const stored = new InMemoryStorageFake(); useStorage(stored);
    const opts = { model: config(new MockAiProvider([reply('cached')])), prompt: 'same', cacheVersion: 'v1' };
    assert.equal((await aiStep('portableCache', opts).cache().run({})).data, 'cached');
    // Equivalent instances on another worker must share the same fingerprint.
    assert.equal((await aiStep('portableCache', { ...opts, model: config(new MockAiProvider()) }).cache().run({})).data, 'cached');
  });

  it('emits typed completion metrics with no prompts and tolerates broken telemetry', async () => {
    const monitor = new WorkflowEventEmitter(); const events: any[] = [];
    monitor.on('ai:complete', e => { events.push(e); });
    const step = aiStep('observed', { model: config(new MockAiProvider([reply('private answer')])), prompt: 'private prompt' });
    const attributes: any = {};
    await flow(step).run({ span: { spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }), setAttribute: (key: string, value: unknown) => { attributes[key] = value; } } }, { monitor });
    assert.equal(events.length, 1); assert.equal(events[0].aiMetrics.totalTokens, 15);
    assert.equal(JSON.stringify(events).includes('private'), false);
    assert.equal(attributes['gen_ai.usage.input_tokens'], 10);
    assert.equal(attributes['gen_ai.provider.name'], 'openai');
    const badSpan = aiStep('badSpan', { model: config(new MockAiProvider([reply('ok')])), prompt: 'x' });
    await badSpan.action({ $span: { setAttribute() { throw new Error('bad telemetry'); } } });
  });

  it('records and strictly replays mocked responses and typed failures without network', async () => {
    const provider = new MockAiProvider([reply('ok'), new AiProviderError('rate limit', 429), new AiRequestTimeoutError(4), new Error('other')]);
    const req = { model: 'test', messages: [{ role: 'user' as const, content: 'x' }], signal: new AbortController().signal };
    assert.throws(() => provider.assertDone(), /unused/);
    assert.equal((await provider.generate(req)).text, 'ok');
    for (let i = 0; i < 3; i++) await assert.rejects(provider.generate(req));
    const recording = JSON.parse(JSON.stringify(provider.exportRecording()));
    const replay = MockAiProvider.replay(recording);
    assert.equal((await replay.generate(req)).text, 'ok');
    await assert.rejects(replay.generate(req), AiProviderError);
    await assert.rejects(replay.generate(req), AiRequestTimeoutError);
    await assert.rejects(replay.generate(req), /other/);
    await assert.rejects(replay.generate(req), /mismatch/);
    await assert.rejects(MockAiProvider.replay(recording).generate({ ...req, model: 'changed' }), /mismatch/);
    provider.assertDone(); await assert.rejects(provider.generate(req), /exhausted/);
  });
});
