import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { createMonitorServer } from './server';
import { appendInspection } from '../ui/src/hooks/inspectionUpdates';

async function connect(port: number, token?: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`);
    const received: any[] = [];
    socket.addEventListener('message', event => received.push(JSON.parse(String(event.data))));
    await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
    });
    const next = () =>
        new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.removeEventListener('message', listener);
                reject(new Error('Missing WebSocket event'));
            }, 1500);
            const listener = (event: MessageEvent) => {
                clearTimeout(timer);
                resolve(JSON.parse(String(event.data)));
            };
            socket.addEventListener('message', listener, { once: true });
        });
    return { socket, received, next };
}
const inspection = (stepId = 'runtime-a', attempt = 1) => ({
    type: 'step:inspection',
    stackId: 'live-run',
    stepId,
    stepName: 'same',
    attempt,
    timestamp: 100,
    inspection: {
        version: 1,
        kind: 'http',
        outcome: 'success',
        method: 'POST',
        url: 'https://user:private-password@example.test/private-path?token=private-query',
        traceId: 't'.repeat(512),
        headers: { authorization: 'private-header' },
        body: 'private-body',
    },
    callbackBaseUrl: 'https://private-callback',
    rawBody: 'private-raw',
});

describe('adversarial live inspection transport', () => {
    it('sanitizes WebSocket ingestion before persistence, API snapshots and live updates', async () => {
        const server = await createMonitorServer({ port: 0, host: '127.0.0.1' });
        const client = await connect(server.port);
        try {
            // Each invalid message precedes a valid barrier on the same ordered connection.
            for (const event of [
                { ...inspection(), inspection: { version: 999 } },
                { ...inspection(), attempt: 0 },
                { ...inspection(), attempt: 1.5 },
                { ...inspection(), stackId: '' },
                { ...inspection(), stepId: '' },
                { ...inspection(), timestamp: -1 },
                { ...inspection(), type: 'ai:complete' },
            ])
                client.socket.send(JSON.stringify({ action: 'event', event }));
            client.socket.send('null');
            client.socket.send('{malformed');
            const first = client.next();
            client.socket.send(JSON.stringify({ action: 'event', event: inspection() }));
            const delivered = await first;
            assert.equal(delivered.inspection.url, 'https://example.test');
            assert.equal(delivered.inspection.truncated, true);
            assert.equal(delivered.inspection.traceId.length, 256);
            assert.equal(JSON.stringify(delivered).includes('private-'), false);
            const second = client.next();
            client.socket.send(JSON.stringify({ action: 'event', event: inspection('runtime-b', 2) }));
            await second;
            assert.equal(client.received.length, 2);
            const response = await fetch(`http://127.0.0.1:${server.port}/api/workflows/live-run`);
            assert.equal(response.status, 200);
            const snapshot = (await response.json()) as any;
            assert.equal(JSON.stringify(snapshot).includes('private-'), false);
            const run = server.store.getRun('live-run')!;
            assert.equal(run.events.length, 2);
            assert.equal(run.steps['runtime-b'].inspections?.[0].attempt, 2);
            const updated = appendInspection({ stepId: 'runtime-a', status: 'RUNNING' }, delivered);
            assert.equal(updated.inspections?.length, 1);
            assert.equal(updated.status, 'RUNNING');
            assert.equal(appendInspection(updated, client.received[1]), updated);
        } finally {
            client.socket.close();
            await server.close();
        }
    });

    it('checks ingest/control authorization for each message after read authorization', async () => {
        const checks: string[] = [];
        let subscribed: (() => void) | undefined;
        const server = await createMonitorServer({
            port: 0,
            host: '127.0.0.1',
            auth: {
                validator: (token, scope) => {
                    checks.push(`${token}:${scope}`);
                    if (token === 'reader' && scope === 'read') subscribed?.();
                    return token === 'writer' || (token === 'reader' && scope === 'read');
                },
            },
        });
        const reader = await connect(server.port, 'reader');
        const writer = await connect(server.port, 'writer');
        try {
            reader.socket.send(
                JSON.stringify({ action: 'event', event: { ...inspection(), stackId: 'forbidden-run' } }),
            );
            reader.socket.send(JSON.stringify({ action: 'resume', stackId: 'forbidden-run' }));
            // A read subscription is a synchronous authorization barrier for this socket.
            const barrier = new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Subscription was not authorized')), 1500);
                subscribed = () => {
                    clearTimeout(timer);
                    resolve();
                };
            });
            reader.socket.send(JSON.stringify({ action: 'subscribe', namespace: 'test' }));
            await barrier;
            assert.ok(checks.includes('reader:ingest'));
            assert.ok(checks.includes('reader:control'));
            assert.equal(server.store.getRun('forbidden-run'), undefined);
            const next = writer.next();
            writer.socket.send(JSON.stringify({ action: 'event', event: inspection() }));
            await next;
            assert.ok(checks.includes('writer:ingest'));
            assert.ok(server.store.getRun('live-run'));
        } finally {
            reader.socket.close();
            writer.socket.close();
            await server.close();
        }
    });

    it('closes oversized frames before JSON ingestion and keeps other clients usable', async () => {
        const server = await createMonitorServer({ port: 0, host: '127.0.0.1', maxPayloadBytes: 1024 });
        const oversized = await connect(server.port);
        const healthy = await connect(server.port);
        try {
            const closed = new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Oversized socket remained open')), 1500);
                oversized.socket.addEventListener(
                    'close',
                    () => {
                        clearTimeout(timer);
                        resolve();
                    },
                    { once: true },
                );
            });
            oversized.socket.send('x'.repeat(2048));
            await closed;
            const next = healthy.next();
            healthy.socket.send(
                JSON.stringify({
                    action: 'event',
                    event: { ...inspection(), inspection: { version: 1, kind: 'http', outcome: 'success' } },
                }),
            );
            await next;
            assert.equal(server.store.getRun('live-run')!.events.length, 1);
        } finally {
            oversized.socket.close();
            healthy.socket.close();
            await server.close();
        }
    });
});
