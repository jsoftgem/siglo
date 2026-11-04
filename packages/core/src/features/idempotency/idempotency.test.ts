import { expect } from 'chai';
import {
    Step,
    flow,
    InMemoryIdempotencyStore,
    defaultIdempotencyStore,
    buildIdempotencyKey,
    IdempotencyConflictException,
    clearStorage,
    isPermanentBusinessError
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

    it('InMemoryIdempotencyStore enforces maxSize and evicts expired or oldest entries', async () => {
        const store = new InMemoryIdempotencyStore({ maxSize: 2 });
        await store.claim('k1', 10);
        await store.claim('k2', 50000);
        expect(store.size).to.equal(2);

        await new Promise(r => setTimeout(r, 20));
        // k1 expired; claiming k3 should trigger cleanExpired and evict k1
        await store.claim('k3', 50000);
        expect(store.size).to.equal(2);
        expect(await store.get('k1')).to.be.undefined;

        // Both k2 and k3 unexpired; claiming k4 should evict oldest (k2)
        await store.claim('k4', 50000);
        expect(store.size).to.equal(2);
        expect(await store.get('k2')).to.be.undefined;

        // complete() on a new key when store is full also triggers eviction
        await store.complete('k5', { direct: true });
        expect(store.size).to.equal(2);

        // cleanExpired cleans expired entries
        const storeClean = new InMemoryIdempotencyStore({ maxSize: 10 });
        await storeClean.claim('temp', 10);
        await new Promise(r => setTimeout(r, 20));
        expect(storeClean.cleanExpired()).to.equal(1);
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
        const step = Step.create('payment', async ({ amount }: any) => {
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
        const slowStep = Step.create('slowPayment', async () => {
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
        const idempotentStep = Step.create('chargeStep', async ({ invoiceId }: any) => {
                stepExecutions++;
                return { invoiceId, charged: true, stepExecutions };
            })
            .idempotent((ctx) => `charge:${ctx.invoiceId}`);

        const p = flow(idempotentStep);

        const r1 = await p.execute({ invoiceId: 'inv-99' }, { pojo: true });
        expect(r1.stepExecutions).to.equal(1);

        const r2 = await p.execute({ invoiceId: 'inv-99' }, { pojo: true });
        expect(r2.stepExecutions).to.equal(1);
        expect(stepExecutions).to.equal(1);
    });

    it('failed workflow cleans up idempotency claim so it can be retried', async () => {
        let attempts = 0;
        const failingStep = Step.create('failFirst', () => {
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
        const syncFailStep = Step.create("syncFail", () => {
                throw new Error("Sync fail in idempotent step");
            })
            .idempotent("sync-fail-k");
        try {
            await flow(syncFailStep).execute();
            expect.fail("Should fail");
        } catch (err: any) {
            expect(err.message).to.equal("Sync fail in idempotent step");
        }

        const asyncFailStep = Step.create("asyncFail", async () => {
                throw new Error("Async fail in idempotent step");
            })
            .idempotent("async-fail-k");
        try {
            await flow(asyncFailStep).execute();
            expect.fail("Should fail");
        } catch (err: any) {
            expect(err.message).to.equal("Async fail in idempotent step");
        }

        const stepFn = Step.create("stepFn", () => ({ ok: true, fnProp: () => {} }));
        const resFn = await flow(stepFn).execute({ orderId: "ord-fn-1" }, {
            pojo: true,
            idempotencyKey: (ctx) => "wf-" + ctx.orderId
        });
        expect(resFn.ok).to.equal(true);
    });

    it("handles onAfter failure and reduce failure in idempotent steps", async () => {
        const afterFailStep = Step.create("afterFail", () => ({ data: 1 }))
            .idempotent("after-fail-k")
            .onAfter(() => {
                throw new Error("OnAfter failed in idempotent step");
            });
        try {
            await flow(afterFailStep).execute();
            expect.fail("Should fail");
        } catch (err: any) {
            expect(err.message).to.equal("OnAfter failed in idempotent step");
        }

        const reduceFailStep = Step.create("reduceFail", () => {
                throw new Error("Reducer action failed in idempotent step");
            })
            .idempotent("reduce-fail-k")
            .reduce("items");
        try {
            await flow(reduceFailStep).execute({ items: [1, 2] });
            expect.fail("Should fail");
        } catch (err: any) {
            expect(err.message).to.equal("Reducer action failed in idempotent step");
        }
    });

    it("handles step-level IdempotencyConflictException and store claim rejection", async () => {
        const slowStep = Step.create("slowStep", async () => {
                await new Promise(r => setTimeout(r, 60));
                return { done: true };
            })
            .idempotent("concurrent-step-key");
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
        const errorStoreStep = Step.create("storeErrorStep", () => ({ done: true }))
            .idempotent("key-store-err", { store: throwingStore });
        try {
            await flow(errorStoreStep).execute();
            expect.fail("Should fail");
        } catch (err: any) {
            expect(err.message).to.equal("Store failure");
        }
    });
    it("evaluates isPermanentBusinessError across error shapes and predicates", () => {
        expect(isPermanentBusinessError(null)).to.be.false;
        expect(isPermanentBusinessError(new Error("Generic"))).to.be.false;
        expect(isPermanentBusinessError({ isPermanent: true })).to.be.true;
        expect(isPermanentBusinessError({ permanent: true })).to.be.true;
        expect(isPermanentBusinessError({ isBusinessError: true })).to.be.true;
        expect(isPermanentBusinessError(new Error("Custom"), { isPermanentError: (e) => e.message.includes("Custom") })).to.be.true;
        expect(isPermanentBusinessError(new Error("Other"), { isPermanentError: (e) => e.message.includes("Custom") })).to.be.false;
    });

    it("retrieves record metadata via InMemoryIdempotencyStore.getRecord", async () => {
        const store = new InMemoryIdempotencyStore();
        expect(await store.getRecord("nonexistent")).to.be.undefined;

        await store.claim("rec-key", 20);
        const rec = await store.getRecord("rec-key");
        expect(rec).to.exist;
        expect(rec?.status).to.equal("in-progress");

        await new Promise(r => setTimeout(r, 30));
        expect(await store.getRecord("rec-key")).to.be.undefined;
    });

    it("supports workflow wait-and-settle polling until completed", async () => {
        const store = new InMemoryIdempotencyStore();
        let executionCount = 0;

        const slowStep = Step.create("slow", async () => {
            executionCount++;
            await new Promise(r => setTimeout(r, 60));
            return { orderId: "ord-settle-1", total: 100 };
        });
        const p = flow(slowStep);

        const exec1 = p.execute({}, {
            idempotencyKey: "settle-wf-key",
            idempotencyStore: store,
            pojo: true
        });

        // Small delay to ensure exec1 has claimed
        await new Promise(r => setTimeout(r, 10));

        // Concurrent execution waits and settles
        const res2 = await p.execute({}, {
            idempotencyKey: "settle-wf-key",
            idempotencyStore: store,
            settleTimeoutMs: 300,
            pollIntervalMs: 10,
            pojo: true
        });

        const res1 = await exec1;
        expect(executionCount).to.equal(1);
        expect(res1.total).to.equal(100);
        expect(res2.total).to.equal(100);
    });

    it("supports workflow wait-and-settle when in-flight execution transiently fails and clears key", async () => {
        const store = new InMemoryIdempotencyStore();
        let attempts = 0;

        const flakyStep = Step.create("flaky", async () => {
            attempts++;
            if (attempts === 1) {
                await new Promise(r => setTimeout(r, 40));
                throw new Error("Transient network glitch");
            }
            return { recovered: true };
        });
        const p = flow(flakyStep);

        const exec1 = p.execute({}, {
            idempotencyKey: "flaky-settle-key",
            idempotencyStore: store
        }).catch(err => err);

        await new Promise(r => setTimeout(r, 10));

        // Second caller waits, sees first caller clear key, re-claims and succeeds!
        const res2 = await p.execute({}, {
            idempotencyKey: "flaky-settle-key",
            idempotencyStore: store,
            settleTimeoutMs: 300,
            pollIntervalMs: 10,
            pojo: true
        });

        await exec1;
        expect(attempts).to.equal(2);
        expect(res2.recovered).to.be.true;
    });

    it("caches permanent business failures and returns decline on retries", async () => {
        const store = new InMemoryIdempotencyStore();
        let executions = 0;

        const declineStep = Step.create("decline", () => {
            executions++;
            const err: any = new Error("CardDeclined: Insufficient Funds");
            err.isPermanent = true;
            throw err;
        });
        const p = flow(declineStep);

        try {
            await p.execute({}, {
                idempotencyKey: "card-declined-key",
                idempotencyStore: store
            });
            expect.fail("Should have failed");
        } catch (err: any) {
            expect(err.message).to.include("CardDeclined");
        }

        expect(executions).to.equal(1);

        // Retry returns the cached decline record without re-executing
        const retryRes = await p.execute({}, {
            idempotencyKey: "card-declined-key",
            idempotencyStore: store,
            pojo: true
        });

        expect(executions).to.equal(1);
        expect(retryRes.error).to.include("CardDeclined");
        expect(retryRes.isPermanentError).to.be.true;
    });

    it("supports step-level wait-and-settle and permanent failure caching", async () => {
        const store = new InMemoryIdempotencyStore();
        let stepCalls = 0;

        const slowStep = Step.create("stepSettle", async () => {
            stepCalls++;
            await new Promise(r => setTimeout(r, 60));
            return { stepVal: 999 };
        }).idempotent("step-settle-k", {
            store,
            settleTimeoutMs: 300,
            pollIntervalMs: 10
        });

        const f = flow(slowStep);
        const p1 = f.execute({}, { pojo: true });
        await new Promise(r => setTimeout(r, 10));
        const p2 = await f.execute({}, { pojo: true });
        const res1 = await p1;

        expect(stepCalls).to.equal(1);
        expect(res1.stepVal).to.equal(999);
        expect(p2.stepVal).to.equal(999);

        // Permanent error at step level
        const permStep = Step.create("permStep", () => {
            const err: any = new Error("InvalidAccount");
            err.isPermanent = true;
            throw err;
        }).idempotent("perm-step-k", { store });

        try {
            await flow(permStep).execute();
            expect.fail("Should throw");
        } catch (err: any) {
            expect(err.message).to.equal("InvalidAccount");
        }

        const storedPerm = await store.get(buildIdempotencyKey("perm-step-k")) as any;
        expect(storedPerm?.isPermanentError).to.be.true;
    });
    it("supports wait-and-settle with fallback to store.get when getRecord is omitted", async () => {
        const memory = new Map();
        const storeWithoutGetRecord: IdempotencyStore = {
            async claim(key: string) {
                if (memory.has(key)) {
                    return memory.get(key).status;
                }
                memory.set(key, { status: "in-progress" });
                return "claimed";
            },
            async complete(key: string, result: unknown) {
                memory.set(key, { status: "completed", result });
            },
            async fail(key: string) {
                memory.delete(key);
            },
            async get(key: string) {
                return memory.get(key)?.result;
            }
        };

        const slowStep = Step.create("slowFallback", async () => {
            await new Promise(r => setTimeout(r, 60));
            return { fallbackRes: 777 };
        });

        const f = flow(slowStep);
        const p1 = f.execute({}, {
            idempotencyKey: "fallback-settle-key",
            idempotencyStore: storeWithoutGetRecord,
            pojo: true
        });

        await new Promise(r => setTimeout(r, 10));

        const res2 = await f.execute({}, {
            idempotencyKey: "fallback-settle-key",
            idempotencyStore: storeWithoutGetRecord,
            settleTimeoutMs: 300,
            pollIntervalMs: 10,
            pojo: true
        });

        const res1 = await p1;
        expect(res1.fallbackRes).to.equal(777);
        expect(res2.fallbackRes).to.equal(777);

        // Step level fallback
        const stepWithFallback = Step.create("stepFallback", async () => {
            await new Promise(r => setTimeout(r, 60));
            return { valFallback: 888 };
        }).idempotent("step-fb-key", {
            store: storeWithoutGetRecord,
            settleTimeoutMs: 300,
            pollIntervalMs: 10
        });

        const stepFlow = flow(stepWithFallback);
        const sp1 = stepFlow.execute({}, { pojo: true });
        await new Promise(r => setTimeout(r, 10));
        const sp2 = await stepFlow.execute({}, { pojo: true });
        const sres1 = await sp1;
        expect(sres1.valFallback).to.equal(888);
        expect(sp2.valFallback).to.equal(888);
    });

    it("supports step-level wait-and-settle recovering when in-flight transiently fails", async () => {
        const store = new InMemoryIdempotencyStore();
        let calls = 0;
        const flakyStep = Step.create("flakyStep", async () => {
            calls++;
            if (calls === 1) {
                await new Promise(r => setTimeout(r, 40));
                throw new Error("Temporary step fail");
            }
            return { recoveredStep: true };
        }).idempotent("flaky-step-settle-k", {
            store,
            settleTimeoutMs: 300,
            pollIntervalMs: 10
        });

        const f = flow(flakyStep);
        const p1 = f.execute().catch(err => err);
        await new Promise(r => setTimeout(r, 10));
        const p2 = await f.execute({}, { pojo: true });
        await p1;
        expect(calls).to.equal(2);
        expect(p2.recoveredStep).to.be.true;
    });

    it("supports reducer step permanent failure caching", async () => {
        const store = new InMemoryIdempotencyStore();
        const reducePermStep = Step.create("reducePerm", () => {
            const err: any = new Error("PermanentReducerDecline");
            err.isPermanent = true;
            throw err;
        })
        .idempotent("reduce-perm-k", { store })
        .reduce("items");

        try {
            await flow(reducePermStep).execute({ items: [1, 2] });
            expect.fail("Should throw");
        } catch (err: any) {
            expect(err.message).to.equal("PermanentReducerDecline");
        }

        const rec = await store.get(buildIdempotencyKey("reduce-perm-k")) as any;
        expect(rec?.isPermanentError).to.be.true;
    });

    it("step-level idempotency caches permanent error from async action", async () => {
        const store = new InMemoryIdempotencyStore();
        const failingStep = Step.create("permFailStep", async () => {
            const err: any = new Error("CardDeclinedPermanently");
            err.isPermanent = true;
            throw err;
        }).idempotent("perm-step-k", { store });

        try {
            await flow(failingStep).execute();
            expect.fail("Should throw");
        } catch (err: any) {
            expect(err.message).to.equal("CardDeclinedPermanently");
        }

        const rec = (await store.get(buildIdempotencyKey("perm-step-k"))) as any;
        expect(rec?.isPermanentError).to.be.true;
    });

    it("step-level idempotency caches permanent error from after hook", async () => {
        const store = new InMemoryIdempotencyStore();
        const afterFailStep = Step.create("afterFailStep", () => ({ ok: true }))
            .onAfter(() => {
                const err: any = new Error("AfterHookPermanentDecline");
                err.isPermanent = true;
                throw err;
            })
            .idempotent("after-perm-step-k", { store });

        try {
            await flow(afterFailStep).execute();
            expect.fail("Should throw");
        } catch (err: any) {
            expect(err.message).to.equal("AfterHookPermanentDecline");
        }

        const rec = (await store.get(buildIdempotencyKey("after-perm-step-k"))) as any;
        expect(rec?.isPermanentError).to.be.true;
    });

    it("isPermanentBusinessError evaluates custom predicate function and options", () => {
        const customErr = new Error("CustomFail");
        const customPredicate = (err: any) => err.message === "CustomFail";
        expect(isPermanentBusinessError(customErr, { isPermanentError: customPredicate })).to.be.true;
        expect(isPermanentBusinessError(new Error("Other"), { isPermanentError: customPredicate })).to.be.false;
        expect(isPermanentBusinessError({ isPermanent: true })).to.be.true;
        expect(isPermanentBusinessError({ permanent: true })).to.be.true;
        expect(isPermanentBusinessError({ isBusinessError: true })).to.be.true;
        expect(isPermanentBusinessError(new Error("Regular transient fail"))).to.be.false;
        expect(isPermanentBusinessError(null)).to.be.false;
        expect(isPermanentBusinessError(undefined)).to.be.false;
    });
    it("supports successful reducer step execution and idempotency completion", async () => {
        const store = new InMemoryIdempotencyStore();
        let callCount = 0;
        const reduceSuccessStep = Step.create("reduceSuccess", (parameter: any, current: any) => {
            callCount++;
            return (parameter.value || 0) + current;
        })
        .idempotent("reduce-success-k", { store })
        .reduce("items");

        const res1: any = await flow(reduceSuccessStep).execute({ items: [1, 2] });
        expect(res1.value).to.equal(3);
        expect(callCount).to.equal(2);

        // Re-executing with same idempotency key should hit cached result
        const res2: any = await flow(reduceSuccessStep).execute({ items: [1, 2] });
        expect(res2.value).to.equal(3);
        expect(callCount).to.equal(2);
    });
});
