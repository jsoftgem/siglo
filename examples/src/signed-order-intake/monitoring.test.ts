import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createKafkaMessageHandler } from '@siglo/kafka';
import { createApp } from './app';
import { createRoutingWorkflow } from './routing';
import { startLiveMonitor } from './monitoring';
import { signRequest } from './security';

test('live dashboard shows intake, nested routing, and rejection without signed request material', async () => {
    const monitor = await startLiveMonitor(0);
    const monitorUrl = `http://127.0.0.1:${(monitor.server.address() as AddressInfo).port}`;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const handler = createKafkaMessageHandler(createRoutingWorkflow(() => {}).monitor(monitor.emitter), {
        input: message => JSON.parse(String(message.value)),
    });
    let publications = 0;
    const server = createApp(
        new Map([['shop-demo-key', { publicKey, clientId: 'shop-demo', active: true }]]),
        async event => {
            publications++;
            await handler({
                topic: 'signed-order-intake.orders',
                partition: 0,
                message: { offset: String(publications), value: Buffer.from(JSON.stringify(event)) },
            });
        },
        undefined,
        monitor.emitter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/orders`;
        const rawBody = Buffer.from(
            JSON.stringify({
                eventId: 'monitor-event',
                orderId: 'monitor-order',
                type: 'order.placed',
                amountCents: 5000,
                giftWrap: true,
                privateNote: 'never-capture-this-body-marker',
            }),
        );
        const nonce = randomUUID();
        const request = signRequest(rawBody, privateKey, { nonce, created: Math.floor(Date.now() / 1000) });
        const send = () =>
            fetch(url, { method: 'POST', headers: request.headers as Record<string, string>, body: rawBody });
        assert.equal((await send()).status, 202);
        assert.equal((await send()).status, 401);
        assert.equal(publications, 1);
        const response = await fetch(`${monitorUrl}/api/workflows`);
        assert.equal(response.status, 200);
        const runs = (await response.json()) as any[];
        const steps = runs.flatMap(run => Object.values(run.steps) as any[]);
        for (const name of ['verifyOrderSignature', 'validateOrder', 'publishOrder', 'wrapGift', 'shipOrder']) {
            assert.ok(
                steps.some(step => step.stepName === name),
                `missing monitored step ${name}`,
            );
        }
        assert.ok(runs.some(run => run.status === 'FAILED'));
        assert.ok(
            runs.some(run => run.ast),
            'graph definition is available',
        );
        const serialized = JSON.stringify(runs);
        for (const sensitive of [
            nonce,
            privateKey,
            publicKey,
            request.headers.signature as string,
            request.headers['signature-input'] as string,
            'never-capture-this-body-marker',
        ]) {
            assert.ok(!serialized.includes(sensitive), 'signed request material must not be captured');
        }
        const dashboard = await fetch(monitorUrl);
        assert.equal(dashboard.status, 200);
        assert.match(await dashboard.text(), /<html/i);
        assert.equal((await fetch(`${monitorUrl}/api/workflows/unused/resume`, { method: 'POST' })).status, 403);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
        await monitor.close();
    }
});
