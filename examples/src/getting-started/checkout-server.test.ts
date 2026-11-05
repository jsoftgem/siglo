import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { startCheckoutServer } from './checkout-server';
import { sampleOrder } from './checkout-demo';

test('REST checkout reports successful, failed, and invalid requests to the right boundary', async () => {
    const { server, monitor, close } = await startCheckoutServer(0, 0);
    const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const telemetry = `http://127.0.0.1:${monitor.port}`;
    try {
        const success = await fetch(`${api}/api/checkouts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': 'request-1001' },
            body: JSON.stringify({ ...sampleOrder, token: 'do-not-record' })
        });
        assert.equal(success.status, 201);
        assert.equal(success.headers.get('x-correlation-id'), 'request-1001');
        const stackId = success.headers.get('x-workflow-stack-id');
        assert.ok(stackId);
        assert.deepEqual(await success.json(), {
            orderId: sampleOrder.orderId, status: 'confirmed', trackingId: 'tracking-order-1001'
        });
        const detail = await (await fetch(`${telemetry}/api/workflows/${stackId}`)).json();
        assert.equal(detail.status, 'COMPLETED');
        assert.equal(detail.namespace, 'checkout-demo');
        assert.ok(detail.events.some((event: { type: string }) => event.type === 'step:retry'));
        assert.ok(!JSON.stringify(detail).includes('do-not-record'));

        const failure = await fetch(`${api}/api/checkouts?failShipping=true`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...sampleOrder, orderId: 'order-failed' })
        });
        assert.equal(failure.status, 500);
        assert.deepEqual(await failure.json(), { error: 'Internal workflow execution error' });
        const runs = await (await fetch(`${telemetry}/api/workflows?namespace=checkout-demo`)).json();
        assert.equal(runs.length, 2);
        assert.equal(runs.filter((run: { status: string }) => run.status === 'FAILED').length, 1);

        const invalid = await fetch(`${api}/api/checkouts`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...sampleOrder, quantity: 0 })
        });
        assert.equal(invalid.status, 400);
        const afterInvalid = await (await fetch(`${telemetry}/api/workflows`)).json();
        assert.equal(afterInvalid.length, 2);
        assert.match(await (await fetch(`${telemetry}/metrics`)).text(), /siglo_step_retries_total 2/);
        const dashboard = await fetch(telemetry);
        assert.equal(dashboard.status, 200);
        assert.match(dashboard.headers.get('content-type') || '', /text\/html/);
    } finally {
        await close();
    }
});
