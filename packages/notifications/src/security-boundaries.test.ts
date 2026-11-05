import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { useStorage, DuplicateEventException, Step, flow, defaultDurableManager } from '@siglo/core';
import { InMemoryNotificationDispatchStore, PostgresNotificationDispatchStore, configureNotificationDispatchStore, getNotificationDispatchStore, PostgresApprovalRevocationStore, createNotificationHonoHandler, createNotificationExpressMiddleware, signActionToken, createSmsApprovalReference, PushWebhookTransport, SendGridTransport } from '../dist';
import { publicNotificationFetch, publicNotificationLookup, isPublicNotificationAddress } from '../dist/egress';
import dns from 'node:dns';
import https from 'node:https';
describe('notification boundary failures', () => {
  afterEach(() => { useStorage(undefined as any); });
  it('retains first-writer dispatch intents and retries intent preparation failures', async () => {
    const memory = new InMemoryNotificationDispatchStore(); configureNotificationDispatchStore(memory); assert.equal(getNotificationDispatchStore(), memory);
    await assert.rejects(memory.prepare('failed', async () => { throw new Error('prepare failed'); }));
    assert.equal((await memory.prepare('failed', async () => ({ message: { to: 'x', content: 'retry' } }))).message.content, 'retry');
    const rows = new Map<string, any>();
    const pg = new PostgresNotificationDispatchStore({ async query(sql, values) {
      if (sql.startsWith('CREATE')) return { rows: [] };
      const key = values![0];
      if (sql.startsWith('INSERT') && !rows.has(key)) rows.set(key, JSON.parse(values![1]));
      return { rows: rows.has(key) ? [{ intent: rows.get(key) }] : [] };
    } });
    await pg.initialize(); await pg.prepare('same', async () => ({ message: { to: 'x', content: 'first' } }));
    assert.equal((await pg.prepare('same', async () => { throw new Error('must reuse'); })).message.content, 'first');
  });
  it('releases PostgreSQL approval locks and denies conflicting direct clients', async () => {
    const log: string[] = []; const query = async (sql: string) => { log.push(sql); return { rows: sql.includes('pg_try') ? [{ locked: true }] : [] }; };
    const direct = new PostgresApprovalRevocationStore({ query });
    await direct.withApprovalLock('a', async () => {
      await assert.rejects(direct.withApprovalLock('b', async () => {}), DuplicateEventException);
      await direct.withApprovalLock('a', async () => { assert.equal(await direct.isRevoked('a'), false); });
    });
    assert.ok(log.some(sql => sql.includes('pg_advisory_unlock')));
    let released = 0;
    const pooled = new PostgresApprovalRevocationStore({ totalCount: 1, query, connect: async () => ({ query: async () => ({ rows: [{ locked: false }] }), release() { released++; } }) } as any);
    await assert.rejects(pooled.withApprovalLock('busy', async () => {}), DuplicateEventException); assert.equal(released, 1);
    const record = { stackId: 'stack' }; let cancelled = false;
    useStorage({ name: 'fake', getWaitRecord: async () => record, withWorkflowLock: async (_: any, fn: any) => fn(), cancelWaitRecord: async () => { cancelled = true; } } as any);
    await direct.revoke('pending'); assert.equal(cancelled, true);
  });
  it('discards pooled connections when unlocking fails and cancels recovery before writing revocation', async () => {
    for (const pooled of [false, true]) {
      let destroyed = false;
      const connection = { async query(sql: string) { if (sql.includes('pg_advisory_unlock')) throw new Error('connection lost'); return { rows: [{ locked: true }] }; }, release(error?: Error) { destroyed = !!error; } };
      const store = new PostgresApprovalRevocationStore(pooled ? { totalCount: 1, query: connection.query, connect: async () => connection } as any : connection);
      await assert.rejects(store.withApprovalLock('unlock-error', async () => {}), /connection lost/);
      assert.equal(destroyed, pooled);
    }
    let cancelled = false;
    useStorage({ name: 'fake', getWaitRecord: async () => ({ stackId: 's' }), withWorkflowLock: async (_: any, action: any) => action(), cancelWaitRecord: async () => { cancelled = true; } } as any);
    const store = new PostgresApprovalRevocationStore({ async query(sql: string) {
      if (sql.startsWith('INSERT')) { assert.equal(cancelled, true); throw new Error('revocation insert failed'); }
      return { rows: [{ locked: true }] };
    } });
    await assert.rejects(store.revoke('pending'), /insert failed/); assert.equal(cancelled, true);
  });
  it('returns the same validated DNS result to the socket and rejects mixed or missing results', async () => {
    const original = dns.lookup;
    async function resolve(addresses: any[], options: any = {}) {
      let calls = 0;
      dns.lookup = (_: any, __: any, cb: any) => { calls++; cb(null, addresses); };
      const result = await new Promise<any>((done, reject) => (publicNotificationLookup as any)('untrusted.example', options, (err: any, ...values: any[]) => err ? reject(err) : done(values)));
      assert.equal(calls, 1); return result;
    }
    try {
      const addresses = [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
      assert.deepEqual(await resolve(addresses, { all: true }), [addresses]);
      assert.deepEqual(await resolve(addresses, { family: 4 }), ['8.8.8.8', 4]);
      await assert.rejects(resolve([{ address: '8.8.8.8', family: 4 }], { family: 6 }), /requested family/);
      await assert.rejects(resolve([]), /public IP/);
      await assert.rejects(resolve([...addresses, { address: '127.0.0.1', family: 4 }]), /public IP/);
      dns.lookup = (_: any, __: any, cb: any) => cb(new Error('DNS failed'));
      await assert.rejects(new Promise((resolve, reject) => (publicNotificationLookup as any)('x', undefined, (err: any) => err ? reject(err) : resolve(null))), /DNS failed/);
    } finally { dns.lookup = original; }
    for (const address of ['invalid', '0.1.2.3', '224.1.1.1', '172.16.1.1', '192.0.2.1', '192.88.99.1', '198.51.100.1', '203.0.113.1', '2001:0db8::1', '2001:0::1', '3fff::1']) assert.equal(isPublicNotificationAddress(address), false, address);
    for (const address of ['100.128.1.1', '172.32.0.1', '192.88.98.1', '198.17.1.1', '203.0.114.1', '2001:4860::8888', '2000::1']) assert.equal(isPublicNotificationAddress(address), true, address);
  });
  it('pins native HTTPS requests and handles redirects, limits, timeout and empty responses', async () => {
    const original = https.request; let mode: any = 200; let captured: any;
    https.request = (_url: any, options: any, callback: any) => {
      captured = options; const req: any = new EventEmitter(); req.write = () => {}; req.destroy = (error: any) => req.emit('error', error);
      req.end = () => queueMicrotask(() => {
        if (mode === 'timeout') { req.emit('timeout'); return; }
        const res: any = new EventEmitter(); res.statusCode = mode === 'missing' ? undefined : mode === 'large' ? 200 : mode;
        res.headers = { 'x-test': ['one', 'two'], ignored: undefined, 'content-type': 'application/json' };
        res.destroy = (error?: any) => { res.destroyed = true; if (error) res.emit('error', error); };
        callback(res);
        if (mode === 302) return;
        res.emit('data', mode === 'large' ? Buffer.alloc(1024 * 1024 + 1) : Buffer.from('{"ok":true}'));
        if (!res.destroyed) res.emit('end');
      }); return req;
    };
    try {
      assert.equal((await publicNotificationFetch('https://public.example', { headers: { 'X-Key': 'value' }, body: '{}' })).status, 200);
      await new SendGridTransport({ apiKey: 'key' }).send({ to: 'a@example.com', content: 'hello' });
      assert.equal(captured.agent, false); assert.equal(captured.lookup, publicNotificationLookup);
      for (const status of [204, 205, 304]) {
        mode = status;
        if (status === 304) await assert.rejects(publicNotificationFetch('https://public.example'), /redirects/);
        else assert.equal((await publicNotificationFetch('https://public.example')).status, status);
      }
      mode = 302; await assert.rejects(publicNotificationFetch('https://public.example'), /redirects/);
      mode = 'large'; await assert.rejects(publicNotificationFetch('https://public.example'), /too large/);
      mode = 'timeout'; await assert.rejects(publicNotificationFetch('https://public.example'), /timed out/);
      mode = 'missing'; assert.equal((await publicNotificationFetch('https://public.example')).status, 500);
      await assert.rejects(publicNotificationFetch('http://public.example'), /HTTPS/);
      await assert.rejects(publicNotificationFetch('https://user:pass@public.example'), /credentials/);
    } finally { https.request = original; }
  });
  it('binds framework authorization to the request and rejects disallowed POST origins', async () => {
    const token = await signActionToken({ stackId: 's', correlationKey: randomUUID(), expectedEvent: 'DONE', approved: false, expiresAt: Date.now() + 60000 }, 'secret');
    const workflow = flow(new Step('noop', async () => ({})));
    let html = ''; let status = 0;
    const res: any = { setHeader() {}, status(n: number) { status = n; return this; }, type() { return this; }, send(s: string) { html = s; }, json() {} };
    await createNotificationExpressMiddleware({ workflow, signingSecret: 'secret' })({ method: 'GET', query: { token } }, res); assert.match(html, /Confirm rejection/);
    const request = { method: 'POST', body: { token }, headers: { origin: 'https://evil.example' } };
    await createNotificationExpressMiddleware({ workflow, signingSecret: 'secret', allowedOrigins: [] })(request, res); assert.equal(status, 403);
    request.headers.origin = 'https://app.example';
    await createNotificationExpressMiddleware({ workflow, signingSecret: 'secret', authorize: (_: any, req: any) => { assert.equal(req, request); return false; } })(request, res); assert.equal(status, 403);
    const c: any = { header() {}, req: { method: 'POST', header: (name: string) => name === 'content-type' ? 'application/json' : undefined, query() {}, json: async () => ({ token }) }, json: (_: any, code: number) => new Response(null, { status: code }) };
    assert.equal((await createNotificationHonoHandler({ workflow, signingSecret: 'secret', authorize: () => false })(c)).status, 403);
    assert.throws(() => createSmsApprovalReference('invalid prefix'));
    let sent: any;
    await new PushWebhookTransport({ url: 'https://push.example', fetch: (async (_: any, init: any) => { sent = init; return Response.json({ id: 'push-id' }); }) as typeof fetch }).send({ to: 'device', content: 'hello', idempotencyKey: 'stable-key' });
    assert.equal(sent.headers['Idempotency-Key'], 'stable-key');
  });
});
