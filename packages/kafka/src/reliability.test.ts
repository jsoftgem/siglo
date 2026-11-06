import { strict as assert } from 'node:assert';
import { Flow, InMemoryIdempotencyStore, Step, flow } from '@siglo/core';
import { createKafkaBatchHandler, createKafkaMessageHandler, SigloKafkaBatchPayload } from './index';

function record(offset = '0', partition = 0) {
    return {
        topic: 'orders', partition,
        message: { key: Buffer.from('same-order'), value: Buffer.from('{"orderId":"order-1"}'), offset },
    };
}

function workflow(run: (...args: any[]) => Promise<any>): Flow<any, any> {
    return { run } as unknown as Flow<any, any>;
}

function batch(): SigloKafkaBatchPayload & { resolved: string[]; commits: string[][] } {
    const resolved: string[] = [];
    const commits: string[][] = [];
    return {
        batch: { topic: 'orders', partition: 0, messages: ['0', '1', '2'].map(offset => record(offset).message) },
        resolveOffset: offset => { resolved.push(offset); },
        heartbeat: async () => {},
        commitOffsetsIfNecessary: async () => { commits.push([...resolved]); },
        isRunning: () => true,
        isStale: () => false,
        resolved, commits,
    };
}

describe('@siglo/kafka reliability', () => {
    it('accepts native eachMessage payloads and enriches callback metadata from the envelope', async () => {
        const handler = createKafkaMessageHandler(flow(Step.create('echo', async (input: any) => input)), {
            input: message => ({ topic: message.topic, partition: message.partition, ...JSON.parse(String(message.value)) }),
        });
        const result = await handler({ ...record('0', 3), message: { ...record().message, topic: 'wrong', partition: 99 } });
        assert.equal(result.topic, 'orders');
        assert.equal(result.partition, 3);
        assert.equal(result.orderId, 'order-1');
    });

    it('processes distinct offsets and partitions sharing a Kafka key, but skips record redelivery', async () => {
        let runs = 0;
        const handler = createKafkaMessageHandler(workflow(async () => ({ runs: ++runs })), {
            groupId: 'test', idempotencyStore: new InMemoryIdempotencyStore(),
        });
        assert.deepEqual(await handler(record('0')), { runs: 1 });
        assert.deepEqual(await handler(record('1')), { runs: 2 });
        assert.deepEqual(await handler(record('0', 1)), { runs: 3 });
        assert.deepEqual(await handler(record('0')), { runs: 1 });
        assert.equal(runs, 3);
    });

    it('supports explicit business keys and consistent output mapping on duplicates', async () => {
        let runs = 0;
        let mappings = 0;
        const handler = createKafkaMessageHandler(workflow(async () => ({ runs: ++runs })), {
            groupId: 'test', idempotencyStore: new InMemoryIdempotencyStore(),
            idempotencyKey: message => `tenant-a:${String(message.key)}`,
            output: (result, message) => ({ ...result, offset: message.offset, mappings: ++mappings }),
        });
        assert.deepEqual(await handler(record('0')), { runs: 1, offset: '0', mappings: 1 });
        assert.deepEqual(await handler(record('1')), { runs: 1, offset: '1', mappings: 2 });
        assert.equal(runs, 1);
    });

    it('preserves false, null, and zero cached results', async () => {
        for (const cached of [false, null, 0]) {
            const handler = createKafkaMessageHandler(workflow(async () => { throw new Error('must not run'); }), {
                groupId: 'test', idempotencyStore: {
                    claim: async () => 'completed', get: async () => cached,
                    complete: async () => {}, fail: async () => {},
                },
            });
            assert.equal(await handler(record()), cached);
        }
    });

    it('does not clear completed claims when output mapping fails', async () => {
        let runs = 0;
        let failMapping = true;
        const handler = createKafkaMessageHandler(workflow(async () => ({ runs: ++runs })), {
            groupId: 'test', idempotencyStore: new InMemoryIdempotencyStore(),
            output: result => { if (failMapping) throw new Error('mapping failed'); return result; },
        });
        await assert.rejects(handler(record()), /mapping failed/);
        failMapping = false;
        assert.deepEqual(await handler(record()), { runs: 1 });
    });

    it('retains claims after ambiguous completion failures', async () => {
        const store = new InMemoryIdempotencyStore();
        store.complete = async () => { throw new Error('store unavailable'); };
        let runs = 0;
        const handler = createKafkaMessageHandler(workflow(async () => ({ runs: ++runs })), { groupId: 'test', idempotencyStore: store });
        await assert.rejects(handler(record()), /store unavailable/);
        await assert.rejects(handler(record()), /already being processed/);
        assert.equal(runs, 1);
    });

    it('releases failed workflows for redelivery and preserves cleanup errors', async () => {
        const store = new InMemoryIdempotencyStore();
        let runs = 0;
        const handler = createKafkaMessageHandler(workflow(async () => {
            if (++runs === 1) throw new Error('workflow failed');
            return { ok: true };
        }), { groupId: 'test', idempotencyStore: store });
        await assert.rejects(handler(record()), /workflow failed/);
        assert.deepEqual(await handler(record()), { ok: true });
        store.fail = async () => { throw new Error('cleanup failed'); };
        const failing = createKafkaMessageHandler(workflow(async () => { throw new Error('original'); }), { groupId: 'test', idempotencyStore: store });
        await assert.rejects(failing(record('1')), (error: any) => {
            assert.deepEqual(error.errors.map((item: Error) => item.message), ['original', 'cleanup failed']);
            return true;
        });
    });

    it('rejects invalid heartbeat intervals', () => {
        for (const heartbeatIntervalMs of [-1, NaN, Infinity, 2147483648]) {
            assert.throws(() => createKafkaMessageHandler(workflow(async () => ({})), { heartbeatIntervalMs }), RangeError);
        }
    });

    it('heartbeats during long workflows, serializes calls, and stops after completion', async () => {
        let calls = 0;
        let active = 0;
        let maxActive = 0;
        const handler = createKafkaMessageHandler(workflow(async () => {
            await new Promise(resolve => setTimeout(resolve, 35));
            return { ok: true };
        }), { heartbeatIntervalMs: 2 });
        await handler({ ...record(), heartbeat: async () => {
            calls++;
            maxActive = Math.max(maxActive, ++active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
        } });
        assert.ok(calls > 1);
        assert.equal(maxActive, 1);
        assert.equal(active, 0);
        const settledCalls = calls;
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(calls, settledCalls);
    });

    it('aborts the workflow and rejects when a background heartbeat fails', async () => {
        const store = new InMemoryIdempotencyStore();
        let calls = 0;
        const handler = createKafkaMessageHandler(workflow(async (_input, options) => {
            await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
            return { ok: true };
        }), { heartbeatIntervalMs: 2, groupId: 'test', idempotencyStore: store });
        await assert.rejects(handler({ ...record(), heartbeat: async () => {
            if (++calls > 1) throw new Error('lost membership');
        } }), /lost membership/);
        assert.equal((await store.getRecord('kafka:["test",null,"kafka:orders:0:0"]'))?.status, 'in-progress');
    });

    it('does not start the workflow if the initial heartbeat fails', async () => {
        let runs = 0;
        const handler = createKafkaMessageHandler(workflow(async () => ({ runs: ++runs })));
        await assert.rejects(handler({ ...record(), heartbeat: async () => { throw new Error('disconnected'); } }), /disconnected/);
        assert.equal(runs, 0);
    });

    it('can disable automatic heartbeats', async () => {
        let calls = 0;
        await createKafkaMessageHandler(workflow(async () => ({})), { heartbeatIntervalMs: 0 })({
            ...record(), heartbeat: async () => { calls++; },
        });
        assert.equal(calls, 0);
    });

    it('resolves successful batch records sequentially and checks commits', async () => {
        const payload = batch();
        await createKafkaBatchHandler(workflow(async () => ({})))(payload);
        assert.deepEqual(payload.resolved, ['0', '1', '2']);
        assert.deepEqual(payload.commits, [['0'], ['0', '1'], ['0', '1', '2']]);
    });

    it('can leave commit management to the caller', async () => {
        const payload = batch();
        await createKafkaBatchHandler(workflow(async () => ({})), { commitOffsets: false })(payload);
        assert.deepEqual(payload.resolved, ['0', '1', '2']);
        assert.deepEqual(payload.commits, []);
    });

    it('stops a batch at failure without resolving the failed or subsequent offsets', async () => {
        const payload = batch();
        let runs = 0;
        const handler = createKafkaBatchHandler(workflow(async () => {
            if (++runs === 2) throw new Error('record failed');
            return {};
        }));
        await assert.rejects(handler(payload), /record failed/);
        assert.deepEqual(payload.resolved, ['0']);
        assert.equal(runs, 2);
    });

    it('does not process stopped or stale batches, or resolve a record that becomes stale', async () => {
        for (const state of ['stopped', 'stale', 'stale-during-work', 'stopped-during-work']) {
            const payload = batch();
            let runs = 0;
            if (state === 'stopped') payload.isRunning = () => false;
            if (state === 'stale') payload.isStale = () => true;
            await createKafkaBatchHandler(workflow(async () => {
                runs++;
                if (state === 'stale-during-work') payload.isStale = () => true;
                if (state === 'stopped-during-work') payload.isRunning = () => false;
                return {};
            }))(payload);
            assert.deepEqual(payload.resolved, []);
            assert.equal(runs, state.endsWith('during-work') ? 1 : 0);
        }
    });

    it('leaves offsets unresolved on heartbeat failure after workflow success', async () => {
        const payload = batch();
        payload.heartbeat = async () => { throw new Error('rebalance'); };
        await assert.rejects(createKafkaBatchHandler(workflow(async () => ({})), { heartbeatIntervalMs: 0 })(payload), /rebalance/);
        assert.deepEqual(payload.resolved, []);
    });
});
