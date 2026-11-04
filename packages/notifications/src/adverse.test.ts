import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { flow, Step, defaultDurableManager, useStorage } from 'siglo';
import { sendNotificationStep, sendInteractiveApprovalStep, SlackTransport, ResendTransport, SendGridTransport, DiscordTransport, TwilioTransport, PushWebhookTransport, renderNotificationHtml, signActionToken, verifyActionToken, parseTwilioSmsReply, handleNotificationCallback } from '../dist';
import { MockNotificationTransport } from '../dist/testing';
describe('notification adverse cases and dynamic resolution', () => {
  it('supports dynamic inputs, all structured recipients, and validates before dispatch', async () => {
    const cases: any[] = [['email', { email: 'a@b.com' }], ['sms', { phone: '+123456789' }], ['slack', { slackUserId: 'U123' }], ['slack', { slackChannelId: 'C123' }], ['discord', { discordWebhookUrl: 'https://discord.com/api/webhooks/1/key' }]];
    for (const [channel, recipient] of cases) {
      const transport = new MockNotificationTransport(channel);
      await sendNotificationStep(`matrix-${channel}`, { channel: () => channel, recipient: () => recipient, template: () => 'Content', subject: () => 'Title', transport, data: () => ({}), dataSchema: { '~standard': { version: 1, vendor: 'test', validate: () => ({ value: {} }) } } }).execute({});
      assert.equal(transport.messages.length, 1);
    }
    await assert.rejects(sendNotificationStep('mismatch', { channel: 'email', recipient: 'a@b.com', template: 'Hi', transport: new MockNotificationTransport('slack') }).execute({}));
    await assert.rejects(sendInteractiveApprovalStep('bad-url', { channel: 'email', recipient: 'a@b.com', title: 'Hi', description: () => 'Details', correlationKey: 'key', timeout: '1h', onApproveEvent: 'YES', onRejectEvent: 'NO', callbackBaseUrl: 'http://example.com', signingSecret: 'secret', transport: new MockNotificationTransport() }).execute({}));
    assert.throws(() => sendInteractiveApprovalStep('bad-timeout', { timeout: 'invalid' } as any));
  });
  it('fails closed on provider HTTP errors, logical errors and invalid destinations', async () => {
    const failed = (async () => new Response('', { status: 503 })) as typeof fetch;
    const message = { to: 'a@b.com', content: 'Hi' };
    await assert.rejects(new ResendTransport({ apiKey: 'key', fetch: failed }).send(message));
    await assert.rejects(new SendGridTransport({ apiKey: 'key', fetch: failed }).send(message));
    const noId = (async () => new Response(null, { status: 202 })) as typeof fetch;
    assert.equal((await new SendGridTransport({ apiKey: 'key', fetch: noId }).send(message)).id, '');
    await assert.rejects(new SlackTransport({ apiKey: 'key', fetch: (async () => Response.json({ ok: false })) as typeof fetch }).send(message));
    await assert.rejects(new DiscordTransport(failed).send(message));
    await assert.rejects(new DiscordTransport(failed).send({ ...message, to: 'https://discord.com/wrong' }));
    await assert.rejects(new TwilioTransport({ accountSid: 'bad/path', authToken: 'key', from: '+123456789' }).send(message));
    await assert.rejects(new PushWebhookTransport({ url: 'https://example.com', fetch: (async () => new Response(null, { status: 204 })) as typeof fetch }).send(message));
    assert.ok(renderNotificationHtml({ ...message, interactiveActions: { title: 'Hi', approveUrl: 'https://example.com/a', rejectUrl: 'https://example.com/r' } }).includes('Approve'));
  });
  it('rejects empty keys, oversized tokens, malformed signed claims, and unknown rotated keys', async () => {
    const claims = { stackId: 's', correlationKey: 'c', expectedEvent: 'DONE', approved: true, expiresAt: Date.now() + 60000 };
    await assert.rejects(signActionToken(claims, ''));
    await assert.rejects(verifyActionToken('x'.repeat(17000), 'secret'));
    const token = await signActionToken(claims, 'secret');
    await assert.rejects(verifyActionToken(token, { getActiveKey: () => ({ kid: 'a', key: 'secret' }), getKey: () => null }));
    for (const changed of [{ stackId: '' }, { approved: 'yes' }, { expiresAt: 'never' }, { issuedAt: 'yesterday' }]) {
      const body = Buffer.from(JSON.stringify({ ...claims, issuedAt: Date.now(), nonce: 'nonce', ...changed })).toString('base64url');
      await assert.rejects(verifyActionToken(`${body}.${createHmac('sha256', 'secret').update(body).digest('base64url')}`, 'secret'));
    }
  });
  it('rejects malformed SMS configurations, identities, forms, and unsupported replies', () => {
    const publicUrl = 'https://example.com/sms', authToken = 'secret';
    function parse(params: any) {
      const signature = createHmac('sha1', authToken).update(publicUrl + Object.keys(params).sort().map(key => key + params[key]).join('')).digest('base64');
      return parseTwilioSmsReply(params, { publicUrl, authToken, signature });
    }
    assert.throws(() => parseTwilioSmsReply({}, { publicUrl, authToken: '', signature: '' }));
    assert.throws(() => parse({ Unexpected: 123 }));
    const valid = { MessageSid: 'SM123', From: '+123456789', To: '+198765432', Body: 'REJECT ref' };
    assert.equal(parse(valid).approved, false);
    for (const field of ['MessageSid', 'From', 'To', 'Body']) { const params = { ...valid } as any; delete params[field]; assert.throws(() => parse(params)); }
    assert.throws(() => parse({ ...valid, Body: 'MAYBE ref' }));
  });
  it('rejects wrong workflow identity and reports infrastructure failures as server errors', async () => {
    const workflow = flow(new Step('noop', async () => ({})));
    defaultDurableManager.registerWait({ stackId: 'actual', correlationKey: 'wrong-stack', eventName: 'DONE', status: 'waiting', continuationStepIndex: 0, stepId: 'wait', createdAt: Date.now() });
    const token = await signActionToken({ stackId: 'other', correlationKey: 'wrong-stack', expectedEvent: 'DONE', approved: true, expiresAt: Date.now() + 60000 }, 'secret');
    assert.equal((await handleNotificationCallback(token, { workflow, allowBearerApproval: true, signingSecret: 'secret' })).status, 400);
    useStorage({ name: 'no-waits', getWaitRecord: async () => ({ stackId: 'actual' }) } as any);
    try { assert.equal((await handleNotificationCallback(token, { workflow, allowBearerApproval: true, signingSecret: 'secret' })).status, 400); } finally { useStorage(undefined as any); }
    useStorage({ name: 'failed', getWaitRecord: async () => { throw new Error('Database unavailable'); } } as any);
    try { assert.equal((await handleNotificationCallback(token, { workflow, allowBearerApproval: true, signingSecret: 'secret' })).status, 500); } finally { useStorage(undefined as any); }
  });
});

describe('notification compatibility boundaries', () => {
  it('supports raw action invocation, explicit scope, and optional approval descriptions', async () => {
    const transport = new MockNotificationTransport();
    const step = sendNotificationStep('raw', { channel: 'email', recipient: 'a@b.com', template: 'Hi', transport });
    for (const ctx of [undefined, {}, { $stackId: 'explicit' }, { stackId: 'legacy' }, { $stackId: () => 'getter', $signal: new AbortController().signal }, { $signal: () => new AbortController().signal }]) {
      assert.ok((await (step.action as any)(ctx)).notificationId);
      assert.ok((step as any).idempotencyKey(ctx));
    }
    const approval = sendInteractiveApprovalStep('rawApproval', { channel: 'email', recipient: 'a@b.com', title: 'Hi', description: 'Details', correlationKey: 'raw', timeout: '1h', onApproveEvent: 'YES', onRejectEvent: 'NO', callbackBaseUrl: 'http://localhost/callback', signingSecret: 'key', transport });
    for (const ctx of [{}, { $stackId: 'explicit' }, { stackId: 'legacy' }]) assert.ok((await (approval.action as any)(ctx)).approvalTokens.approveUrl);
  });
  it('uses explicitly injected fetch without network', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ id: 'id', sid: 'sid', ok: true, channel: 'C123', ts: '1', MessageID: 'postmark' })) as typeof fetch;
    try {
      const email = { to: { email: 'a@b.com' }, content: 'Hi' };
      await new ResendTransport({ apiKey: 'key', fetch: globalThis.fetch }).send(email);
      await new SendGridTransport({ apiKey: 'key', fetch: globalThis.fetch }).send(email);
      await new SlackTransport({ apiKey: 'key', fetch: globalThis.fetch }).send({ to: { slackChannelId: 'C123' }, content: 'Hi' });
      await new SlackTransport({ apiKey: 'key', fetch: globalThis.fetch }).send({ to: { slackUserId: 'U123' }, content: 'Hi' });
      await new TwilioTransport({ accountSid: 'AC123', authToken: 'key', fetch: globalThis.fetch, from: '+123456789' }).send({ to: { phone: '+123456789' }, content: 'Hi' });
      await new DiscordTransport(globalThis.fetch).send({ to: { discordWebhookUrl: 'https://discord.com/api/webhooks/1/key' }, content: 'Hi', interactiveActions: { title: 'Hi', approveUrl: 'https://example.com/a', rejectUrl: 'https://example.com/r' } });
      await new PushWebhookTransport({ url: 'https://push.example.com', fetch: globalThis.fetch }).send({ to: 'device', content: 'Hi' });
      const { PostmarkTransport } = await import('../dist');
      await new PostmarkTransport({ apiKey: 'key', fetch: globalThis.fetch }).send(email);
    } finally { globalThis.fetch = original; }
  });
  it('rejects an expired durable record even when the signed token is still valid', async () => {
    defaultDurableManager.registerWait({ stackId: 'expired-record', correlationKey: 'expired-record', eventName: 'DONE', status: 'waiting', continuationStepIndex: 0, stepId: 'wait', createdAt: 1, expiresAt: 2 });
    const token = await signActionToken({ stackId: 'expired-record', correlationKey: 'expired-record', expectedEvent: 'DONE', approved: true, expiresAt: Date.now() + 60000 }, 'secret');
    assert.equal((await handleNotificationCallback(token, { workflow: flow(new Step('noop', async () => ({}))), allowBearerApproval: true, signingSecret: 'secret' })).status, 410);
  });
});
