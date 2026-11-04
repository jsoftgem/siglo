import { strict as assert } from 'node:assert';
import { Step, flow, defaultCompensationManager, networkPolicyStorage } from 'siglo';
import { validatePayload, assertNetworkPolicy } from '@siglo/http';
import type { StandardSchemaV1 } from '@siglo/http';
import { AiProviderError, AiRequestTimeoutError, shouldFallback, withAiRequest, getExecutionSignal,
  createAiResult, resolveJsonSchema, resolveModel, defineAiTool, describeAiTools, executeAiTool } from '@siglo/ai';

const schema: StandardSchemaV1<unknown, { n: number }> = {
  '~standard': { version: 1, vendor: 'test', validate: value =>
    typeof (value as any)?.n === 'number' ? { value: value as { n: number } }
      : { issues: [{ message: 'Expected number', path: [{ key: 'n' }] }] } }
};
const jsonSchema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] };
const metrics = { promptTokens: 1, completionTokens: 2, totalTokens: 3, latencyMs: 1,
  modelUsed: 'test', providerUsed: 'custom' as const, repairAttempts: 0, fallbackCount: 0 };

const makeTool = (name: string, log: string[] = []) => defineAiTool({
  name, description: name, inputSchema: schema, jsonSchema,
  step: Step.create(name, (input: { n: number }) => { log.push(name); return { value: input.n }; })
    .compensate(() => { log.push(`undo:${name}`); }),
  mapInput: (args: { n: number }, _ctx: any) => args
});

describe('@siglo/ai prerequisites', () => {
  afterEach(() => defaultCompensationManager.clear());

  it('preserves transformed undefined and structured diagnostic paths', async () => {
    const transformed: StandardSchemaV1 = { '~standard': { version: 1, vendor: 'test',
      validate: async () => ({ value: undefined }) } };
    assert.equal(await validatePayload(transformed, 'input', 'action'), undefined);
    await assert.rejects(validatePayload(schema, { n: 'bad' }, 'action'), (err: any) => {
      assert.match(JSON.stringify(err), /Expected number/);
      assert.equal(err.errors[0].field, 'n');
      return true;
    });
    await assert.rejects(validatePayload({ '~standard': { validate: () => ({ issues: [] }) } }, 1, 'action'));
    await assert.rejects(validatePayload({ '~standard': { validate: () => ({}) } }, 1, 'action'), TypeError);
  });

  it('converts explicitly or via Standard JSON Schema, and fails without conversion', () => {
    assert.equal(resolveJsonSchema(schema, jsonSchema), jsonSchema);
    assert.throws(() => resolveJsonSchema(schema), /require jsonSchema/);
    const converter = (options: { target: string }) => { assert.equal(options.target, 'draft-2020-12'); return jsonSchema; };
    const convertible = { '~standard': { ...schema['~standard'], jsonSchema: { input: converter, output: converter } } };
    assert.equal(resolveJsonSchema(convertible), jsonSchema);
    assert.equal(resolveJsonSchema(convertible, undefined, 'input'), jsonSchema);
    const broken = { '~standard': { ...schema['~standard'], jsonSchema: {
      input: converter, output: () => { throw new Error('unsupported transform'); } } } };
    assert.throws(() => resolveJsonSchema(broken), /unsupported transform/);
  });

  it('isolates model credentials and validates endpoints before resolving credentials', () => {
    assert.equal(resolveModel({ provider: 'openai', model: 'a', apiKey: ctx => ctx.key }, { key: 'primary' }, 'ai').apiKey, 'primary');
    assert.equal(resolveModel({ provider: 'anthropic', model: 'b', apiKey: 'secondary' }, {}, 'ai').apiKey, 'secondary');
    assert.throws(() => resolveModel({ provider: 'custom', model: 'a' }, {}, 'ai'), /baseUrl/);
    assert.throws(() => resolveModel({ provider: 'custom', model: 'a', baseUrl: 'file:///tmp/a' }, {}, 'ai'), /HTTP/);
    assert.throws(() => resolveModel({ provider: 'openai', model: '' }, {}, 'ai'), /empty/);
    assert.throws(() => resolveModel({ provider: 'openai', model: 'a', requestTimeoutMs: -1 }, {}, 'ai'), /positive/);
    networkPolicyStorage.run({ enabled: true, defaultPolicy: 'deny', allowedHosts: ['api.openai.com'],
      allowLocalhost: false, stepName: 'ai' }, () => {
      assert.equal(resolveModel({ provider: 'openai', model: 'a' }, {}, 'ai').baseUrl, 'https://api.openai.com/v1');
      let readKey = false;
      assert.throws(() => resolveModel({ provider: 'anthropic', model: 'b', apiKey: () => { readKey = true; return ''; } }, {}, 'ai'));
      assert.equal(readKey, false);
      assert.throws(() => resolveModel({ provider: 'ollama', model: 'a' }, {}, 'ai'));
    });
  });

  it('wraps all outputs consistently without allowing data keys to overwrite metrics', () => {
    for (const data of ['text', 1, null, [1], { aiMetrics: 'untrusted' }]) {
      const result = createAiResult(data, metrics);
      assert.equal(result.data, data);
      assert.equal(result.aiMetrics, metrics);
      assert.equal(result.$aiMetrics, metrics);
    }
  });

  it('falls back only for explicit transient failures, never cancellation', () => {
    for (const status of [429, 500, 503, 599]) assert.equal(shouldFallback(new AiProviderError('x', status)), true);
    for (const status of [400, 401, 403, 404, 600]) assert.equal(shouldFallback(new AiProviderError('x', status)), false);
    assert.equal(shouldFallback(new Error('invalid schema')), false);
    assert.equal(shouldFallback(new DOMException('aborted', 'AbortError')), false);
    assert.equal(shouldFallback(new AiRequestTimeoutError(10)), true);
    const controller = new AbortController(); controller.abort();
    assert.equal(shouldFallback(new AiRequestTimeoutError(10), controller.signal), false);
  });

  it('aborts provider transport on a request deadline even when the adapter hangs', async () => {
    let signal: AbortSignal | undefined;
    await assert.rejects(withAiRequest(s => { signal = s; return new Promise(() => {}); }, undefined, 10), AiRequestTimeoutError);
    assert.equal(signal?.aborted, true);
    assert.equal(await withAiRequest(async () => 42, undefined, 100), 42);
    await assert.rejects(withAiRequest(async () => 1, undefined, 0), /positive/);
    await assert.rejects(withAiRequest(async () => { throw new Error('provider error'); }), /provider error/);
  });

  it('propagates workflow cancellation and resolves callable Siglo signals', async () => {
    const controller = new AbortController();
    assert.equal(getExecutionSignal({ $signal: () => controller.signal }), controller.signal);
    assert.equal(getExecutionSignal({ signal: controller.signal }), controller.signal);
    const pending = withAiRequest(signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), controller.signal, 1000);
    const reason = new Error('flow cancelled'); controller.abort(reason);
    await assert.rejects(pending, err => err === reason);
    let called = false;
    await assert.rejects(withAiRequest(async () => { called = true; }, controller.signal), err => err === reason);
    assert.equal(called, false);
  });

  it('binds a real Siglo step deadline to the provider transport', async () => {
    let providerSignal: AbortSignal | undefined;
    const agent = Step.create('deadlineAgent', async (ctx: any) => {
      return withAiRequest(signal => {
        providerSignal = signal;
        return new Promise(() => {});
      }, getExecutionSignal(ctx), 1000);
    }).timeout(10);
    await assert.rejects(flow(agent).run({}));
    assert.equal(providerSignal?.aborted, true);
    assert.equal(shouldFallback(providerSignal?.reason, providerSignal), false);
  });

  it('validates tool declarations and arguments before executing side effects', async () => {
    const log: string[] = []; const tool = makeTool('tool', log);
    assert.equal(describeAiTools([tool])[0].parameters, jsonSchema);
    assert.throws(() => describeAiTools([tool, tool]), /Duplicate/);
    assert.throws(() => defineAiTool({ ...tool, name: 'bad name' }), /Invalid/);
    await assert.rejects(executeAiTool(tool, { n: 1 }, {}, {}), /stackId/);
    await assert.rejects(executeAiTool(tool, { n: 'bad' }, {}, { stackId: 'validation' }));
    assert.deepEqual(log, []);
  });

  for (const failInside of [true, false]) {
    it(`joins the parent saga and reverses tools on ${failInside ? 'inference' : 'downstream'} failure`, async () => {
      const log: string[] = [];
      const a = makeTool('a', log); const b = makeTool('b', log);
      const agent = Step.create('agent', async (ctx: any) => {
        const options = { stackId: ctx.$stackId(), signal: getExecutionSignal(ctx) };
        assert.deepEqual(await executeAiTool(a, { n: 1 }, ctx, options), { value: 1 });
        await executeAiTool(b, { n: 2 }, ctx, options);
        if (failInside) throw new Error('inference failed');
        return { answer: 'ok' };
      });
      const fail = Step.create('fail', () => { throw new Error('downstream failed'); });
      await assert.rejects(flow(agent, fail).run({}));
      assert.deepEqual(log, ['a', 'b', 'undo:b', 'undo:a']);
    });
  }

  it('runs tool lifecycle hooks and preserves the parent network perimeter', async () => {
    const log: string[] = [];
    const tool = makeTool('bounded', log);
    tool.step.onBefore(() => { log.push('before'); return true; });
    tool.step.onAfter(output => { log.push('after'); return output; });
    const agent = Step.create('agent', async (ctx: any) => {
      await executeAiTool(tool, { n: 3 }, ctx, { stackId: ctx.$stackId() });
      return { ok: true };
    });
    await flow(agent).run({});
    assert.deepEqual(log, ['before', 'bounded', 'after']);
    const rogue = defineAiTool({ ...tool, step: Step.create('rogue', () => {
      assertNetworkPolicy('rogue', 'https://blocked.example', 'blocked.example');
      return {};
    }).allowNetwork(['blocked.example']) });
    const blocked = Step.create('agent', async (ctx: any) => {
      await executeAiTool(rogue, { n: 1 }, ctx, { stackId: ctx.$stackId() });
      return {};
    });
    await assert.rejects(flow(blocked).networkPolicy({ allowedHosts: ['allowed.example'] }).run({}));
  });
});
