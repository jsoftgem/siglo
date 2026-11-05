import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Step, flow, waitForEvent, defaultDurableManager, InMemoryIdempotencyStore } from '@siglo/core';
import { signActionToken, createNotificationExpressMiddleware, createNotificationFastifyHandler, createNotificationHonoHandler, handleNotificationCallback, configureApprovalRevocationStore, InMemoryApprovalRevocationStore, sendInteractiveApprovalStep, ResendTransport, createSmsApprovalReference, validateSmsApprovalReply } from '../dist';
import { publicNotificationFetch, isPublicNotificationAddress } from '../dist/egress';

describe('notification security regressions', () => {
  beforeEach(() => configureApprovalRevocationStore(new InMemoryApprovalRevocationStore()));
  async function pending() {
    const key = randomUUID(); let effects = 0;
    const workflow = flow(waitForEvent('DONE', { correlationKey: key, timeout: '1h' }), new Step('effect', async () => { effects++; return {}; }));
    await workflow.execute({}, { durable: true });
    const record = defaultDurableManager.getWaiting(key)!;
    const token = await signActionToken({ stackId: record.stackId, correlationKey: key, expectedEvent: 'DONE', approved: true, expiresAt: Date.now() + 60000 }, 'secret');
    return { key, workflow, token, effects: () => effects };
  }
  for (const framework of ['express', 'fastify', 'hono']) {
    it(`${framework}: GET/HEAD/prefetch never mutate; only an explicit POST body can approve`, async () => {
      const p = await pending(); const options = { workflow: p.workflow, signingSecret: 'secret', allowBearerApproval: true, responseFormat: 'html' as const };
      async function invoke(method: string, body?: any) {
        let status = 0, html = '';
        const req = { method, query: { token: p.token }, body, headers: { purpose: 'prefetch' } };
        const reply: any = { setHeader() {}, header() {}, status(n: number) { status = n; return this; }, code(n: number) { status = n; return this; }, type() { return this; }, send(s: string) { html = s; }, json() {}, end() {} };
        if (framework === 'express') await createNotificationExpressMiddleware(options)(req, reply);
        else if (framework === 'fastify') await createNotificationFastifyHandler(options)(req, reply);
        else await createNotificationHonoHandler(options)({ header() {}, req: { method, header() {}, query: () => p.token, parseBody: async () => body }, html(s: string, n: number) { status = n; html = s; return new Response(s, { status: n }); }, json(_: any, n: number) { status = n; return new Response(null, { status: n }); }, body(_: any, n: number) { status = n; return new Response(null, { status: n }); } });
        return { status, html };
      }
      const preview = await invoke('GET'); assert.equal(preview.status, 200); assert.match(preview.html, /form method="post"/);
      await invoke('HEAD'); assert.equal(p.effects(), 0);
      assert.equal((await invoke('DELETE')).status, 405); assert.equal(p.effects(), 0);
      assert.equal((await invoke('POST', {})).status, 400); assert.equal(p.effects(), 0);
      assert.equal((await invoke('POST', { token: p.token })).status, 200); assert.equal(p.effects(), 1);
    });
  }
  it('requires authorization by default and checks identity before acceptance', async () => {
    const p = await pending(); const options = { workflow: p.workflow, signingSecret: 'secret' };
    assert.equal((await handleNotificationCallback(p.token, options)).status, 403);
    assert.equal((await handleNotificationCallback(p.token, { ...options, authorize: async () => false })).status, 403);
    assert.equal(p.effects(), 0);
    assert.equal((await handleNotificationCallback(p.token, { ...options, authorize: async payload => payload.correlationKey === p.key })).status, 200);
  });
  it('serializes revocation against acceptance and rejects revoked pending requests', async () => {
    const p = await pending(); const store = new InMemoryApprovalRevocationStore(); configureApprovalRevocationStore(store);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const cancellation = store.withApprovalLock(p.key, async () => { entered(); await gate; await store.revoke(p.key); });
    await ready;
    assert.equal((await handleNotificationCallback(p.token, { workflow: p.workflow, signingSecret: 'secret', allowBearerApproval: true })).status, 409);
    release(); await cancellation;
    assert.equal((await handleNotificationCallback(p.token, { workflow: p.workflow, signingSecret: 'secret', allowBearerApproval: true })).status, 409);
    assert.equal(p.effects(), 0);
  });
  it('reuses identical Resend payload and provider key after an ambiguous dispatch failure', async () => {
    const calls: any[] = []; let first = true;
    const transport = new ResendTransport({ apiKey: 'key', from: 'from@example.com', fetch: (async (_: any, init: any) => {
      calls.push(init); if (first) { first = false; throw new Error('ECONNRESET after ingestion'); } return Response.json({ id: 'provider-id' });
    }) as typeof fetch });
    const step = sendInteractiveApprovalStep('ambiguous-send', { channel: 'email', recipient: 'to@example.com', title: 'Approve?', correlationKey: randomUUID(), timeout: '1h', onApproveEvent: 'DONE', onRejectEvent: 'DONE', callbackBaseUrl: 'https://example.com/callback', signingSecret: 'secret', transport, idempotencyStore: new InMemoryIdempotencyStore() });
    const ctx = { $stackId: randomUUID() };
    await assert.rejects((step.action as any)(ctx));
    await (step.action as any)(ctx);
    assert.equal(calls.length, 2); assert.ok(calls[0].headers['Idempotency-Key']);
    assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']); assert.equal(calls[0].body, calls[1].body);
  });
  it('rejects private, mapped, metadata and reserved destination addresses', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '192.168.1.2', '198.18.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicNotificationAddress(ip), false, ip);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicNotificationAddress(ip), true, ip);
    await assert.rejects(publicNotificationFetch('https://127.0.0.1/'), /Private/);
    await assert.rejects(publicNotificationFetch('https://[::1]/'), /Private/);
    await assert.rejects(publicNotificationFetch('https://localhost/'), /public IP/);
  });
  it('generates 128-bit SMS challenges and binds replies to sender, destination and expiry', () => {
    const reference = createSmsApprovalReference('deploy:101'); assert.match(reference, /^deploy:101:[a-f0-9]{32}$/);
    const pending = { reference, from: '+15551234567', to: '+15557654321', expiresAt: 2000 };
    const reply = { ...pending, approved: true, messageId: 'SM123' };
    validateSmsApprovalReply(reply, pending, 1000);
    for (const change of [{ from: '+15550000000' }, { to: '+15550000000' }, { reference: 'deploy:101' }]) assert.throws(() => validateSmsApprovalReply({ ...reply, ...change }, pending, 1000));
    assert.throws(() => validateSmsApprovalReply(reply, pending, 2000));
  });
});
