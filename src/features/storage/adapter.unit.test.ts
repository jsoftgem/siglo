import { expect } from 'chai';
import {
    Step,
    flow,
    StorageManager,
    defaultStorageManager,
    useStorage,
    getStorageAdapter,
    getCheckpoint,
    StorageAdapter,
    SerializedExecutionStack,
    ContextChangeEvent
} from '../../index';

describe('StorageAdapter & Unified Distributed Storage Unit Tests', () => {
    afterEach(() => {
        defaultStorageManager.clear();
    });

    it('registers and retrieves adapter via useStorage and getStorageAdapter', () => {
        const customAdapter: StorageAdapter = {
            name: 'MockAdapter'
        };

        const mgr = new StorageManager();
        expect(mgr.getStorageAdapter()).to.be.undefined;

        mgr.useStorage(customAdapter);
        expect(mgr.getStorageAdapter()).to.equal(customAdapter);

        mgr.clear();
        expect(mgr.getStorageAdapter()).to.be.undefined;

        useStorage(customAdapter);
        expect(getStorageAdapter()).to.equal(customAdapter);
        expect(Step.useStorage).to.not.be.undefined;
        Step.useStorage(customAdapter);
        expect(getStorageAdapter()).to.equal(customAdapter);
    });

    it('streams context changes to adapter.onContextChange during execution', async () => {
        const events: ContextChangeEvent[] = [];

        const streamAdapter: StorageAdapter = {
            name: 'StreamAdapter',
            onContextChange(entry) {
                events.push(entry);
            }
        };

        defaultStorageManager.useStorage(streamAdapter);

        const step1 = Step.create('step1', async () => ({ status: 'active', code: 101 }));
        const step2 = Step.create('step2', async () => ({ verified: true }));

        const testFlow = flow(step1, step2);
        await testFlow.run({ initialInput: 'test' }, { tenantId: 'tenant_omega' });

        expect(events.length).to.be.above(0);
        const tenantEvents = events.filter(e => e.tenantId === 'tenant_omega');
        expect(tenantEvents.length).to.be.above(0);

        const statusEvent = events.find(e => e.field === 'status');
        expect(statusEvent).to.not.be.undefined;
        expect(statusEvent?.value).to.equal('active');
        expect(statusEvent?.stackId).to.not.be.undefined;
        expect(statusEvent?.timestamp).to.be.above(0);
    });

    it('gracefully handles synchronous and asynchronous adapter errors in onContextChange', async () => {
        const faultyAdapter: StorageAdapter = {
            name: 'FaultyAdapter',
            onContextChange() {
                throw new Error('Adapter crash');
            }
        };

        defaultStorageManager.useStorage(faultyAdapter);

        const step = Step.create(async () => ({ ok: true }));
        const res = await step.run();
        expect(res.ok.val).to.be.true;
    });

    it('gracefully handles async rejection in onContextChange', async () => {
        const faultyAdapter: StorageAdapter = {
            name: 'AsyncFaultyAdapter',
            async onContextChange() {
                return Promise.reject(new Error('Async adapter crash'));
            }
        };

        defaultStorageManager.useStorage(faultyAdapter);

        const step = Step.create(async () => ({ ok: true }));
        const res = await step.run();
        expect(res.ok.val).to.be.true;
    });

    it('persists and retrieves checkpoints through adapter.saveCheckpoint and getCheckpoint', async () => {
        const savedCheckpoints = new Map<string, SerializedExecutionStack>();

        const checkpointAdapter: StorageAdapter = {
            name: 'CheckpointAdapter',
            async saveCheckpoint(checkpoint) {
                savedCheckpoints.set(checkpoint.stackId, checkpoint);
            },
            async getCheckpoint(stackId) {
                return savedCheckpoints.get(stackId);
            }
        };

        const mgr = new StorageManager();
        mgr.useStorage(checkpointAdapter);

        const stackId = mgr.createExecutionStack('tenant_123');
        mgr.addChainToStack(stackId, 'step_abc');
        mgr.putChainContext('step_abc', 'counter', 42, { stackId, tenantId: 'tenant_123' });

        const snap = mgr.checkpoint(stackId);
        expect(snap.stackId).to.equal(stackId);
        expect(snap.tenantId).to.equal('tenant_123');
        expect(savedCheckpoints.has(stackId)).to.be.true;

        const retrieved = await mgr.getCheckpoint(stackId);
        expect(retrieved).to.not.be.undefined;
        expect(retrieved?.tenantId).to.equal('tenant_123');
        expect(retrieved?.contexts['step_abc'].counter).to.equal(42);
    });

    it('falls back to local stack in getCheckpoint if adapter returns undefined or throws', async () => {
        const failingAdapter: StorageAdapter = {
            name: 'FailingCheckpointAdapter',
            async getCheckpoint() {
                throw new Error('Database down');
            }
        };

        const mgr = new StorageManager();
        mgr.useStorage(failingAdapter);

        const stackId = mgr.createExecutionStack();
        mgr.putChainContext('s1', 'val', 'hello', { stackId });

        const fromFallback = await mgr.getCheckpoint(stackId);
        expect(fromFallback).to.not.be.undefined;
        expect(fromFallback?.stackId).to.equal(stackId);

        const nonExistent = await mgr.getCheckpoint('unknown_stack');
        expect(nonExistent).to.be.undefined;
    });

    it('global getCheckpoint and Step.getCheckpoint query defaultStorageManager', async () => {
        const stackId = defaultStorageManager.createExecutionStack();
        defaultStorageManager.putChainContext('s1', 'name', 'Fluid', { stackId });

        const res1 = await getCheckpoint(stackId);
        expect(res1?.stackId).to.equal(stackId);

        const res2 = await Step.getCheckpoint(stackId);
        expect(res2?.stackId).to.equal(stackId);
    });

    it('integrates with adapter getCachedStep and setCachedStep for step caching', async () => {
        const cacheStore = new Map<string, any>();
        let dbQueries = 0;

        const cachingAdapter: StorageAdapter = {
            name: 'CachingAdapter',
            async getCachedStep(key: string) {
                return cacheStore.get(key);
            },
            async setCachedStep(key: string, value: any) {
                cacheStore.set(key, value);
            }
        };

        defaultStorageManager.useStorage(cachingAdapter);

        const heavyStep = Step.create('heavyQuery', async (p: any) => {
            dbQueries++;
            const queryVal = p.query.val;
            return { data: `result_for_${queryVal}` };
        }).cache(10000);

        // First call - runs action and populates cache
        const res1 = await heavyStep.run({ query: 'books' });
        expect(res1.data.val).to.equal('result_for_books');
        expect(dbQueries).to.equal(1);
        expect(cacheStore.size).to.equal(1);

        // Second call with same input - serves from adapter cache
        const res2 = await heavyStep.run({ query: 'books' });
        expect(res2.data.val).to.equal('result_for_books');
        expect(dbQueries).to.equal(1); // Cached!

        // Third call with different input - runs action again
        const res3 = await heavyStep.run({ query: 'movies' });
        expect(res3.data.val).to.equal('result_for_movies');
        expect(dbQueries).to.equal(2);
    });

    it('handles adapter getCachedStep throwing gracefully by executing action', async () => {
        const errorCacheAdapter: StorageAdapter = {
            name: 'ErrorCacheAdapter',
            async getCachedStep() {
                throw new Error('Redis connection timeout');
            },
            async setCachedStep() {
                throw new Error('Redis write failed');
            }
        };

        defaultStorageManager.useStorage(errorCacheAdapter);

        const step = Step.create(async () => ({ computed: 99 })).cache(5000);
        const res = await step.run();
        expect(res.computed.val).to.equal(99);
    });

    it('handles sync step action caching when adapter setCachedStep is defined', async () => {
        const store = new Map<string, any>();
        const adapter: StorageAdapter = {
            name: 'SyncStoreAdapter',
            setCachedStep(key, val) {
                store.set(key, val);
            }
        };
        defaultStorageManager.useStorage(adapter);

        const syncStep = Step.create((p: any) => ({ doubled: p.num.val * 2 })).cache(5000);
        const res = await syncStep.run({ num: 21 });
        expect(res.doubled.val).to.equal(42);
        expect(store.size).to.equal(1);
    });

    it('handles async step action caching without adapter in same flow', async () => {
        let asyncCalls = 0;
        const asyncStep = Step.create('cachedAsyncStep', async (p: any) => {
            asyncCalls++;
            return { val: p.v.val * 10 };
        })
        .spec('v', { require: true })
        .strict()
        .cache(5000);

        const combinedFlow = flow(asyncStep, asyncStep);
        const res = await combinedFlow.run({ v: 3 });
        expect(res.val.val).to.equal(30);
        expect(asyncCalls).to.equal(1); // Second step in same flow read from cache!
    });
    it("handles async step action caching when adapter setCachedStep is defined", async () => {
        const store = new Map<string, any>();
        const adapter: StorageAdapter = {
            name: "AsyncStoreAdapter",
            async setCachedStep(key, val) {
                store.set(key, val);
            }
        };
        defaultStorageManager.useStorage(adapter);

        const asyncStep = Step.create(async (p: any) => ({ doubled: p.num.val * 2 })).cache(5000);
        const res = await asyncStep.run({ num: 25 });
        expect(res.doubled.val).to.equal(50);
        expect(store.size).to.equal(1);
    });
    it("resolves stackId and tenantId from existing stacks in onContextChange if not provided in meta", () => {
        const events: ContextChangeEvent[] = [];
        const adapter: StorageAdapter = {
            name: "ResolveMetaAdapter",
            onContextChange(e) {
                events.push(e);
            }
        };

        const mgr = new StorageManager();
        mgr.useStorage(adapter);

        const stackId1 = mgr.createStack("stack_search", "tenant_found");
        mgr.addChainToStack(stackId1, "step_discovered");

        // Call putChainContext without meta -> resolves stackId and tenantId by scanning stacks
        mgr.putChainContext("step_discovered", "status", "ready");
        expect(events.length).to.equal(1);
        expect(events[0].stackId).to.equal("stack_search");
        expect(events[0].tenantId).to.equal("tenant_found");

        // Call putChainContext with stackId in meta but without tenantId -> resolves tenantId from stack
        const stackId2 = mgr.createStack("stack_lookup", "tenant_lookup_val");
        mgr.putChainContext("step_any", "metric", 100, { stackId: stackId2 });
        expect(events.length).to.equal(2);
        expect(events[1].stackId).to.equal(stackId2);
        expect(events[1].tenantId).to.equal("tenant_lookup_val");

        // Call putChainContext with string meta
        mgr.putChainContext("step_str", "metric", 200, "string_stack_id");
        expect(events.length).to.equal(3);
        expect(events[2].stackId).to.equal("string_stack_id");
    });
});
