import { expect } from 'chai';
import {
    Step,
    flow,
    InMemoryIdempotencyStore,
    defaultIdempotencyStore,
    buildIdempotencyKey,
    IdempotencyConflictException,
    clearStorage
} from '../../index';

describe('Idempotency Unit and Workflow Tests', () => {
    beforeEach(() => {
        clearStorage();
        defaultIdempotencyStore.clear();
    });

    afterEach(() => {
        clearStorage();
        defaultIdempotencyStore.clear();
    });

    it('InMemoryIdempotencyStore manages claim, complete, fail, get, TTL and clear lifecycle', async () => {
        const store = new InMemoryIdempotencyStore();

        // 1. First claim -> 'claimed'
        const c1 = await store.claim('k1', 30);
        expect(c1).to.equal('claimed');
        expect(store.size).to.equal(1);

        // 2. While in-progress -> 'in-progress'
        const c2 = await store.claim('k1');
        expect(c2).to.equal('in-progress');

        // 3. Complete -> result stored
        await store.complete('k1', { answer: 42 });
        const c3 = await store.claim('k1');
        expect(c3).to.equal('completed');
        const val = await store.get('k1');
        expect((val as any).answer).to.equal(42);

        // 4. Fail removes key
        await store.fail('k1', new Error('Fail'));
        const c4 = await store.claim('k1');
        expect(c4).to.equal('claimed');

        // 5. TTL expiration
        const storeTtl = new InMemoryIdempotencyStore();
        await storeTtl.claim('k2', 20);
        await storeTtl.complete('k2', { value: 99 });
        expect(await storeTtl.get('k2')).to.deep.equal({ value: 99 });

        await new Promise(r => setTimeout(r, 35));
        expect(await storeTtl.get('k2')).to.be.undefined;
        const cAfterExpiry = await storeTtl.claim('k2');
        expect(cAfterExpiry).to.equal('claimed');

        storeTtl.clear();
        expect(storeTtl.size).to.equal(0);
    });

    it('buildIdempotencyKey formats key bound to namespace and workflow version', () => {
        const keyDefault = buildIdempotencyKey('order-123');
        expect(keyDefault).to.equal('ff:idemp:default:1:order-123');

        const keyScoped = buildIdempotencyKey('order-123', {
            namespace: 'tenant-abc',
            workflowVersion: '2.0.0'
        });
        expect(keyScoped).to.equal('ff:idemp:tenant-abc:2.0.0:order-123');
    });

    it('workflow-level idempotency deduplicates calls and returns stored output', async () => {
        let executions = 0;
        const step = Step.create('payment').modern().onStart(async ({ amount }: any) => {
            executions++;
            await new Promise(r => setTimeout(r, 10));
            return { transactionId: `tx_${amount}`, paid: true, executions };
        });

        const p = flow(step);

        // First execution
        const res1 = await p.execute({ amount: 100 }, {
            pojo: true,
            idempotencyKey: 'req-payment-1',
            namespace: 'tenant-1'
        });
        expect(res1.paid).to.be.true;
        expect(res1.executions).to.equal(1);
        expect(executions).to.equal(1);

        // Second execution with same key -> should return cached result without running step!
        const res2 = await p.execute({ amount: 100 }, {
            pojo: true,
            idempotencyKey: 'req-payment-1',
            namespace: 'tenant-1'
        });
        expect(res2.paid).to.be.true;
        expect(res2.executions).to.equal(1);
        expect(executions).to.equal(1);
    });

    it('workflow-level idempotency throws IdempotencyConflictException for in-progress duplicate', async () => {
        const slowStep = Step.create('slowPayment').modern().onStart(async () => {
            await new Promise(r => setTimeout(r, 50));
            return { ok: true };
        });

        const p = flow(slowStep);

        // First call starts
        const p1 = p.execute({}, { idempotencyKey: 'concurrent-key' });

        // Second call immediately with same key while first is in-progress
        try {
            await p.execute({}, { idempotencyKey: 'concurrent-key' });
            expect.fail('Should have thrown IdempotencyConflictException');
        } catch (err: any) {
            expect(err).to.be.instanceOf(IdempotencyConflictException);
            expect(err.idempotencyKey).to.include('concurrent-key');
        }

        await p1; // let first complete cleanly
    });

    it('step-level idempotency via step.idempotent() caches step output and deduplicates', async () => {
        let stepExecutions = 0;
        const idempotentStep = Step.create('chargeStep')
            .modern()
            .idempotent((ctx) => `charge:${ctx.invoiceId}`)
            .onStart(async ({ invoiceId }: any) => {
                stepExecutions++;
                return { invoiceId, charged: true, stepExecutions };
            });

        const p = flow(idempotentStep);

        const r1 = await p.execute({ invoiceId: 'inv-99' }, { pojo: true });
        expect(r1.stepExecutions).to.equal(1);

        const r2 = await p.execute({ invoiceId: 'inv-99' }, { pojo: true });
        expect(r2.stepExecutions).to.equal(1);
        expect(stepExecutions).to.equal(1);
    });

    it('failed workflow cleans up idempotency claim so it can be retried', async () => {
        let attempts = 0;
        const failingStep = Step.create('failFirst').modern().onStart(() => {
            attempts++;
            if (attempts === 1) throw new Error('First try failed');
            return { success: true, attempts };
        });

        const p = flow(failingStep);

        try {
            await p.execute({}, { idempotencyKey: 'retryable-claim' });
            expect.fail('Should fail on first try');
        } catch (err: any) {
            expect(err.message).to.equal('First try failed');
        }

        // Retry should be able to claim and succeed
        const res = await p.execute({}, { pojo: true, idempotencyKey: 'retryable-claim' });
        expect(res.success).to.be.true;
        expect(res.attempts).to.equal(2);
    });
    it("handles expired key re-claim and complete on unclaimed key in store", async () => {
        const store = new InMemoryIdempotencyStore();
        await store.claim("k-exp", 10);
        await new Promise(r => setTimeout(r, 25));
        const reClaim = await store.claim("k-exp");
        expect(reClaim).to.equal("claimed");

        await store.complete("unclaimed-key", { done: true });
        expect(await store.get("unclaimed-key")).to.deep.equal({ done: true });
    });

    it("handles sync and async errors in idempotent steps and functional workflow idempotencyKey", async () => {
        const syncFailStep = Step.create("syncFail")
            .modern()
            .idempotent("sync-fail-k")
            .onStart(() => {
                throw new Error("Sync fail in idempotent step");
            });
        try {
            await flow(syncFailStep).execute();
            expect.fail("Should fail");
        } catch (err: any) {
            expect(err.message).to.equal("Sync fail in idempotent step");
        }

        const asyncFailStep = Step.create("asyncFail")
            .modern()
            .idempotent("async-fail-k")
            .onStart(async () => {
                throw new Error("Async fail in idempotent step");
            });
        try {
            await flow(asyncFailStep).execute();
            expect.fail("Should fail");
        } catch (err: any) {
            expect(err.message).to.equal("Async fail in idempotent step");
        }

        const stepFn = Step.create("stepFn").modern().onStart(() => ({ ok: true, fnProp: () => {} }));
        const resFn = await flow(stepFn).execute({ orderId: "ord-fn-1" }, {
            pojo: true,
            idempotencyKey: (ctx) => "wf-" + ctx.orderId
        });
        expect(resFn.ok).to.equal(true);
    });
    it("handles onAfter failure and reduce failure in idempotent steps", async () => {
        const afterFailStep = Step.create("afterFail")
            .modern()
            .idempotent("after-fail-k")
            .onStart(() => ({ data: 1 }))
            .onAfter(() => {
                throw new Error("OnAfter failed in idempotent step");
            });
        try {
            await flow(afterFailStep).execute();
            expect.fail("Should fail");
        } catch (err: any) {
            expect(err.message).to.equal("OnAfter failed in idempotent step");
        }

        const reduceFailStep = Step.create("reduceFail")
            .modern()
            .idempotent("reduce-fail-k")
            .reduce("items")
            .onStart(() => {
                throw new Error("Reducer action failed in idempotent step");
            });
        try {
            await flow(reduceFailStep).execute({ items: [1, 2] });
            expect.fail("Should fail");
        } catch (err: any) {
            expect(err.message).to.equal("Reducer action failed in idempotent step");
        }
    });
    it("handles step-level IdempotencyConflictException and store claim rejection", async () => {
        const slowStep = Step.create("slowStep")
            .modern()
            .idempotent("concurrent-step-key")
            .onStart(async () => {
                await new Promise(r => setTimeout(r, 60));
                return { done: true };
            });
        const p1 = flow(slowStep).execute();
        try {
            await flow(slowStep).execute();
            expect.fail("Should fail with conflict");
        } catch (err: any) {
            expect(err).to.be.instanceOf(IdempotencyConflictException);
        }
        await p1;

        const throwingStore: any = {
            claim: () => Promise.reject(new Error("Store failure")),
            complete: () => Promise.resolve(),
            fail: () => Promise.resolve(),
            get: () => Promise.resolve(undefined)
        };
        const errorStoreStep = Step.create("storeErrorStep")
            .modern()
            .idempotent("key-store-err", { store: throwingStore })
            .onStart(() => ({ done: true }));
        try {
            await flow(errorStoreStep).execute();
            expect.fail("Should fail");
        } catch (err: any) {
            expect(err.message).to.equal("Store failure");
        }
    });
});
