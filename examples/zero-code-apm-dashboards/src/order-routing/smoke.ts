import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { database, deadLetterTopic, groupId, kafka, topic } from './infrastructure';
import { scenario } from './publish';

const stateFile = '/tmp/siglo-zero-code-apm-smoke.json';
async function eventually(check: () => Promise<void>) {
    const deadline = Date.now() + 60000;
    for (;;) {
        try { await check(); return; }
        catch (error) {
            if (Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
}
async function main() {
    const client = kafka('tutorial-smoke');
    const producer = client.producer();
    const admin = client.admin();
    const pool = database();
    const dlq = client.consumer({ groupId: `smoke-dlq-${randomUUID()}` });
    const failures: any[] = [];
    await producer.connect();
    await admin.connect();
    try {
        for (const worker of ['worker-a', 'worker-b']) {
            await eventually(async () => {
                const response = await fetch(`http://${worker}:3000/health`);
                assert.equal(response.status, 200);
                assert.ok((await response.json()).assignedPartitions.length > 0);
            });
        }
        if (process.argv[2] === 'submit') {
            const runId = randomUUID().slice(0, 8);
            const names = ['standard', 'gift', 'review', 'cancel', 'unsupported', 'invalid'];
            const ids = Object.fromEntries(names.map(name => [name, `${name}-${runId}`]));
            await dlq.connect();
            await dlq.subscribe({ topic: deadLetterTopic, fromBeginning: true });
            await dlq.run({ eachMessage: async ({ message }) => { failures.push(JSON.parse(String(message.value))); } });
            for (const name of names) {
                const event = scenario(name, ids[name], `order-${runId}-${name === 'cancel' ? 'standard' : name}`);
                await producer.send({ topic, messages: [{ key: event.orderId,
                    value: name === 'invalid' ? '{invalid JSON' : JSON.stringify(event),
                    headers: { 'event-id': event.eventId, 'x-namespace': 'apm-demo' },
                }] });
            }
            await eventually(async () => {
                const rows = (await pool.query('SELECT result, executions FROM tutorial_order_results WHERE event_id = ANY($1)', [Object.values(ids)])).rows;
                assert.equal(rows.length, 4);
                const results = Object.fromEntries(rows.map(row => [row.result.eventId, row.result]));
                assert.deepEqual(results[ids.standard].actions, ['reserveStock', 'chargePayment', 'shipOrder']);
                assert.deepEqual(results[ids.gift].actions, ['reserveStock', 'chargePayment', 'wrapGift', 'shipOrder']);
                assert.equal(results[ids.gift].giftWrapped, true);
                assert.deepEqual(results[ids.review].actions, ['queueReview']);
                assert.equal(results[ids.review].status, 'review-required');
                assert.deepEqual(results[ids.cancel].actions, ['recordCancellation']);
                assert.ok(rows.every(row => row.executions === 1));
                const invalid = failures.find(failure => failure.eventId === ids.invalid);
                const unsupported = failures.find(failure => failure.eventId === ids.unsupported);
                assert.equal(invalid?.attempts, 0);
                assert.equal(unsupported?.attempts, 1);
            });
            await eventually(async () => {
                const monitor = await fetch('http://monitor:4000/api/workflows');
                const runs = await monitor.json();
                assert.ok(runs.some((run: any) => run.status === 'COMPLETED' && JSON.stringify(run).includes(ids.gift)));
                assert.ok(runs.some((run: any) => JSON.stringify(run.ast).includes('wrapGift')));
            });
            writeFileSync(stateFile, JSON.stringify({ ids, runId }));
            console.log('Passed: branch/when routes, optional gift step, PostgreSQL outcomes, real DLQ messages, and Redis monitoring.');
        } else {
            assert.equal(process.argv[2], 'replay', 'Use submit or replay');
            const { ids, runId } = JSON.parse(readFileSync(stateFile, 'utf8'));
            const event = scenario('standard', ids.standard, `order-${runId}-standard`);
            const [sent] = await producer.send({ topic, messages: [{ key: event.orderId, value: JSON.stringify(event),
                headers: { 'event-id': event.eventId, 'x-namespace': 'apm-demo' },
            }] });
            await eventually(async () => {
                const offsets = await admin.fetchOffsets({ groupId, topics: [topic] });
                const partition = offsets[0].partitions.find(entry => entry.partition === sent.partition);
                assert.ok(partition && BigInt(partition.offset) > BigInt(sent.baseOffset!));
            });
            const row = (await pool.query("SELECT executions FROM tutorial_order_results WHERE tenant = 'apm-demo' AND event_id = $1", [ids.standard])).rows[0];
            assert.equal(row.executions, 1, 'PostgreSQL claim should skip the workflow after both consumers restart');
            const key = `kafka:${JSON.stringify([groupId, 'apm-demo', event.eventId])}`;
            assert.equal((await pool.query('SELECT status FROM siglo_idempotency WHERE key = $1', [key])).rows[0].status, 'completed');
            console.log('Passed: both consumers restarted, Kafka offset advanced for a new duplicate record, workflow execution count stayed at one.');
        }
    } finally { await dlq.disconnect(); await producer.disconnect(); await admin.disconnect(); await pool.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
