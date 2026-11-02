import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { createOrderApiApp, orderFulfillmentFlow } from './index';

test('Express Workflow Execution API Suite', async (t) => {
    const app = createOrderApiApp(orderFulfillmentFlow);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    t.after(() => {
        server.close();
    });

    await t.test('GET /health returns ok', async () => {
        const res = await fetch(`${baseUrl}/health`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as any;
        assert.equal(body.status, 'ok');
    });

    await t.test('POST /api/orders executes workflow and returns 201 with stack ID', async () => {
        const res = await fetch(`${baseUrl}/api/orders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Correlation-Id': 'corr-express-test-101',
                'X-Namespace': 'test-namespace'
            },
            body: JSON.stringify({
                orderId: 'ORD-TEST-001',
                customerId: 'cust_unit_test',
                amount: 250,
                authToken: 'secret-auth-token',
                cardNumber: '4111-2222-3333-4444',
                isVip: false
            })
        });

        assert.equal(res.status, 201);
        assert.equal(res.headers.get('x-correlation-id'), 'corr-express-test-101');
        assert.ok(res.headers.get('x-workflow-stack-id'));

        const data = (await res.json()) as any;
        assert.equal(data.success, true);
        assert.equal(data.orderId, 'ORD-TEST-001');
        assert.equal(data.fulfillmentStatus, 'DISPATCHED');
        assert.ok(data.trackingNumber.startsWith('TRK-USPS-'));
        assert.equal(data.customerTier, 'STANDARD');
        assert.equal(data.discountApplied, false);
    });

    await t.test('POST /api/orders with VIP discount applies discount', async () => {
        const res = await fetch(`${baseUrl}/api/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                orderId: 'ORD-VIP-002',
                customerId: 'cust_vip',
                amount: 500,
                authToken: 'vip-token',
                cardNumber: '5500-1111-2222-3333',
                isVip: true
            })
        });

        assert.equal(res.status, 201);
        const data = (await res.json()) as any;
        assert.equal(data.success, true);
        assert.equal(data.customerTier, 'VIP_PLATINUM');
        assert.equal(data.discountApplied, true);
        assert.equal(data.discountAmount, 100);
        assert.equal(data.netCharged, 400);
    });

    await t.test('POST /api/orders with X-Durable: true suspends and can be resumed via /approve using orderId', async () => {
        const orderId = 'ORD-DURABLE-003';
        const res = await fetch(`${baseUrl}/api/orders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Durable': 'true'
            },
            body: JSON.stringify({
                orderId,
                customerId: 'cust_durable',
                amount: 300,
                authToken: 'token-secret',
                cardNumber: '4000-0000-0000-0000',
                isVip: false
            })
        });

        assert.equal(res.status, 202);
        const data = (await res.json()) as any;
        assert.equal(data.status, 'SUSPENDED');
        assert.equal(data.correlationKey, orderId);
        assert.equal(data.waitingForEvent, 'order.approved');
        assert.ok(data.stackId);

        // Resume / approve via Express API using :orderId route parameter directly (no stackId in body)
        const approveRes = await fetch(`${baseUrl}/api/orders/${orderId}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                approvedBy: 'compliance-auditor@corp.internal',
                decisionNotes: 'Approved via unit test'
            })
        });

        assert.equal(approveRes.status, 200);
        const approveData = (await approveRes.json()) as any;
        assert.equal(approveData.success, true);
        assert.equal(approveData.fulfillmentStatus, 'DISPATCHED');
        assert.ok(approveData.trackingNumber.startsWith('TRK-USPS-'));
    });

    await t.test('POST /api/orders with X-Durable: true can also be resumed using stackId in body', async () => {
        const orderId = 'ORD-DURABLE-004';
        const res = await fetch(`${baseUrl}/api/orders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Durable': 'true'
            },
            body: JSON.stringify({
                orderId,
                customerId: 'cust_durable_2',
                amount: 450,
                authToken: 'token-secret-2',
                cardNumber: '4000-0000-0000-0001',
                isVip: false
            })
        });

        assert.equal(res.status, 202);
        const data = (await res.json()) as any;
        assert.equal(data.status, 'SUSPENDED');
        assert.ok(data.stackId);

        // Resume / approve via Express API passing stackId
        const approveRes = await fetch(`${baseUrl}/api/orders/${orderId}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                stackId: data.stackId,
                approvedBy: 'compliance-auditor@corp.internal'
            })
        });

        assert.equal(approveRes.status, 200);
        const approveData = (await approveRes.json()) as any;
        assert.equal(approveData.success, true);
        assert.equal(approveData.fulfillmentStatus, 'DISPATCHED');
    });

    await t.test('POST /api/orders/:orderId/approve returns 400 when attempting duplicate resumption', async () => {
        // Attempting to resume ORD-DURABLE-004 a second time
        const res = await fetch(`${baseUrl}/api/orders/ORD-DURABLE-004/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approvedBy: 'tester' })
        });

        assert.equal(res.status, 400);
        const data = (await res.json()) as any;
        assert.ok(data.error.includes('is not waiting or has already been resumed'));
    });
});
