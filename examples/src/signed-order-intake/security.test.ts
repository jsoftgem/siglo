import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app';
import {
    createRequestProtocol,
    digest,
    LocalNonceStore,
    signRequest,
    type ClientKey,
    type SignedRequest,
    windowSeconds,
} from './security';
import type { OrderEvent } from './workflow';

const keys = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const client: ClientKey = { publicKey: keys.publicKey, clientId: 'shop-demo', active: true };
const body = Buffer.from('{ "eventId":"event-1", "orderId":"order-1", "type":"order.placed", "amountCents":5000 }');
function signed(options: Partial<Parameters<typeof signRequest>[2]> = {}) {
    return signRequest(body, keys.privateKey, {
        nonce: randomUUID(),
        created: Math.floor(Date.now() / 1000),
        ...options,
    });
}
test('HTTP intake authenticates exact bytes before publishing and returns only a receipt', async () => {
    const events: OrderEvent[] = [];
    const registry = new Map([['shop-demo-key', { ...client }]]);
    const server = createApp(registry, async event => {
        events.push(event);
    }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    async function send(request: SignedRequest, extra: Record<string, string> = {}) {
        return fetch(url + request.target, {
            method: request.method,
            headers: { ...(request.headers as Record<string, string>), ...extra },
            body: request.rawBody,
        });
    }
    try {
        const request = signed();
        const accepted = await send(request, { 'x-namespace': 'attacker', 'x-durable': 'true' });
        assert.equal(accepted.status, 202, await accepted.clone().text());
        assert.deepEqual(await accepted.json(), { eventId: 'event-1', orderId: 'order-1', status: 'accepted' });
        assert.equal(events[0].tenant, 'shop-demo');
        assert.equal((await send(request)).status, 401);
        // Signing again with the same nonce also fails, even with a fresh signature.
        const nonce = /nonce="([^"]+)"/.exec(request.headers['signature-input'] as string)![1];
        assert.equal((await send(signed({ nonce, created: Math.floor(Date.now() / 1000) + 1 }))).status, 401);
        const tampered = signed();
        tampered.rawBody = Buffer.from(body.toString().replace('5000', '5001'));
        assert.equal((await send(tampered)).status, 401);
        tampered.headers['content-digest'] = digest(tampered.rawBody);
        assert.equal(
            (await send(tampered)).status,
            401,
            'replacing body and digest cannot bypass signature verification',
        );
        const reserialized = signed();
        reserialized.rawBody = Buffer.from(JSON.stringify(JSON.parse(body.toString())));
        assert.equal((await send(reserialized)).status, 401);
        const badSignature = signed();
        badSignature.headers.signature = 'sig1=:AAAA:';
        assert.equal((await send(badSignature)).status, 401);
        assert.equal(
            (await send(signed({ created: Math.floor(Date.now() / 1000) - (windowSeconds + 1) }))).status,
            401,
        );
        assert.equal(
            (await send(signed({ created: Math.floor(Date.now() / 1000) + (windowSeconds + 1) }))).status,
            401,
        );
        assert.equal((await send(signed({ keyId: 'unknown' }))).status, 401);
        const changedQuery = signed();
        changedQuery.target += '?amount=1';
        assert.equal((await send(changedQuery)).status, 401);
        const missing = signed();
        delete missing.headers['signature-input'];
        assert.equal((await send(missing)).status, 401);
        const malformed = signed();
        malformed.headers['signature-input'] += ';nonce="duplicate"';
        assert.equal((await send(malformed)).status, 401);
        registry.get('shop-demo-key')!.active = false;
        assert.equal((await send(signed())).status, 401);
        registry.get('shop-demo-key')!.active = true;
        const invalidBody = signRequest(Buffer.from('{'), keys.privateKey, {
            nonce: randomUUID(),
            created: Math.floor(Date.now() / 1000),
        });
        assert.equal((await send(invalidBody)).status, 400);
        const oversized = signed();
        oversized.rawBody = Buffer.alloc(65537, 'x');
        assert.equal((await send(oversized)).status, 413);
        assert.equal(events.length, 1, 'rejected requests must never publish');
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
test('nonce claim occurs after verification and covers future-dated acceptance; concurrent claims have one winner', async () => {
    let now = 1800000000000;
    const nonces = new LocalNonceStore(() => now);
    const request = signed({ created: now / 1000 + windowSeconds });
    const protocol = createRequestProtocol(request, client, nonces, () => now);
    const params = {
        secret: keys.publicKey,
        rawPayload: body,
        headers: request.headers,
        signatureHeader: request.headers.signature as string,
    };
    assert.equal(await protocol.verify({ ...params, signatureHeader: 'sig1=:AAAA:' }), false);
    assert.equal(await protocol.verify(params), true);
    now += (windowSeconds + 1) * 1000;
    assert.equal(await protocol.verify(params), false, 'future timestamp still valid but nonce remains consumed');
    const fresh = signed({ created: now / 1000 });
    const freshProtocol = createRequestProtocol(fresh, client, nonces, () => now);
    const results = await Promise.all(
        Array.from({ length: 5 }, () =>
            freshProtocol.verify({
                ...params,
                headers: fresh.headers,
                signatureHeader: fresh.headers.signature as string,
            }),
        ),
    );
    assert.equal(results.filter(Boolean).length, 1);
    const changedMethod = { ...fresh, method: 'PUT' };
    assert.equal(await createRequestProtocol(changedMethod, client, nonces, () => now).verify(params), false);
});
test('publication failure is not acknowledged and does not leak internal errors', async () => {
    const server = createApp(new Map([['shop-demo-key', client]]), async () => {
        throw new Error('private broker connection details');
    }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
        const request = signed();
        const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/orders`, {
            method: 'POST',
            headers: request.headers as Record<string, string>,
            body,
        });
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: 'Order intake failed' });
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
