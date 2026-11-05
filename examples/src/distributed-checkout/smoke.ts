import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { redisUrl } from './infrastructure';

const apiA = process.env.API_A_URL || 'http://127.0.0.1:3000';
const apiB = process.env.API_B_URL || 'http://127.0.0.1:3001';
const monitor = process.env.MONITOR_URL || 'http://127.0.0.1:4000';
const suffix = randomUUID().slice(0, 8);
const order = { orderId: `smoke-${suffix}`, sku: `coffee-${suffix}`, quantity: 1, amountCents: 4500 };
const post = (base: string, body: object, query = '') => fetch(`${base}/api/checkouts${query}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

async function main() {
    const invalid = await post(apiA, { ...order, quantity: 0 });
    assert.equal(invalid.status, 400);
    // A cold catalog lookup pauses long enough for the second replica to race.
    const responses = await Promise.all([post(apiA, order), post(apiB, order)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    const created = responses.find(r => r.status === 201)!;
    const body = await created.json();
    assert.equal(body.trackingId, `tracking-${order.orderId}`);
    const replay = await post(apiB, order);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
    assert.deepEqual(await replay.json(), body);
    assert.equal((await post(apiA, { ...order, amountCents: 1 })).status, 409);
    for (const base of [apiA, apiB]) {
        const checkpoint = await fetch(`${base}/api/checkouts/${body.stackId}`);
        assert.equal(checkpoint.status, 200);
        assert.equal((await checkpoint.json()).status, 'completed');
    }
    // A different order uses the same SKU and therefore the shared cached step.
    assert.equal((await post(apiB, { ...order, orderId: `${order.orderId}-cached` })).status, 201);
    const failed = await post(apiA, { ...order, orderId: `${order.orderId}-failed` }, '?failShipping=true');
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: 'Internal workflow execution error' });

    const redis = new Redis(redisUrl);
    try {
        const keys = await redis.keys(`tutorial:cache:*${order.sku}*`);
        assert.equal(keys.length, 1, 'Redis contains the shared catalog entry');
        assert.ok(await redis.pttl(keys[0]) > 0);
    } finally { redis.disconnect(); }
    const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://siglo:siglo@127.0.0.1:5433/checkout' });
    try {
        const result = await pool.query('SELECT state FROM siglo_checkpoints WHERE stack_id = $1', [body.stackId]);
        assert.equal(result.rows[0].state.status, 'completed');
    } finally { await pool.end(); }
    // Publication is asynchronous; wait briefly for the monitor's HTTP view.
    let observed = false;
    for (let attempt = 0; attempt < 30; attempt++) {
        const detail = await fetch(`${monitor}/api/workflows/${body.stackId}`);
        if (detail.ok) {
            const run = await detail.json();
            assert.ok(JSON.stringify(run).includes('step:retry'));
            observed = true;
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(observed, 'Central monitor received the execution');
    console.log('Passed: validation, concurrent claim, cross-replica replay, payload conflict, checkpoints, Redis cache, failure, live monitoring.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
