import { strict as assert } from 'node:assert';
import { fork, ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryIdempotencyStore } from '@siglo/core';
import { createKafkaMessageHandler, createKafkaBatchHandler } from '../src';

const { Kafka, logLevel } = require('kafkajs');
const broker = process.env.KAFKA_BROKER ?? 'localhost:19092';
const unique = () => `siglo-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => boolean | Promise<boolean>, ms = 30000) {
    const deadline = Date.now() + ms;
    while (!await check()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for Kafka recovery');
        await pause(50);
    }
}

describe('@siglo/kafka live recovery', function () {
    this.timeout(60000);
    const kafka = new Kafka({ clientId: unique(), brokers: [broker], logLevel: logLevel.NOTHING });
    const admin = kafka.admin();
    const producer = kafka.producer();
    const consumers: any[] = [];
    const children: ChildProcess[] = [];
    const topics: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'siglo-kafka-recovery-'));
    async function topic(partitions = 1) {
        const name = unique();
        await admin.createTopics({ topics: [{ topic: name, numPartitions: partitions, replicationFactor: 1 }] });
        topics.push(name);
        return name;
    }
    async function consumer(groupId: string, name: string) {
        const instance = kafka.consumer({ groupId, sessionTimeout: 6000, heartbeatInterval: 200 });
        consumers.push(instance);
        await instance.connect();
        await instance.subscribe({ topic: name, fromBeginning: true });
        return instance;
    }
    before(async () => { await admin.connect(); await producer.connect(); });
    afterEach(async () => {
        for (const child of children.splice(0)) {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
                await new Promise<void>(resolve => child.once('exit', () => resolve()));
            }
        }
        await Promise.all(consumers.splice(0).map(instance => instance.disconnect()));
    });
    after(async () => {
        try { if (topics.length) await admin.deleteTopics({ topics }); }
        finally {
            await producer.disconnect(); await admin.disconnect();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('delivers same-key events independently to groups sharing one deduplication store', async () => {
        const name = await topic();
        const store = new InMemoryIdempotencyStore();
        const received: Record<string, string[]> = { billing: [], analytics: [] };
        await producer.send({ topic: name, messages: ['created', 'updated'].map(eventId => ({ key: 'order-1', value: JSON.stringify({ eventId }) })) });
        for (const group of Object.keys(received)) {
            const groupId = `${name}-${group}`;
            const instance = await consumer(groupId, name);
            await instance.run({ eachMessage: createKafkaMessageHandler({ run: async (input: any) => {
                received[group].push(input.eventId); return {};
            } } as any, { groupId, idempotencyStore: store }) });
        }
        await eventually(() => received.billing.length === 2 && received.analytics.length === 2);
        assert.deepEqual(received.billing, ['created', 'updated']);
        assert.deepEqual(received.analytics, ['created', 'updated']);
    });

    it('publishes a poison record to DLQ before advancing the batch and skips tombstones', async () => {
        const name = await topic();
        const dlq = await topic();
        const groupId = unique();
        const handled: string[] = [];
        const quarantined: any[] = [];
        const dlqConsumer = await consumer(unique(), dlq);
        await dlqConsumer.run({ eachMessage: async ({ message }: any) => { quarantined.push(JSON.parse(String(message.value))); } });
        const instance = await consumer(groupId, name);
        await instance.run({ eachBatchAutoResolve: false, eachBatch: createKafkaBatchHandler({ run: async (input: any) => {
            handled.push(input.eventId); return {};
        } } as any, {
            groupId, idempotencyStore: new InMemoryIdempotencyStore(),
            deadLetter: async failure => { await producer.send({ topic: dlq, messages: [{ key: failure.recordId, value: JSON.stringify({ recordId: failure.recordId, raw: String(failure.message.value) }) }] }); },
        }) });
        await producer.send({ topic: name, messages: [
            { value: 'invalid-json' }, { value: null }, { value: '{"eventId":"valid"}' },
        ] });
        await eventually(() => quarantined.length === 1 && handled.length === 1);
        await eventually(async () => {
            const offsets = await admin.fetchOffsets({ groupId, topics: [name] });
            return offsets[0].partitions[0].offset === '3';
        });
        assert.deepEqual(handled, ['valid']);
        assert.equal(quarantined[0].raw, 'invalid-json');
    });

    it('redelivers after SIGKILL between an external effect and offset completion without repeating a deduplicated effect', async () => {
        const name = await topic();
        const groupId = unique();
        const effectsPath = join(directory, 'effects.json');
        await producer.send({ topic: name, messages: [{ value: '{"eventId":"payment-1"}' }] });
        const start = (mode: string) => {
            const child = fork(join(__dirname, 'crash-consumer.cjs'), [broker, name, groupId, effectsPath, mode], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
            children.push(child);
            return child;
        };
        const effect = (child: ChildProcess) => new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Child did not process Kafka record')), 30000);
            child.on('message', (message: any) => {
                if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.error)); }
                if (message.type === 'effect') { clearTimeout(timer); resolve(); }
            });
            child.once('error', error => { clearTimeout(timer); reject(error); });
        });
        const first = start('crash');
        await effect(first);
        first.kill('SIGKILL');
        await new Promise<void>(resolve => first.once('exit', () => resolve()));
        const second = start('recover');
        await effect(second);
        await eventually(async () => {
            const offsets = await admin.fetchOffsets({ groupId, topics: [name] });
            return offsets[0].partitions[0].offset === '1';
        });
        assert.deepEqual(JSON.parse(readFileSync(effectsPath, 'utf8')), ['payment-1']);
    });

    it('recovers all records when a second consumer joins during a long workflow', async () => {
        const name = await topic(2);
        const groupId = unique();
        const effects = new Set<string>();
        const completed = new Set<string>();
        let started = false;
        let joins = 0;
        const task = { run: async (input: any, options: any) => {
            started = true;
            effects.add(input.eventId); // Simulated provider-level idempotency.
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => { options.signal.removeEventListener('abort', onAbort); resolve(); }, 1500);
                const onAbort = () => { clearTimeout(timer); reject(options.signal.reason); };
                options.signal.addEventListener('abort', onAbort, { once: true });
            });
            completed.add(input.eventId);
            return {};
        } } as any;
        const first = await consumer(groupId, name);
        first.on(first.events.GROUP_JOIN, () => { joins++; });
        await first.run({ eachMessage: createKafkaMessageHandler(task, { heartbeatIntervalMs: 100 }) });
        await producer.send({ topic: name, messages: [
            { partition: 0, value: '{"eventId":"a"}' }, { partition: 1, value: '{"eventId":"b"}' },
        ] });
        await eventually(() => started);
        const second = await consumer(groupId, name);
        second.on(second.events.GROUP_JOIN, () => { joins++; });
        await second.run({ eachMessage: createKafkaMessageHandler(task, { heartbeatIntervalMs: 100 }) });
        await eventually(() => completed.size === 2 && joins >= 3);
        assert.deepEqual([...effects].sort(), ['a', 'b']);
    });
});
