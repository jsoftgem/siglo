import { strict as assert } from 'node:assert';
import { Step, flow, waitForEvent, InMemoryIdempotencyStore, networkPolicyStorage } from '@siglo/core';
import { StaticKeyRing } from '@siglo/crypto';
import { signActionToken, verifyActionToken, sendNotificationStep, sendInteractiveApprovalStep, handleNotificationCallback, renderNotificationHtml, SlackTransport, ResendTransport, SendGridTransport, DiscordTransport, TwilioTransport, SmtpTransport, configureApprovalRevocationStore, InMemoryApprovalRevocationStore, createNotificationExpressMiddleware, createNotificationFastifyHandler, createNotificationHonoHandler } from '../dist/index';
import { MockNotificationTransport } from '../dist/testing';
describe('notifications', () => {
  it('verifies rotated keys and rejects tampering, expiry, future timestamps and unknown keys', async () => {
    const ring = new StaticKeyRing('old', { old: 'secret' });
    const p = { stackId: 's', correlationKey: 'c', expectedEvent: 'APPROVED', approved: true, expiresAt: 2000 };
    const t = await signActionToken(p, ring, 1000);
    ring.addKey('new', 'new-secret', true);
    assert.equal((await verifyActionToken(t, ring, { now: 1500 })).correlationKey, 'c');
    for (const token of [t + 'x', 'invalid', `x.${t.split('.')[1]}`]) await assert.rejects(verifyActionToken(token, ring));
    await assert.rejects(verifyActionToken(t, ring, { now: 2000 }));
    await assert.rejects(verifyActionToken(t, ring, { now: 0 }));
    await assert.rejects(verifyActionToken(t, 'wrong', { now: 1500 }));
  });
  it('deduplicates dispatch and masks recipient metadata', async () => {
    const transport = new MockNotificationTransport();
    const step = sendNotificationStep('email', { channel: 'email', recipient: 'alice@example.com', template: 'Hello', transport, idempotencyStore: new InMemoryIdempotencyStore() });
    const first = await step.execute({}, { stackId: 'same' });
    const second = await step.execute({}, { stackId: 'same' });
    assert.equal(transport.messages.length, 1); assert.equal(first.notificationId, second.notificationId);
    assert.equal(first.$notificationMetadata.recipientMasked, 'a***');
    await step.execute({}, { stackId: 'different-workflow' });
    assert.equal(transport.messages.length, 2);
  });
  it('blocks disallowed transport hosts before dispatch', async () => {
    const transport = new MockNotificationTransport('email', ['api.resend.com']);
    await assert.rejects(networkPolicyStorage.run({ enabled: true, defaultPolicy: 'deny', allowedHosts: [] } as any, () => sendNotificationStep('blocked', { channel: 'email', recipient: 'a@b.com', template: 'hi', transport }).execute({}, { networkPolicy: { enabled: true, defaultPolicy: 'deny', allowedHosts: ['other.example.com'] } })));
    assert.equal(transport.messages.length, 0);
  });
  it('rejects malformed recipients and schema violations', async () => {
    const transport = new MockNotificationTransport();
    await assert.rejects(sendNotificationStep('invalid', { channel: 'email', recipient: 'bad', template: 'hello', transport }).execute({}));
    await assert.rejects(sendNotificationStep('schema', { channel: 'email', recipient: 'a@b.com', template: 'hello', transport, dataSchema: { '~standard': { version: 1, vendor: 'test', validate: () => ({ issues: [{ message: 'bad data' }] }) } } }).execute({}));
    assert.equal(transport.messages.length, 0);
  });
  it('dispatches approval links and atomically resolves concurrent callbacks', async () => {
    const transport = new MockNotificationTransport();
    const correlationKey = `approval-${Date.now()}`;
    let effects = 0;
    const workflow = flow(sendInteractiveApprovalStep('approval', { channel: 'email', recipient: 'a@b.com', title: 'Approve?', correlationKey, timeout: '2h', onApproveEvent: 'YES', onRejectEvent: 'NO', callbackBaseUrl: 'https://example.com/callback', signingSecret: 'secret', transport }), waitForEvent('YES', { correlationKey, timeout: '2h' }), new Step('effect', async () => { effects++; return {}; }));
    try { await workflow.execute({}, { durable: true }); } catch (e: any) { if (!/suspend/i.test(e.message)) throw e; }
    assert.equal(transport.messages.length, 1);
    const token = new URL(transport.messages[0].interactiveActions!.approveUrl).searchParams.get('token')!;
    const results = await Promise.all([handleNotificationCallback(token, { workflow, allowBearerApproval: true, signingSecret: 'secret' }), handleNotificationCallback(token, { workflow, allowBearerApproval: true, signingSecret: 'secret' })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal(effects, 1);
  });
  it('builds provider requests without network and escapes HTML', async () => {
    const calls: any[] = [];
    const request = (async (url: any, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true, channel: 'C123', ts: '123.4', id: 'id', sid: 'sid' }), { status: 200, headers: { 'x-message-id': 'sendgrid-id' } }); }) as typeof fetch;
    const options = { apiKey: 'secret', from: 'sender@example.com', fetch: request };
    const message = { to: 'a@b.com', content: '<script>', interactiveActions: { title: 'Approve', approveUrl: 'https://example.com/a', rejectUrl: 'https://example.com/r' } };
    assert.ok(renderNotificationHtml(message).includes('&lt;script&gt;'));
    for (const transport of [new ResendTransport(options), new SendGridTransport(options)]) assert.ok((await transport.send(message)).id);
    const slack = new SlackTransport(options); const sent = await slack.send({ ...message, to: 'C123' }); await slack.cancel(sent.id, 'Cancelled');
    await new DiscordTransport(request).send({ to: 'https://discord.com/api/webhooks/123/secret', content: 'Hello' });
    await new TwilioTransport({ accountSid: 'AC123', authToken: 'secret', from: '+123456789', fetch: request }).send({ to: '+123456789', content: 'Hello' });
    await new SmtpTransport({ host: 'smtp.example.com', from: 'a@b.com', sendMail: async mail => { assert.ok(mail.html); return { messageId: 'smtp-id' }; } }).send(message);
    assert.equal(calls.length, 6); assert.ok(calls.every(c => c.init.redirect === 'error'));
  });
  it('rejects revoked approvals and adapts errors and redirects across frameworks', async () => {
    const store = new InMemoryApprovalRevocationStore(); configureApprovalRevocationStore(store);
    const workflow = flow(new Step('noop', async () => ({})));
    const options = { workflow, allowBearerApproval: true, signingSecret: 'secret' };
    const token = await signActionToken({ stackId: 's', correlationKey: 'revoked', expectedEvent: 'DONE', approved: true, expiresAt: Date.now() + 60000 }, 'secret');
    await store.revoke('revoked');
    assert.equal((await handleNotificationCallback(token, options)).status, 409);
    const res: any = { setHeader() {}, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; }, redirect(code: number, url: string) { this.code = code; this.url = url; } };
    await createNotificationExpressMiddleware(options)({ method: 'POST', query: { token: 'invalid' } }, res);
    assert.equal(res.code, 400);
    await createNotificationExpressMiddleware({ ...options, onErrorRedirect: 'https://example.com/error' })({ method: 'POST', query: {} }, res);
    assert.equal(res.code, 303); assert.equal(res.url, 'https://example.com/error');
    const reply: any = { header() {}, code(status: number) { this.status = status; return this; }, send(body: any) { this.body = body; } };
    await createNotificationFastifyHandler(options)({ method: 'POST', query: {} }, reply); assert.equal(reply.status, 400);
    const response = await createNotificationHonoHandler(options)({ header() {}, req: { method: 'POST', parseBody: async () => ({}), header() {}, query: () => '' }, json: (body: any, status: number) => Response.json(body, { status }) });
    assert.equal(response.status, 400);
    const expired = await signActionToken({ stackId: 's', correlationKey: 'c', expectedEvent: 'DONE', approved: true, expiresAt: 100 }, 'secret', 0);
    assert.equal((await handleNotificationCallback(expired, options)).status, 410);
  });

});
