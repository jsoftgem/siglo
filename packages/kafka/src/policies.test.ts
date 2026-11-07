import { strict as assert } from 'node:assert';
import { mock } from 'node:test';
import { Flow, InMemoryIdempotencyStore, Step, flow } from '@siglo/core';
import { createKafkaMessageHandler, createKafkaBatchHandler, KafkaInvalidMessageError, KafkaProcessingCancelledError, getKafkaRecordId } from './index';

const record = (value: string | null = '{"eventId":"e1"}', offset = '0', tenant = 'a') => ({
    topic: 'events', partition: 0,
    message: { value, offset, key: 'entity-1', headers: { 'x-namespace': tenant } },
});
const workflow = (run: (...args: any[]) => Promise<any>) => ({ run } as unknown as Flow<any, any>);

describe('@siglo/kafka production policies', () => {
    it('requires a consumer group when deduplicating', () => {
        assert.throws(() => createKafkaMessageHandler(workflow(async () => ({})), { idempotencyStore: new InMemoryIdempotencyStore() }), /groupId/);
    });

    it('scopes both default and custom keys to the consumer group and tenant', async () => {
        for (const custom of [false, true]) {
            let runs = 0;
            const store = new InMemoryIdempotencyStore();
            const make = (groupId: string) => createKafkaMessageHandler(workflow(async () => ({ runs: ++runs })), {
                groupId, idempotencyStore: store, ...(custom ? { idempotencyKey: () => 'business-event' } : {}),
            });
            const billing = make('billing');
            const analytics = make('analytics');
            await billing(record());
            await billing(record());
            await analytics(record());
            await billing(record(undefined, '0', 'b'));
            assert.equal(runs, 3);
        }
    });

    it('keeps scope boundaries unambiguous when IDs contain delimiters', async () => {
        let runs = 0;
        const store = new InMemoryIdempotencyStore();
        for (const [groupId, namespace] of [['a:b', 'c'], ['a', 'b:c']]) {
            await createKafkaMessageHandler(workflow(async () => ({ runs: ++runs })), {
                groupId, namespace, idempotencyStore: store,
            })(record());
        }
        assert.equal(runs, 2);
    });

    it('rejects malformed JSON and empty values before the workflow by default', async () => {
        let runs = 0;
        const handler = createKafkaMessageHandler(workflow(async () => ({ runs: ++runs })));
        for (const value of ['not json', '']) await assert.rejects(handler(record(value)), KafkaInvalidMessageError);
        assert.equal(runs, 0);
    });

    it('skips tombstones by default and supports reject or explicit processing', async () => {
        let runs = 0;
        const task = workflow(async (input) => ({ runs: ++runs, input }));
        const skipped = await createKafkaMessageHandler(task)(record(null));
        assert.equal(skipped.skipped, true);
        assert.equal(runs, 0);
        await assert.rejects(createKafkaMessageHandler(task, { tombstone: 'error' })(record(null)), KafkaInvalidMessageError);
        const processed = await createKafkaMessageHandler(task, { tombstone: 'process', input: message => ({ deleted: message.key }) })(record(null));
        assert.deepEqual(processed, { runs: 1, input: { deleted: 'entity-1' } });
    });

    it('validates parsed input once and dead-letters validation errors without running or retrying the workflow', async () => {
        let runs = 0;
        const failures: any[] = [];
        const handler = createKafkaMessageHandler(workflow(async () => ({ runs: ++runs })), {
            validate: () => { throw new Error('missing amount'); },
            retry: { maxAttempts: 3 }, deadLetter: async failure => { failures.push(failure); },
        });
        assert.equal((await handler(record())).deadLettered, true);
        assert.equal(runs, 0);
        assert.equal(failures[0].attempts, 0);
        assert.equal(failures[0].error.cause.message, 'missing amount');
    });

    it('retries transient workflow errors and succeeds within the bounded attempt count', async () => {
        let attempts = 0;
        const handler = createKafkaMessageHandler(workflow(async () => {
            if (++attempts < 3) throw new Error('unavailable');
            return { success: true };
        }), { retry: { maxAttempts: 3, delayMs: 1 } });
        assert.deepEqual(await handler(record()), { success: true });
        assert.equal(attempts, 3);
    });

    it('dead-letters exhausted failures and caches disposition without running the output mapper', async () => {
        let attempts = 0;
        let published = 0;
        const handler = createKafkaMessageHandler(workflow(async () => { attempts++; throw new Error('broken'); }), {
            groupId: 'billing', idempotencyStore: new InMemoryIdempotencyStore(), retry: { maxAttempts: 2 },
            output: () => { throw new Error('not a workflow result'); },
            deadLetter: async failure => { published++; assert.equal(failure.attempts, 2); assert.equal(failure.recordId, getKafkaRecordId({ ...record(), offset: record().message.offset })); },
        });
        assert.equal((await handler(record())).deadLettered, true);
        assert.equal((await handler(record())).deadLettered, true);
        assert.equal(attempts, 2);
        assert.equal(published, 1);
    });

    it('does not acknowledge failed dead-letter publication and permits redelivery', async () => {
        let publishes = 0;
        const handler = createKafkaMessageHandler(workflow(async () => { throw new Error('workflow'); }), {
            groupId: 'billing', idempotencyStore: new InMemoryIdempotencyStore(),
            deadLetter: async () => { if (++publishes === 1) throw new Error('DLQ unavailable'); },
        });
        await assert.rejects(handler(record()), /DLQ unavailable/);
        assert.equal((await handler(record())).deadLettered, true);
    });

    it('can classify permanent workflow errors without retrying them', async () => {
        let attempts = 0;
        const handler = createKafkaMessageHandler(workflow(async () => { attempts++; throw new Error('permanent'); }), {
            retry: { maxAttempts: 5, shouldRetry: () => false },
        });
        await assert.rejects(handler(record()), /permanent/);
        assert.equal(attempts, 1);
    });

    it('rejects unsafe lease budgets and invalid retry settings', () => {
        const task = workflow(async () => ({}));
        assert.throws(() => createKafkaMessageHandler(task, { groupId: 'g', idempotencyStore: new InMemoryIdempotencyStore(), idempotencyTtlMs: 100, timeout: 80 }), /80%/);
        for (const maxAttempts of [0, -1, 1.5, Infinity]) {
            assert.throws(() => createKafkaMessageHandler(task, { retry: { maxAttempts } }), /maxAttempts/);
        }
    });

    it('bounds execution before claim expiry and fences late completion', async () => {
        mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 });
        try {
            const store = new InMemoryIdempotencyStore();
            let finish: (result: any) => void = () => {};
            let started: () => void = () => {};
            const running = new Promise<void>(resolve => { started = resolve; });
            let signal: AbortSignal | undefined;
            let completions = 0;
            const originalComplete = store.complete.bind(store);
            store.complete = async (key, result) => { completions++; await originalComplete(key, result); };
            const handler = createKafkaMessageHandler(workflow((_input, options) => new Promise(resolve => {
                signal = options.signal;
                finish = resolve;
                started();
            })), {
                groupId: 'g', idempotencyStore: store, idempotencyTtlMs: 100,
                deadLetter: async () => { throw new Error('must not dead-letter infrastructure cancellation'); },
            });
            const cancelled = assert.rejects(handler(record()), KafkaProcessingCancelledError);
            await running;
            mock.timers.tick(79);
            assert.equal(signal?.aborted, false);
            mock.timers.tick(1);
            await cancelled;
            assert.equal(signal?.aborted, true);
            finish({ late: true });
            // Let the late workflow continuation settle without consuming the claim's remaining TTL.
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(completions, 0);
            await assert.rejects(handler(record()), /already being processed/);
        } finally {
            mock.timers.reset();
        }
    });

    it('cancels an uncooperative workflow on shutdown without clearing its claim or publishing to DLQ', async () => {
        const controller = new AbortController();
        const store = new InMemoryIdempotencyStore();
        let published = 0;
        let signal: AbortSignal | undefined;
        const handler = createKafkaMessageHandler(workflow(async (_input, options) => {
            signal = options.signal;
            controller.abort();
            return new Promise(() => {});
        }), { groupId: 'g', idempotencyStore: store, signal: controller.signal, deadLetter: async () => { published++; } });
        await assert.rejects(handler(record()), KafkaProcessingCancelledError);
        assert.equal(signal?.aborted, true);
        assert.equal(published, 0);
        const other = createKafkaMessageHandler(workflow(async () => ({})), { groupId: 'g', idempotencyStore: store });
        await assert.rejects(other(record()), /already being processed/);
    });

    it('cancels retry backoff promptly', async () => {
        const controller = new AbortController();
        let attempts = 0;
        const handler = createKafkaMessageHandler(workflow(async () => {
            attempts++;
            setTimeout(() => controller.abort(), 5);
            throw new Error('transient');
        }), { signal: controller.signal, retry: { maxAttempts: 3, delayMs: 10000 } });
        await assert.rejects(handler(record()), KafkaProcessingCancelledError);
        assert.equal(attempts, 1);
    });

    it('retains claims when an actual Siglo step times out', async () => {
        const store = new InMemoryIdempotencyStore();
        const task = flow(Step.create('hang', async () => new Promise(() => {})).timeout(10));
        const handler = createKafkaMessageHandler(task, { groupId: 'g', idempotencyStore: store });
        await assert.rejects(handler(record()), KafkaProcessingCancelledError);
        await assert.rejects(handler(record()), /already being processed/);
    });

    it('cancels an active batch workflow when it becomes stale, even with heartbeats disabled', async () => {
        let stale = false;
        let aborted = false;
        const offsets: string[] = [];
        const handler = createKafkaBatchHandler(workflow(async (_input, options) => {
            setTimeout(() => { stale = true; }, 5);
            await new Promise<void>(resolve => options.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
            return {};
        }), { heartbeatIntervalMs: 0 });
        await handler({
            batch: { topic: 'events', partition: 0, messages: [record().message] },
            heartbeat: async () => {}, resolveOffset: offset => { offsets.push(offset); },
            commitOffsetsIfNecessary: async () => {}, isRunning: () => true, isStale: () => stale,
        });
        assert.equal(aborted, true);
        assert.deepEqual(offsets, []);
    });
    it('rejects a late result after synchronous work blocks the deadline timer', async () => {
        const store = new InMemoryIdempotencyStore();
        let completions = 0;
        store.complete = async () => { completions++; };
        const handler = createKafkaMessageHandler(workflow(async () => {
            const until = Date.now() + 25;
            while (Date.now() < until) { /* Simulate synchronous CPU work. */ }
            return { late: true };
        }), { groupId: 'g', idempotencyStore: store, timeout: 5, idempotencyTtlMs: 1000 });
        await assert.rejects(handler(record()), KafkaProcessingCancelledError);
        assert.equal(completions, 0);
    });

    it('cancels cached-result retrieval during shutdown without running output mapping', async () => {
        const controller = new AbortController();
        let mappings = 0;
        const handler = createKafkaMessageHandler(workflow(async () => ({})), {
            groupId: 'g', signal: controller.signal,
            output: () => { mappings++; },
            idempotencyStore: {
                claim: async () => 'completed', complete: async () => {}, fail: async () => {},
                get: async () => { controller.abort(); return { cached: true }; },
            },
        });
        await assert.rejects(handler(record()), KafkaProcessingCancelledError);
        assert.equal(mappings, 0);
    });

});
