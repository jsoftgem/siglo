import { strict as assert } from 'node:assert';
import { PostmarkTransport, PushWebhookTransport, SlackTransport, DiscordTransport, NotificationMonitor, sendNotificationStep } from '../dist';
import { MockNotificationTransport } from '../dist/testing';
describe('remaining notification features', () => {
  it('sends Postmark, push, Discord actions and Slack modals with provider contracts', async () => {
    const calls: any[] = [];
    const request = (async (url: any, init: any) => { calls.push({ url, ...init }); return Response.json({ id: 'id', MessageID: 'postmark', ok: true, view: { id: 'view-id' } }); }) as typeof fetch;
    const message = { to: 'a@example.com', subject: 'Subject', content: 'Hello', interactiveActions: { title: 'Approval', description: 'Review', approveUrl: 'https://example.com/a', rejectUrl: 'https://example.com/r' } };
    assert.equal((await new PostmarkTransport({ apiKey: 'key', from: 'b@example.com', fetch: request }).send(message)).id, 'postmark');
    assert.equal(calls[0].headers['X-Postmark-Server-Token'], 'key');
    await new PushWebhookTransport({ url: 'https://push.example.com/send', fetch: request }).send({ ...message, to: { pushToken: 'device' } });
    assert.equal(JSON.parse(calls[1].body).to, 'device');
    await new DiscordTransport(request).send({ ...message, to: 'https://discord.com/api/webhooks/123/key' });
    assert.ok(JSON.parse(calls[2].body).embeds[0].description.includes('[Approve]'));
    const slack = new SlackTransport({ apiKey: 'key', fetch: request });
    assert.equal(await slack.openModal('trigger', { title: 'Review', blocks: [] }), 'view-id');
    await assert.rejects(slack.openModal('', { title: 'Review', blocks: [] }));
    assert.throws(() => new PushWebhookTransport({ url: 'http://example.com' }));
    await assert.rejects(new PostmarkTransport({ apiKey: 'key', fetch: (async () => Response.json({ ErrorCode: 123 })) as typeof fetch }).send(message));
    await assert.rejects(new PushWebhookTransport({ url: 'https://example.com', fetch: (async () => Response.json({})) as typeof fetch }).send(message));
  });
  it('masks wildcard PII paths before listeners without changing workflow values', () => {
    const monitor = new NotificationMonitor(['outputSummary.customers.*.contact']); const seen: any[] = [];
    monitor.on('*', event => { seen.push(event); });
    const summary = { customers: [{ contact: 'private', name: 'Customer' }] };
    monitor.emit({ type: 'step:complete', stackId: 's', stepId: 'step', timestamp: 0, durationMs: 0, outputSummary: summary } as any);
    assert.equal(seen[0].outputSummary.customers[0].contact, '[REDACTED]');
    assert.equal(summary.customers[0].contact, 'private');
  });
  it('rejects schema inputs in validation and runs after telemetry only after dispatch', async () => {
    const transport = new MockNotificationTransport('push');
    const step = sendNotificationStep('push', { channel: 'push', recipient: { pushToken: 'device' }, template: 'Hello', transport });
    const result = await step.execute({}); assert.equal(result.$notificationMetadata.channel, 'push');
    await assert.rejects(sendNotificationStep('invalid', { channel: 'email', recipient: 'bad', template: 'Hello', transport }).execute({}), (error: any) => error.phase === 'validation');
  });
});
