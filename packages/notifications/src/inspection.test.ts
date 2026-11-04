import assert from 'node:assert/strict';
import { flow, WorkflowEventEmitter } from 'siglo';
import { sendNotificationStep } from './steps';
import { MockNotificationTransport } from './testing';

describe('notification pre-action inspection', () => {
  for (const scenario of ['recipient', 'schema', 'resolver', 'transport'] as const) {
    it(`reports ${scenario} failure without sensitive content or dispatch`, async () => {
      const events: any[] = [];
      const monitor = new WorkflowEventEmitter().on('*', event => { events.push(event); });
      monitor.on('*', async () => { throw new Error('observer failed'); });
      const transport = new MockNotificationTransport();
      let calls = 0;
      const step = sendNotificationStep('notify', {
        channel: 'email', template: 'private-message', transport,
        recipient: () => {
          calls++;
          if (scenario === 'resolver') throw new Error('private-resolver-error');
          return scenario === 'recipient' ? 'private-invalid' : 'private-person@example.com';
        },
        ...(scenario === 'schema' ? { dataSchema: { '~standard': {
          version: 1 as const, vendor: 'test',
          validate: () => ({ issues: [{ message: 'private-schema-error' }] }),
        } } } : {}),
      });
      if (scenario === 'transport') Object.defineProperty(transport, 'allowedHosts', {
        get() { throw new Error('private-transport-error'); },
      });
      await assert.rejects(() => flow(step).run({}, { monitor }));
      const inspections = events.filter(event => event.type === 'step:inspection');
      assert.equal(inspections.length, 1);
      assert.equal(inspections[0].inspection.outcome, 'failure');
      assert.equal(inspections[0].inspection.kind, 'notification');
      assert.equal(inspections[0].inspection.channel, 'email');
      assert.equal(inspections[0].inspection.tokenStatus, 'unavailable');
      assert.equal(inspections[0].attempt, 1);
      assert.ok(inspections[0].stepId);
      assert.equal(JSON.stringify(inspections).includes('private-'), false);
      assert.equal(transport.messages.length, 0);
      assert.equal(calls, 1);
    });
  }
});

describe('approval expiry inspection', () => {
  it('reports the persisted signed expiry on delivery without callback credentials', async () => {
    const { sendInteractiveApprovalStep } = await import('./steps');
    const { WorkflowExecutionStore } = await import('../../monitor/src/store');
    const store = new WorkflowExecutionStore();
    const events: any[] = [];
    const monitor = new WorkflowEventEmitter().on('*', event => { events.push(event); store.addEvent(event); });
    const transport = new MockNotificationTransport();
    const { InMemoryNotificationDispatchStore } = await import('./dispatch');
    const dispatchStore = new InMemoryNotificationDispatchStore();
    const before = Date.now();
    await flow(sendInteractiveApprovalStep('approve', {
      channel: 'email', recipient: 'private@example.com', title: 'private-message',
      correlationKey: 'private-correlation', timeout: '2h', onApproveEvent: 'YES', onRejectEvent: 'NO',
      callbackBaseUrl: 'https://example.com/private-callback', signingSecret: 'private-secret',
      transport, dispatchStore,
    })).run({}, { monitor });
    const token = new URL(transport.messages[0].interactiveActions!.approveUrl).searchParams.get('token')!;
    const { verifyActionToken } = await import('./tokens');
    const payload = await verifyActionToken(token, 'private-secret');
    const inspections = events.filter(event => event.type === 'step:inspection');
    assert.equal(inspections.length, 1);
    assert.equal(inspections[0].inspection.approvalExpiresAt, payload.expiresAt);
    assert.ok(payload.expiresAt >= before + 7200000);
    assert.equal(inspections[0].inspection.tokenStatus, 'issued');
    assert.equal(JSON.stringify(inspections).includes('private'), false);
    const records = store.listRuns().flatMap(run => Object.values(run.steps));
    assert.equal(records.find(step => step.inspections?.length)?.inspections?.[0].data.kind, 'notification');
    assert.ok(JSON.stringify(records.map(step => step.inspections)).includes(String(payload.expiresAt)));
  });
});

describe('correlated approval callback inspection', () => {
  for (const approved of [true, false]) {
    it(`records ${approved ? 'approval' : 'rejection'} against the dispatch step`, async () => {
      const { waitForEvent, Step } = await import('siglo');
      const { sendInteractiveApprovalStep } = await import('./steps');
      const { handleNotificationCallback } = await import('./callbacks');
      const transport = new MockNotificationTransport();
      const events: any[] = [];
      const monitor = new WorkflowEventEmitter().on('*', event => { events.push(event); });
      monitor.on('*', async () => { throw new Error('observer failed'); });
      const correlationKey = `private-callback-${approved}-${Date.now()}`;
      let effects = 0;
      const workflow = flow(sendInteractiveApprovalStep('approval', {
        channel: 'email', recipient: 'private@example.com', title: 'private-title', correlationKey,
        timeout: '2h', onApproveEvent: 'YES', onRejectEvent: 'NO',
        callbackBaseUrl: 'https://example.com/private', signingSecret: 'private-secret', transport,
      }), waitForEvent(approved ? 'YES' : 'NO', { correlationKey, timeout: '2h' }),
      new Step('effect', () => { effects++; return {}; }));
      try { await workflow.execute({}, { durable: true, monitor }); }
      catch (error: any) { if (!/suspend/i.test(error.message)) throw error; }
      const actions = transport.messages[0].interactiveActions!;
      const token = new URL(approved ? actions.approveUrl : actions.rejectUrl).searchParams.get('token')!;
      const options = { workflow, monitor, signingSecret: 'private-secret' };
      const inspect = () => events.filter(event => event.type === 'step:inspection');
      assert.equal(inspect()[0].inspection.approvalState, 'requested');
      const count = inspect().length;
      assert.equal((await handleNotificationCallback(token + 'x', options)).status, 400);
      assert.equal(inspect().length, count); // Unverified claims cannot select a run.
      assert.equal((await handleNotificationCallback(token, options)).status, 403);
      assert.equal(inspect().at(-1).inspection.approvalState, 'forbidden');
      assert.equal(effects, 0);
      assert.equal((await handleNotificationCallback(token, { ...options, allowBearerApproval: true })).status, 200);
      assert.equal(effects, 1);
      const callback = inspect().at(-1);
      assert.equal(callback.inspection.approvalState, approved ? 'approved' : 'rejected');
      assert.equal(callback.stepId, inspect()[0].stepId);
      assert.equal(callback.stackId, inspect()[0].stackId);
      assert.equal(callback.attempt, inspect()[0].attempt);
      assert.equal(JSON.stringify(inspect()).includes('private'), false);
    });
  }
});
