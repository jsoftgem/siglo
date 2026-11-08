import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';

const apiA = process.env.API_A_URL || 'http://api-a:3000';
const apiB = process.env.API_B_URL || 'http://api-b:3000';
const monitor = process.env.MONITOR_URL || 'http://monitor:4000';
const stateFile = '/tmp/siglo-durable-smoke.json';
const post = (url: string, body: object) =>
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

async function eventually(check: () => Promise<void>) {
    for (let attempt = 0; ; attempt++) {
        try {
            await check();
            return;
        } catch (error) {
            if (attempt === 49) throw error;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
}

async function main() {
    for (const api of [apiA, apiB]) {
        await eventually(async () => {
            assert.equal((await fetch(`${api}/health`)).status, 200);
        });
    }
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        if (process.argv[2] === 'submit') {
            const order = {
                orderId: `durable-${randomUUID().slice(0, 8)}`,
                sku: 'espresso-machine',
                quantity: 1,
                amountCents: 120000,
            };
            assert.equal((await post(`${apiA}/api/checkouts`, { ...order, quantity: 0 })).status, 400);
            const response = await post(`${apiA}/api/checkouts`, order);
            assert.equal(response.status, 202);
            const waiting = await response.json();
            assert.equal(waiting.status, 'waiting');
            assert.equal(waiting.correlationKey, `order:${order.orderId}`);
            assert.equal(response.headers.get('x-workflow-stack-id'), waiting.stackId);
            assert.equal((await post(`${apiB}/api/checkouts`, order)).status, 409);
            const record = await pool.query('SELECT status FROM siglo_wait_records WHERE stack_id = $1', [
                waiting.stackId,
            ]);
            assert.equal(record.rows[0].status, 'WAITING');
            const checkpoint = await pool.query('SELECT state FROM siglo_checkpoints WHERE stack_id = $1', [
                waiting.stackId,
            ]);
            assert.equal(checkpoint.rows[0].state.status, 'waiting');
            await eventually(async () => {
                const run = await fetch(`${monitor}/api/workflows/${waiting.stackId}`);
                assert.equal(run.status, 200);
                assert.ok(JSON.stringify(await run.json()).includes('flow:suspended'));
            });
            writeFileSync(stateFile, JSON.stringify({ order, stackId: waiting.stackId }));
            console.log(
                'Passed: validation, adapter 202, submission deduplication, persisted wait/checkpoint, monitoring.',
            );
            return;
        }
        assert.equal(process.argv[2], 'resume', 'Run smoke.ts with submit or resume');
        const { order, stackId } = JSON.parse(readFileSync(stateFile, 'utf8'));
        const route = `/api/webhooks/orders/${order.orderId}/approval`;
        assert.equal((await post(`${apiB}${route}`, { approved: 'false', approverId: 'tester' })).status, 400);
        const payload = { approved: true, approverId: 'smoke-test@shop.com' };
        const responses = await Promise.all([post(`${apiA}${route}`, payload), post(`${apiB}${route}`, payload)]);
        assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
        const body = await responses.find(r => r.status === 200)!.json();
        assert.equal(body.result.status, 'confirmed');
        assert.equal(body.result.trackingId, `tracking-${order.orderId}`);
        assert.equal(body.result.reservationId, `reservation-${order.orderId}`);
        assert.equal(body.result.paymentId, `payment-${order.orderId}`);
        assert.equal(body.result.approvedBy, payload.approverId);
        assert.equal((await post(`${apiB}${route}`, payload)).status, 409);
        const record = await pool.query('SELECT status, resumed_by FROM siglo_wait_records WHERE stack_id = $1', [
            stackId,
        ]);
        assert.equal(record.rows[0].status, 'RESUMED');
        assert.ok(record.rows[0].resumed_by);
        for (const api of [apiA, apiB]) {
            const checkpoint = await fetch(`${api}/api/checkouts/${stackId}`);
            assert.equal(checkpoint.status, 200);
            assert.equal((await checkpoint.json()).status, 'completed');
        }
        // The monitor has the same workflow definition and PostgreSQL storage.
        const interactiveOrder = { ...order, orderId: `${order.orderId}-dashboard` };
        const submitted = await post(`${apiA}/api/checkouts`, interactiveOrder);
        assert.equal(submitted.status, 202);
        const waiting = await submitted.json();
        const resumed = await post(`${monitor}/api/workflows/${waiting.stackId}/resume`, { payload });
        assert.equal(resumed.status, 200);
        const interactiveRecord = await pool.query('SELECT status FROM siglo_wait_records WHERE stack_id = $1', [
            waiting.stackId,
        ]);
        assert.equal(interactiveRecord.rows[0].status, 'RESUMED');
        await eventually(async () => {
            const run = await fetch(`${monitor}/api/workflows/${stackId}`);
            assert.ok(JSON.stringify(await run.json()).includes('flow:resumed'));
        });
        console.log(
            'Passed after both APIs restarted: concurrent cross-replica resume, restored provider IDs, duplicate protection, completed checkpoints, dashboard resume.',
        );
    } finally {
        await pool.end();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
