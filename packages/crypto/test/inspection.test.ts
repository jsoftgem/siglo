import assert from 'node:assert/strict';
import { flow, WorkflowEventEmitter } from 'siglo';
import { verifyWebhookStep } from '../src';
import type { WebhookVerifyOptions } from '../src/types';

describe('safe webhook rejection inspection', () => {
  const secret = 'private-secret';
  const cases: Array<[string, Partial<WebhookVerifyOptions<any>>]> = [
    ['invalid-payload', { payload: () => ({ private: 'private-body' }) }],
    ['unknown-provider', { provider: 'private-unknown-provider' }],
    ['payload-too-large', { maxBodyBytes: 1 }],
    ['missing-secret', { secret: '' }],
    ['missing-signature', { signature: () => '' }],
    ['invalid-signature', {}],
    ['timestamp-rejected', { provider: 'stripe', signature: () => 't=1,v1=private-signature' }],
    ['replay-detected', { dedupStore: { claim: async () => false } }],
  ];
  for (const [category, overrides] of cases) {
    it(`reports ${category} without sensitive content`, async () => {
      const events: any[] = [];
      const monitor = new WorkflowEventEmitter().on('*', event => { events.push(event); });
      monitor.on('*', async () => { throw new Error('observer failure'); });
      const step = verifyWebhookStep('verify', {
        payload: () => 'private-body', secret, provider: 'generic-hmac',
        signature: () => 'private-signature', ...overrides,
      });
      await assert.rejects(() => flow(step).run({}, { monitor }));
      const inspections = events.filter(event => event.type === 'step:inspection');
      assert.equal(inspections.length, 1);
      const event = inspections[0];
      assert.equal(event.inspection.category, category);
      assert.equal(event.inspection.outcome, 'failure');
      assert.ok(event.stepId);
      assert.equal(event.attempt, 1);
      assert.equal(JSON.stringify(event).includes('private-'), false);
      if (category === 'timestamp-rejected') assert.equal(event.inspection.timestampCheck, 'failed');
      if (category === 'replay-detected') assert.equal(event.inspection.replayCheck, 'failed');
    });
  }
});
