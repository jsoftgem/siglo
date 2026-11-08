import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp, listenForRequests } from './app';

test('duplicate HTTP startup rejects instead of starting another consumer or dashboard', async () => {
    const app = createApp(new Map(), async () => {});
    const server = await listenForRequests(app, 0);
    try {
        await assert.rejects(listenForRequests(app, (server.address() as AddressInfo).port), { code: 'EADDRINUSE' });
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
test('requests are unavailable until the example has finished starting', async () => {
    let ready = false;
    const app = createApp(
        new Map(),
        async () => {},
        undefined,
        undefined,
        () => ready,
    );
    const server = await listenForRequests(app, 0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        assert.equal((await fetch(`${url}/health`)).status, 503);
        assert.equal((await fetch(`${url}/orders`, { method: 'POST' })).status, 503);
        ready = true;
        assert.equal((await fetch(`${url}/health`)).status, 200);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
