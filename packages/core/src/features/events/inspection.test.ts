import { describe, it } from 'mocha';
import assert from 'node:assert/strict';
import { sanitizeInspection, recordInspection, observeEcosystem, stepInspectionStorage, EcosystemInspection } from './inspection';
import { WorkflowEventEmitter, emitMonitoringEvent } from './emitter';
import { redactEvent } from './redaction';

const base: EcosystemInspection = { version: 1, kind: 'http', outcome: 'success' };
describe('bounded ecosystem observation', () => {
  it('rejects invalid versions and types, strips content and credentials and marks bounded strings', () => {
    for (const value of [undefined, {}, { ...base, version: 2 }, { ...base, kind: 'unknown' }, { ...base, outcome: 'unknown' }]) assert.equal(sanitizeInspection(value), undefined);
    const valid: any = sanitizeInspection({ ...base, url: 'https://user:secret@example.test/path?secret=value', method: 'POST', status: 200, traceId: 'x'.repeat(1024), durationMs: 1, body: 'secret', headers: { cookie: 'secret' } });
    assert.equal(valid.url, 'https://example.test');
    assert.equal(valid.status, 200);
    assert.equal(valid.truncated, true);
    assert.equal(Buffer.byteLength(valid.traceId), 256);
    assert.equal('body' in valid, false);
    assert.equal('headers' in valid, false);
    assert.equal((sanitizeInspection({ ...base, url: 'broken', status: -1, method: 'injected' }) as any).status, undefined);
    assert.equal((sanitizeInspection({ ...base, url: 'javascript:alert(1)' }) as any).url, undefined);
    assert.equal((sanitizeInspection({ ...base, truncated: true }) as any).truncated, true);
    assert.equal((sanitizeInspection({ version: 1, kind: 'notification', outcome: 'success', approval: true }) as any).approval, true);
    assert.equal((sanitizeInspection({ version: 1, kind: 'crypto', outcome: 'failure', category: 'rejected' }) as any).category, 'rejected');
    assert.equal((sanitizeInspection({ version: 1, kind: 'ai', outcome: 'success', estimatedCostUsd: '0', model: 'fixture' }) as any).estimatedCostUsd, undefined);
    assert.equal((redactEvent({ type: 'step:inspection', inspection: { version: 9 }, rawBody: 'private' } as any) as any).inspection, undefined);
  });

  it('accepts only representable integer approval expiry timestamps', () => {
    const notification = { version: 1, kind: 'notification', outcome: 'success', approval: true };
    assert.equal((sanitizeInspection({ ...notification, approvalState: 'approved' }) as any).approvalState, 'approved');
    assert.equal((sanitizeInspection({ ...notification, approvalState: 'private-injected' }) as any).approvalState, undefined);
    assert.equal((sanitizeInspection({ ...notification, approvalExpiresAt: 1800000000000 }) as any).approvalExpiresAt, 1800000000000);
    for (const value of [-1, Infinity, NaN, 1.5, '1800000000000', 8640000000000001, { secret: 'private' }]) {
      assert.equal((sanitizeInspection({ ...notification, approvalExpiresAt: value }) as any).approvalExpiresAt, undefined);
    }
  });

  it('keeps observer and summary failures from changing action outcomes and suppresses ecosystem content', async () => {
    const events: any[] = [];
    const monitor = new WorkflowEventEmitter().on('*', e => { events.push(e); });
    monitor.on('*', async () => { throw new Error('observer failure'); });
    const scope = { stackId: 'stack', stepId: 'runtime-id', stepName: 'same', attempt: 2, monitor };
    recordInspection(base); // No runtime identity: no uncorrelated events.
    assert.equal(events.length, 0);
    await stepInspectionStorage.run(scope, async () => {
      assert.equal(await observeEcosystem(base, () => 42, () => ({ status: 200 })), 42);
      assert.equal(events[0].stepId, 'runtime-id');
      assert.equal(events[0].attempt, 2);
      assert.equal(await observeEcosystem(base, () => 7, () => { throw new Error('summary failure'); }), 7);
      const failure = new Error('private failure');
      await assert.rejects(observeEcosystem(base, () => { throw failure; }), error => error === failure);
      assert.equal(events.at(-1).inspection.outcome, 'failure');
      for (const event of [
        { type: 'step:complete', outputSummary: { data: 'private' } },
        { type: 'context:change', field: 'data', value: 'private' },
        { type: 'step:error', error: { message: 'private' } }
      ]) {
        const safe = redactEvent({ ...event, stackId: 'stack', stepId: 'runtime-id' } as any);
        assert.equal(JSON.stringify(safe).includes('private'), false);
      }
      recordInspection(new Proxy(base, { get() { throw new Error('unsafe observer input'); } }));
    });
    assert.equal(stepInspectionStorage.getStore(), undefined);
    const cyclic: any = {}; cyclic.self = cyclic;
    emitMonitoringEvent({ monitor }, new Proxy(cyclic, { ownKeys() { throw new Error('unserializable event'); } }));
  });
});
