import {StorageManager} from "./storage";
import OnFail from "./executer/SingleChain/LifeCycle/OnFail";
import {expect} from 'chai';
import {
    Step,
    flow,
    Chain,
    pipe,
    isPipeline,
    isFlow,
    RivuletError,
    StepTimeoutException,
    FlowTimeoutException,
    CancellationException,
    ValidationException,
    StorageAdapterException,
    CheckpointConflictException,
    NamespaceMismatchException,
    CheckpointVersionException,
    normalizeError,
    StorageAdapter,
    defaultStorageManager,
    clearStorage,
    getErrorMode,
    cleanExpiredCheckpoints
} from '../index';
import {cache} from './cache';

describe('Product Clarity and Reliability Integration Suite', () => {
    beforeEach(() => {
        clearStorage();
        defaultStorageManager.setErrorMode('best-effort');
        defaultStorageManager.useStorage(undefined as any);
    });

    afterEach(() => {
        clearStorage();
        defaultStorageManager.setErrorMode('best-effort');
        defaultStorageManager.useStorage(undefined as any);
    });

    describe('Workstream 1: Public API & Backward Compatibility', () => {
        it('Chain, pipe, Pipeline, isPipeline aliases function identically to Step and flow', async () => {
            expect(Chain).to.equal(Step);
            expect(pipe).to.equal(flow);
            expect(isPipeline).to.equal(isFlow);

            const c1 = Chain.create('step1').modern().onStart(({a}: any) => ({val1: a + 10}));
            const c2 = Chain.create('step2').modern().onStart(({val1}: any) => ({final: val1 * 2}));

            const pipeline = pipe(c1, c2);
            expect(isPipeline(pipeline)).to.be.true;
            expect(isFlow(pipeline)).to.be.true;

            const res = await pipeline.execute({a: 5}, {pojo: true});
            expect(res.final).to.equal(30);
        });

        it('Step.cache() supports number, object with ttl, and default ttl', () => {
            const s1 = Step.create('c1').cache();
            expect(s1.cachedLast).to.equal(1500);

            const s2 = Step.create('c2').cache(5000);
            expect(s2.cachedLast).to.equal(5000);

            const s3 = Step.create('c3').cache({ttl: 3000, swr: 1000});
            expect(s3.cachedLast).to.equal(3000);
            expect(s3.cacheOptions?.swr).to.equal(1000);

            const s4 = Step.create('c4').cache({} as any);
            expect(s4.cachedLast).to.equal(1500);
        });

        it('Step static methods for error modes and expired checkpoints work', () => {
            Step.setErrorMode('warn');
            expect(Step.getErrorMode()).to.equal('warn');
            expect(getErrorMode()).to.equal('warn');

            Step.setErrorMode('strict');
            expect(Step.getErrorMode()).to.equal('strict');

            const cleaned = Step.cleanExpiredCheckpoints();
            expect(cleaned).to.equal(0);
        });
    });

    describe('Workstream 3: Error Model & Normalization', () => {
        it('RivuletError attaches metadata, preserves cause, and exports toJSON cleanly', () => {
            const causeErr = new Error('Database connection failed');
            const err = new RivuletError('Operation failed', {
                stepName: 'fetchUser',
                phase: 'action',
                retryable: true,
                stackId: 'stack-123',
                namespace: 'ns-abc',
                workflowId: 'wf-999',
                cause: causeErr,
                stateSnapshot: {attempt: 1}
            });

            expect(err).to.be.instanceOf(Error);
            expect(err).to.be.instanceOf(RivuletError);
            expect(err).to.be.instanceOf(RivuletError);
            expect(err.name).to.equal('RivuletError');
            expect(err.message).to.equal('Operation failed');
            expect(err.stepName).to.equal('fetchUser');
            expect(err.phase).to.equal('action');
            expect(err.retryable).to.equal(true);
            expect(err.stackId).to.equal('stack-123');
            expect(err.namespace).to.equal('ns-abc');
            expect(err.workflowId).to.equal('wf-999');
            expect(err.cause).to.equal(causeErr);
            expect(err.isTimeout).to.be.false;
            expect(err.isCancellation).to.be.false;
            // Backward compatibility
            expect((err as any).error).to.equal(causeErr);

            // Circular object in snapshot
            const circularObj: any = {name: 'circular'};
            circularObj.self = circularObj;
            (err as any).stateSnapshot = circularObj;

            const json = err.toJSON();
            expect(json.name).to.equal('RivuletError');
            expect(json.message).to.equal('Operation failed');
            expect(json.stepName).to.equal('fetchUser');
            expect(json.phase).to.equal('action');
            expect(json.retryable).to.equal(true);
            expect(json.stackId).to.equal('stack-123');
            expect(json.cause).to.be.an('object');
            expect(json.cause.message).to.equal('Database connection failed');
        });

        it('subclasses instantiate with correct default metadata and properties', () => {
            const cancel = new CancellationException('Aborted by user', {stackId: 's1'});
            expect(cancel.name).to.equal('CancellationException');
            expect(cancel.isCancellation).to.be.true;
            expect(cancel.retryable).to.be.false;

            const stepTimeout = new StepTimeoutException('step1', 500, {stackId: 's2'});
            expect(stepTimeout.name).to.equal('StepTimeoutException');
            expect(stepTimeout.isTimeout).to.be.true;
            expect(stepTimeout.timeoutMs).to.equal(500);

            const flowTimeout = new FlowTimeoutException('s3', 1000, 2, {namespace: 't1'});
            expect(flowTimeout.name).to.equal('FlowTimeoutException');
            expect(flowTimeout.isTimeout).to.be.true;
            expect(flowTimeout.timeoutMs).to.equal(1000);
            expect(flowTimeout.completedSteps).to.equal(2);

            const storageErr = new StorageAdapterException('save', 'disk full');
            expect(storageErr.name).to.equal('StorageAdapterException');
            expect(storageErr.operation).to.equal('save');

            const conflictErr = new CheckpointConflictException('s4', 2, 1);
            expect(conflictErr.name).to.equal('CheckpointConflictException');
            expect(conflictErr.currentRevision).to.equal(2);
            expect(conflictErr.attemptedRevision).to.equal(1);
            expect(conflictErr.expectedRevision).to.equal(2);
            expect(conflictErr.actualRevision).to.equal(1);

            const nsErr = new NamespaceMismatchException('nsA', 'nsB');
            expect(nsErr.name).to.equal('NamespaceMismatchException');
            expect(nsErr.expectedNamespace).to.equal('nsA');
            expect(nsErr.actualNamespace).to.equal('nsB');

            const verErr = new CheckpointVersionException(99);
            expect(verErr.name).to.equal('CheckpointVersionException');
            expect(verErr.version).to.equal(99);

            const valErr = new ValidationException([{field: 'email', message: 'invalid email'}]);
            expect(valErr.name).to.equal('ValidationException');
            expect(valErr.errors).to.have.length(1);
            expect((valErr as any).error[0].field).to.equal('email');
        });

        it('normalizeError normalizes various input formats into RivuletError', () => {
            // Already RivuletError - supplements empty metadata fields
            const fErr = new RivuletError('orig');
            const norm1 = normalizeError(fErr, {
                stackId: 'stk',
                namespace: 'tnt',
                workflowId: 'wf',
                stepName: 'stp',
                phase: 'action'
            });
            expect(norm1).to.equal(fErr);
            expect(norm1.stackId).to.equal('stk');
            expect(norm1.namespace).to.equal('tnt');
            expect(norm1.workflowId).to.equal('wf');
            expect(norm1.stepName).to.equal('stp');
            expect(norm1.phase).to.equal('action');

            // AbortError / cancelled string
            const abortErr = new Error('The task was cancelled');
            abortErr.name = 'AbortError';
            const norm2 = normalizeError(abortErr, {stepName: 's1'});
            expect(norm2).to.be.instanceOf(CancellationException);
            expect(norm2.isCancellation).to.be.true;

            // Validation array
            const valArr = [{field: 'age', message: 'must be > 18'}];
            const norm3 = normalizeError(valArr, {stepName: 's2'});
            expect(norm3).to.be.instanceOf(ValidationException);
            expect((norm3 as ValidationException).errors).to.deep.equal(valArr);

            // Plain Error
            const norm4 = normalizeError(new Error('plain boom'));
            expect(norm4).to.be.instanceOf(RivuletError);
            expect(norm4.message).to.equal('plain boom');

            // String
            const norm5 = normalizeError('string boom');
            expect(norm5.message).to.equal('string boom');

            // Plain non-error object
            const norm6 = normalizeError({custom: 123});
            expect(norm6.message).to.equal('Execution failed');
        });

        it('preserves metadata, stepName, and phase upon flow step rejection', async () => {
            const badStep = Step.create('failingStep')
                .onStart(() => {
                    throw new Error('Something broke inside step');
                });

            try {
                await flow(badStep).execute({}, {namespace: 'ns-1'});
                expect.fail('Flow should have rejected');
            } catch (err: any) {
                expect(err).to.be.instanceOf(RivuletError);
            expect(err).to.be.instanceOf(RivuletError);
                expect(err.stepName).to.equal('failingStep');
                expect(err.phase).to.equal('action');
                expect(err.namespace).to.equal('ns-1');
                expect(err.stackId).to.be.a('string');
                // backward compat
                expect(err.error.message).to.equal('Something broke inside step');
            }
        });
    });

    describe('Workstream 4: Retry, Timeout & Cancellation Contract', () => {
        it('retryIf predicate allows retry when true and aborts retry when false', async () => {
            let attempts = 0;
            const stepWithRetryIf = Step.create('retryIfStep')
                .onStart(() => {
                    attempts++;
                    const err: any = new Error(`Attempt ${attempts} failed`);
                    err.statusCode = attempts === 1 ? 503 : 400; // 503 retryable, 400 not
                    throw err;
                })
                .onFail({
                    maxRetries: 3,
                    delay: 5,
                    retryIf: (err: any) => err.statusCode === 503
                });

            try {
                await flow(stepWithRetryIf).execute();
                expect.fail('Should have failed after non-retryable 400');
            } catch (err: any) {
                expect(attempts).to.equal(2);
                expect(err.cause.statusCode).to.equal(400);
            }
        });

        it('non-retryable errors (retryable: false or ValidationException) are rejected without retries', async () => {
            let attempts = 0;
            const nonRetryableStep = Step.create('nonRetryable')
                .onStart(() => {
                    attempts++;
                    throw new RivuletError('Fatal config error', {retryable: false});
                })
                .onFail({
                    maxRetries: 3,
                    delay: 5
                });

            try {
                await flow(nonRetryableStep).execute();
                expect.fail('Should not retry non-retryable error');
            } catch (err: any) {
                expect(attempts).to.equal(1);
            }
        });

        it('supports linear backoff, custom backoff function, maxDelay, and deterministic randomFn jitter', async () => {
            const delaysObserved: number[] = [];
            let attempts = 0;

            const retryStep = Step.create('linearJitterStep')
                .modern()
                .onStart(() => {
                    attempts++;
                    if (attempts < 3) throw new Error(`Fail ${attempts}`);
                    return {success: true, attempts};
                })
                .onFail({
                    maxRetries: 3,
                    delay: 20,
                    backoff: 'linear',
                    jitter: true,
                    randomFn: () => 0.5,
                    onRetry: (_err, attempt, delayMs) => {
                        delaysObserved.push(delayMs ?? 0);
                    }
                });

            const res = await flow(retryStep).execute({}, {pojo: true});
            expect(res.success).to.be.true;
            expect(attempts).to.equal(3);
            // attempt 1: delay = 20 * 1 = 20, jitter = floor(20 * 0.5) = 10
            // attempt 2: delay = 20 * 2 = 40, jitter = floor(40 * 0.5) = 20
            expect(delaysObserved).to.deep.equal([10, 20]);
        });

        it('supports custom backoff and custom jitter functions', async () => {
            let attempts = 0;
            let observedJitterDelay = 0;

            const step = Step.create('customBackoffJitter')
                .modern()
                .onStart(() => {
                    attempts++;
                    if (attempts < 2) throw new Error('Fail once');
                    return {ok: true};
                })
                .onFail({
                    maxRetries: 2,
                    delay: 10,
                    backoff: (attempt) => attempt * 15,
                    jitter: (d) => {
                        observedJitterDelay = d + 5;
                        return observedJitterDelay;
                    }
                });

            const res = await flow(step).execute({}, {pojo: true});
            expect(res.ok).to.be.true;
            expect(attempts).to.equal(2);
            expect(observedJitterDelay).to.equal(20); // (1 * 15) + 5
        });

        it('tracks $attempt and $retryDelay on params during retries', async () => {
            const recordedAttempts: number[] = [];
            const recordedDelays: number[] = [];

            const step = Step.create('attemptTracking')
                .onStart((param: any) => {
                    const att = typeof param.$attempt === 'function' ? param.$attempt() : 0;
                    const del = typeof param.$retryDelay === 'function' ? param.$retryDelay() : 0;
                    recordedAttempts.push(att);
                    recordedDelays.push(del);

                    if (att < 2) throw new Error('Not ready');
                    return {ready: true};
                })
                .onFail({
                    maxRetries: 2,
                    delay: 10,
                    backoff: 'fixed'
                });

            await flow(step).execute({});
            expect(recordedAttempts).to.deep.equal([0, 1, 2]);
            expect(recordedDelays[1]).to.equal(10);
        });

        it('onFail callback can return fallback value or resolve promise as recovery', async () => {
            const stepWithFallback = Step.create('fallbackStep')
                .modern()
                .onStart(() => {
                    throw new Error('Primary call failed');
                })
                .onFail((_err: any) => {
                    return {recovered: true, source: 'fallback'};
                });

            const res = await flow(stepWithFallback).execute({}, {pojo: true});
            expect(res.recovered).to.be.true;
            expect(res.source).to.equal('fallback');

            // Async fallback
            const stepWithAsyncFallback = Step.create('asyncFallbackStep')
                .modern()
                .onStart(() => {
                    throw new Error('Primary async call failed');
                })
                .onFail(async () => {
                    return {asyncRecovered: true};
                });

            const resAsync = await flow(stepWithAsyncFallback).execute({}, {pojo: true});
            expect(resAsync.asyncRecovered).to.be.true;
        });

        it('stops retry if flow is cancelled during backoff delay', async () => {
            const controller = new AbortController();
            let attempts = 0;

            const step = Step.create('cancelRetryStep')
                .onStart(() => {
                    attempts++;
                    throw new Error('Fail');
                })
                .onFail({
                    maxRetries: 5,
                    delay: 200
                });

            setTimeout(() => {
                controller.abort();
            }, 50);

            try {
                await flow(step).execute({}, {signal: controller.signal});
                expect.fail('Should have been cancelled');
            } catch (err: any) {
                expect(err.isCancellation).to.be.true;
                expect(attempts).to.equal(1);
            }
        });
    });

    describe('Workstream 5: Cache Semantics & Stampede Protection', () => {
        it('cleans internal keys when generating cache keys', async () => {
            const cacheStore = new Map<string, any>();
            const adapter: StorageAdapter = {
                name: 'in-memory-adapter',
                async getCachedStep(key: string) {
                    return cacheStore.get(key);
                },
                async setCachedStep(key: string, val: any) {
                    cacheStore.set(key, val);
                }
            };
            Step.useStorage(adapter);

            try {
                let executions = 0;
                const cachedStep = Step.create('cleanKeyStep')
                    .modern()
                    .cache(1000)
                    .onStart((param: any) => {
                        executions++;
                        return {inputId: param.id, executions};
                    });

                const pipeline = flow(cachedStep);
                const res1 = await pipeline.execute({id: 100}, {pojo: true});
                // Second execution passes internal fields like $attempt, signal, props
                const res2 = await pipeline.execute({id: 100, $attempt: 2, props: {foo: 'bar'}} as any, {pojo: true});

                expect(executions).to.equal(1);
                expect(res1.executions).to.equal(1);
                expect(res2.executions).to.equal(1);
            } finally {
                Step.useStorage(undefined as any);
            }
        });

        it('protects against cache stampede by deduplicating concurrent in-flight promises', async () => {
            let executions = 0;
            const stampedeStep = Step.create('stampedeStep')
                .modern()
                .cache(2000)
                .onStart(async ({id}: any) => {
                    executions++;
                    await new Promise(r => setTimeout(r, 50));
                    return {id, executions};
                });

            const p = flow(stampedeStep);
            // Launch 3 concurrent executions simultaneously
            const [r1, r2, r3] = await Promise.all([
                p.execute({id: 'shared'}, {pojo: true}),
                p.execute({id: 'shared'}, {pojo: true}),
                p.execute({id: 'shared'}, {pojo: true})
            ]);

            expect(executions).to.equal(1);
            expect(r1.executions).to.equal(1);
            expect(r2.executions).to.equal(1);
            expect(r3.executions).to.equal(1);
        });

        it('supports disabling stampedeProtection via cache options', async () => {
            let executions = 0;
            const noStampedeStep = Step.create('noStampede')
                .modern()
                .cache({ttl: 2000, stampedeProtection: false})
                .onStart(async ({id}: any) => {
                    executions++;
                    await new Promise(r => setTimeout(r, 20));
                    return {id, executions};
                });

            const p = flow(noStampedeStep);
            await Promise.all([
                p.execute({id: 'x'}, {pojo: true}),
                p.execute({id: 'x'}, {pojo: true})
            ]);

            // Both started before cache was written
            expect(executions).to.equal(2);
        });

        it('supports custom keySerializer in CacheOptions and storage config', async () => {
            let executions = 0;
            const customSerializerStep = Step.create('customKeyStep')
                .modern()
                .cache({
                    ttl: 2000,
                    keySerializer: (stepId, param) => `${stepId}:custom:${param.category}`
                })
                .onStart((param: any) => {
                    executions++;
                    return {result: param.category, executions};
                });

            const p = flow(customSerializerStep, customSerializerStep);
            // Different IDs but same category -> same cache key!
            const res = await p.execute({id: 1, category: 'books'}, {pojo: true});

            expect(executions).to.equal(1);
            expect(res.executions).to.equal(1);
        });

        it('emits cache events for hits, misses, and SWR with adapter', async () => {
            const events: any[] = [];
            const adapterCache = new Map<string, any>();
            const mockAdapter: StorageAdapter = {
                name: 'mock',
                onCacheEvent: (e) => {
                    events.push(e);
                },
                getCachedStep: async (k) => adapterCache.get(k),
                setCachedStep: async (k, v) => {
                    adapterCache.set(k, v);
                }
            };
            defaultStorageManager.useStorage(mockAdapter);

            const cachedStep = Step.create('eventStep')
                .cache(500)
                .onStart(({x}: any) => (typeof x === 'function' ? x() : x) * 2);

            const p = flow(cachedStep);
            await p.execute({x: 5}, {namespace: 'ns-events'});
            await p.execute({x: 5}, {namespace: 'ns-events'});

            expect(events.length).to.be.at.least(2);
            expect(events[0].type).to.equal('miss');
            expect(events[0].namespace).to.equal('ns-events');
            expect(events[0].stackId).to.be.a('string');
            expect(events[1].type).to.equal('hit');
            expect(events[1].namespace).to.equal('ns-events');
            expect(events[1].stackId).to.be.a('string');
        });

        it('supports Stale-While-Revalidate (SWR) returning stale data while revalidating in background', async () => {
            let counter = 0;
            const stackId = 'swr-test-stack';
            const action = async () => ({counter: ++counter});

            const first = await cache(stackId, 'step1', {}, 40, action, undefined, {swr: 100});
            expect(first.counter).to.equal(1);

            // Wait 50ms: expired (40ms) but within SWR window (40 + 100 = 140ms)
            await new Promise(r => setTimeout(r, 50));

            const stale = cache(stackId, 'step1', {}, 40, action, undefined, {swr: 100});
            // Should immediately return stale cached value 1
            expect(stale.counter).to.equal(1);

            // Wait for background revalidation promise to complete
            await new Promise(r => setTimeout(r, 40));

            // Now cache should have updated to 2
            const fresh = cache(stackId, 'step1', {}, 40, action, undefined, {swr: 100});
            expect(fresh.counter).to.equal(2);
        });

        it('handles distributed cache adapter errors based on StorageErrorMode', async () => {
            const failingAdapter: StorageAdapter = {
                name: 'failing-adapter',
                getCachedStep: async () => {
                    throw new Error('Redis connection timed out');
                },
                setCachedStep: async () => {
                    throw new Error('Redis write failed');
                }
            };
            defaultStorageManager.useStorage(failingAdapter);

            const step = Step.create('adapterErrStep')
                .cache(1000)
                .onStart(({v}: any) => (typeof v === 'function' ? v() : v) + 1);

            // 1. Strict mode -> throws StorageAdapterException
            defaultStorageManager.setErrorMode('strict');
            try {
                await flow(step).execute({v: 10});
                expect.fail('Should have thrown in strict mode');
            } catch (err: any) {
                expect(err).to.be.instanceOf(StorageAdapterException);
                expect(err.operation).to.equal('getCachedStep');
            }

            // 2. Warn mode -> logs warning, continues execution
            defaultStorageManager.setErrorMode('warn');
            const warnRes = await flow(step).execute({v: 20}, {pojo: true});
            expect(warnRes.value).to.equal(21);

            // 3. Best-effort mode -> suppresses, continues execution
            defaultStorageManager.setErrorMode('best-effort');
            const bestRes = await flow(step).execute({v: 30}, {pojo: true});
            expect(bestRes.value).to.equal(31);
        });

        it('handles synchronous and rejected promise errors from setCachedStep', async () => {
            const syncThrowAdapter: StorageAdapter = {
                name: 'sync-throw-adapter',
                setCachedStep: () => {
                    throw new Error('Sync storage error');
                }
            };
            defaultStorageManager.useStorage(syncThrowAdapter);
            defaultStorageManager.setErrorMode('best-effort');

            const syncStep = Step.create('syncStep')
                .cache(1000)
                .onStart(({n}: any) => (typeof n === 'function' ? n() : n) * 2);

            const res1 = await flow(syncStep).execute({n: 4}, {pojo: true});
            expect(res1.value).to.equal(8);

            const rejectedPromiseAdapter: StorageAdapter = {
                name: 'rejected-promise-adapter',
                setCachedStep: () => Promise.reject(new Error('Async storage rejection'))
            };
            defaultStorageManager.useStorage(rejectedPromiseAdapter);

            const res2 = await flow(syncStep).execute({n: 5}, {pojo: true});
            expect(res2.value).to.equal(10);
        });
    });

    describe('Workstream 6: Checkpoint & Storage Reliability', () => {
        it('checkpoints produce version 2, schemaVersion 2.0.0, status, and revision', () => {
            const stackId = defaultStorageManager.createExecutionStack('ns-cp');
            defaultStorageManager.addChainToStack(stackId, 'step1');
            defaultStorageManager.putChainContext('step1', 'data', {hello: 'world'}, {stackId});

            const cp1 = defaultStorageManager.checkpoint(stackId, {workflowId: 'wf-test', status: 'completed'});
            expect(cp1.version).to.equal(2);
            expect(cp1.schemaVersion).to.equal('2.0.0');
            expect(cp1.revision).to.equal(1);
            expect(cp1.status).to.equal('completed');
            expect(cp1.namespace).to.equal('ns-cp');
            expect(cp1.workflowId).to.equal('wf-test');

            // Successive checkpoint increments revision
            const cp2 = defaultStorageManager.checkpoint(stackId);
            expect(cp2.revision).to.equal(2);
        });

        it('detects optimistic concurrency conflict and throws CheckpointConflictException', () => {
            const stackId = defaultStorageManager.createExecutionStack('t-occ');
            const cp1 = defaultStorageManager.checkpoint(stackId); // revision 1
            expect(cp1.revision).to.equal(1);

            expect(() => {
                defaultStorageManager.checkpoint(stackId, {expectedRevision: 99});
            }).to.throw(CheckpointConflictException);
        });

        it('enforces namespace isolation and throws NamespaceMismatchException on restore', () => {
            const stackId = defaultStorageManager.createExecutionStack('ns-alpha');
            const cp = defaultStorageManager.checkpoint(stackId);

            expect(() => {
                defaultStorageManager.restoreCheckpoint(cp, {expectedNamespace: 'ns-beta'});
            }).to.throw(NamespaceMismatchException);
        });

        it('rejects unsupported checkpoint versions with CheckpointVersionException', () => {
            const invalidCp: any = {
                version: 99,
                stackId: 'dummy',
                stack: [],
                contexts: {}
            };

            expect(() => {
                defaultStorageManager.restoreCheckpoint(invalidCp);
            }).to.throw(CheckpointVersionException);
        });

        it('redacts sensitive fields in checkpoint snapshots', () => {
            const stackId = defaultStorageManager.createExecutionStack('ns-sec');
            defaultStorageManager.addChainToStack(stackId, 'authStep');
            defaultStorageManager.putChainContext('authStep', 'credentials', {
                apiKey: 'super-secret-12345',
                token: 'bearer-abcdef',
                username: 'alice'
            }, {stackId});

            const cp = defaultStorageManager.checkpoint(stackId, {
                redactFields: ['apiKey', 'token']
            });

            const restoredCreds = cp.contexts['authStep'].credentials;
            expect(restoredCreds.apiKey).to.equal('[REDACTED]');
            expect(restoredCreds.token).to.equal('[REDACTED]');
            expect(restoredCreds.username).to.equal('alice');
        });

        it('supports checkpoint TTL and cleanExpiredCheckpoints removes expired records', async () => {
            let adapterCleanCalled = false;
            const mockAdapter: StorageAdapter = {
                name: 'mock',
                cleanExpiredCheckpoints: () => {
                    adapterCleanCalled = true;
                    return 1;
                }
            };
            defaultStorageManager.useStorage(mockAdapter);

            const stackId = defaultStorageManager.createExecutionStack('ns-exp');
            defaultStorageManager.checkpoint(stackId, {ttlMs: 20});

            // Not yet expired
            expect(cleanExpiredCheckpoints()).to.equal(0);

            // Wait for TTL expiration
            await new Promise(r => setTimeout(r, 35));

            const cleaned = cleanExpiredCheckpoints();
            expect(cleaned).to.equal(1);
            expect(adapterCleanCalled).to.equal(true);
        });

        it('handles storage adapter failures in saveCheckpoint according to error mode', async () => {
            const errorAdapter: StorageAdapter = {
                name: 'error-adapter',
                saveCheckpoint: () => {
                    throw new Error('DB connection closed');
                }
            };
            defaultStorageManager.useStorage(errorAdapter);
            const stackId = defaultStorageManager.createExecutionStack();

            // Strict mode throws
            defaultStorageManager.setErrorMode('strict');
            expect(() => {
                defaultStorageManager.checkpoint(stackId);
            }).to.throw(StorageAdapterException);

            // Warn mode logs and continues
            defaultStorageManager.setErrorMode('warn');
            const cpWarn = defaultStorageManager.checkpoint(stackId);
            expect(cpWarn).to.be.an('object');

            // Best effort ignores
            defaultStorageManager.setErrorMode('best-effort');
            const cpBest = defaultStorageManager.checkpoint(stackId);
            expect(cpBest).to.be.an('object');
        });
        it("covers additional edge cases for 100% coverage", async () => {
            // 1. StartChain onBefore failure recovery via onFail
            const stepBeforeFail = Step.create("beforeFailRecover")
                .onBefore(() => {
                    throw new Error("before failed");
                })
                .onFail((_err: any) => ({recovered: true}));
            const resBefore = await flow(stepBeforeFail).execute({}, {pojo: true});
            expect(resBefore.recovered).to.equal(true);

            // 2. OnFail retryFn with fallback
            const stepRetryFallback = Step.create("retryFallback").modern()
                .onStart(() => {
                    throw new Error("fail");
                })
                .onFail((_err: any, retry: any) => {
                    retry({custom: "val"});
                });
            const resFallback = await flow(stepRetryFallback).execute();
            expect(resFallback.custom()).to.equal("val");

            // 3. OnFail function throws synchronously
            const stepFailThrows = Step.create("onFailThrows")
                .onStart(() => {
                    throw new Error("fail");
                })
                .onFail(() => {
                    throw new Error("sync throw in onFail");
                });
            try {
                await flow(stepFailThrows).execute();
                expect.fail("Should have failed");
            } catch (err: any) {
                expect(err.message).to.equal("sync throw in onFail");
            }

            // 4. Cache adapter.setCachedStep async rejection and sync exception handling
            const faultyAsyncAdapter: StorageAdapter = {
                name: "faulty-async-cache",
                async setCachedStep() {
                    throw new Error("async setCachedStep error");
                }
            };
            defaultStorageManager.useStorage(faultyAsyncAdapter);
            const asyncStep = Step.create("asyncCacheFail")
                .modern()
                .cache(1000)
                .onStart(async () => ({ok: 1}));
            const rAsync = await flow(asyncStep).execute({}, {pojo: true});
            expect(rAsync.ok).to.equal(1);

            const faultySyncAdapter: StorageAdapter = {
                name: "faulty-sync-cache",
                setCachedStep() {
                    throw new Error("sync setCachedStep error");
                }
            };
            defaultStorageManager.useStorage(faultySyncAdapter);
            const syncStep = Step.create("syncCacheFail")
                .modern()
                .cache(1000)
                .onStart(() => ({ok: 2}));
            const rSync = await flow(syncStep).execute({}, {pojo: true});
            expect(rSync.ok).to.equal(2);
            defaultStorageManager.useStorage(undefined as any);

            // 5. Checkpoint top-level field redaction
            const stackIdRedact = defaultStorageManager.createExecutionStack("t-top");
            defaultStorageManager.addChainToStack(stackIdRedact, "step-top");
            defaultStorageManager.putChainContext("step-top", "secretToken", "12345", {stackId: stackIdRedact});
            const cpTop = defaultStorageManager.checkpoint(stackIdRedact, {redactFields: ["secretToken"]});
            expect(cpTop.contexts["step-top"].secretToken).to.equal("[REDACTED]");

            // 6. Checkpoint async saveCheckpoint rejection handling
            const adapterAsyncSave: StorageAdapter = {
                name: "async-save-reject",
                async saveCheckpoint() {
                    throw new Error("saveCheckpoint async error");
                }
            };
            defaultStorageManager.useStorage(adapterAsyncSave);
            defaultStorageManager.setErrorMode("best-effort");
            const stackIdSave = defaultStorageManager.createExecutionStack("t-save");
            const cpAsync = defaultStorageManager.checkpoint(stackIdSave);
            expect(cpAsync).to.be.an("object");

            // 7. saveCheckpoint direct call, conflict handling, and error handling
            await defaultStorageManager.saveCheckpoint({
                version: 2,
                schemaVersion: "2.0.0",
                stackId: stackIdSave,
                revision: 10,
                type: "execution",
                status: "completed",
                chains: [],
                contexts: {},
                timestamp: Date.now()
            });

            // Invalid checkpoint data throws
            try {
                await defaultStorageManager.saveCheckpoint(null as any);
                expect.fail("Should have failed");
            } catch (err: any) {
                expect(err.message).to.equal("Invalid checkpoint data.");
            }

            // Conflict handling in saveCheckpoint with strict mode
            defaultStorageManager.setErrorMode("strict");
            try {
                await defaultStorageManager.saveCheckpoint({
                    version: 2,
                    schemaVersion: "2.0.0",
                    stackId: stackIdSave,
                    revision: 5,
                    type: "execution",
                    status: "completed",
                    chains: [],
                    contexts: {},
                    timestamp: Date.now()
                });
                expect.fail("Should have thrown conflict");
            } catch (err: any) {
                expect(err).to.be.instanceOf(StorageAdapterException);
            }

            // Adapter throws in saveCheckpoint
            const adapterThrowSave: StorageAdapter = {
                name: "save-throws",
                async saveCheckpoint() {
                    throw new Error("save failed in adapter");
                }
            };
            defaultStorageManager.useStorage(adapterThrowSave);
            try {
                await defaultStorageManager.saveCheckpoint({
                    version: 2,
                    schemaVersion: "2.0.0",
                    stackId: stackIdSave,
                    revision: 15,
                    type: "execution",
                    status: "completed",
                    chains: [],
                    contexts: {},
                    timestamp: Date.now()
                });
                expect.fail("Should have thrown adapter exception");
            } catch (err: any) {
                expect(err).to.be.instanceOf(StorageAdapterException);
            }

            defaultStorageManager.setErrorMode("best-effort");
            defaultStorageManager.useStorage(undefined as any);

            // 8. StorageManager options.errorMode and onCacheEvent / cleanExpiredCheckpoints edge cases
            const customSm = new StorageManager(undefined, {errorMode: "strict"});
            expect(customSm.getErrorMode()).to.equal("strict");

            const faultyCacheEventAdapterAsync: StorageAdapter = {
                name: "event-async-fail",
                async onCacheEvent() {
                    throw new Error("onCacheEvent async fail");
                }
            };
            customSm.useStorage(faultyCacheEventAdapterAsync);
            customSm.setErrorMode("best-effort");
            customSm.emitCacheEvent({type: "hit", key: "k1", stepId: '', timestamp: 1, namespace: 'ns1'});

            const faultyCacheEventAdapterSync: StorageAdapter = {
                name: "event-sync-fail",
                onCacheEvent() {
                    throw new Error("onCacheEvent sync fail");
                }
            };
            customSm.useStorage(faultyCacheEventAdapterSync);
            customSm.emitCacheEvent({type: "miss", key: "k2", stepId: '', timestamp: 1, namespace: 'ns1'});

            const faultyCleanAdapterAsync: StorageAdapter = {
                name: "clean-async-fail",
                async cleanExpiredCheckpoints() {
                    throw new Error("clean async fail");
                }
            };
            customSm.useStorage(faultyCleanAdapterAsync);
            customSm.cleanExpiredCheckpoints();

            const faultyCleanAdapterSync: StorageAdapter = {
                name: "clean-sync-fail",
                cleanExpiredCheckpoints() {
                    throw new Error("clean sync fail");
                }
            };
            customSm.useStorage(faultyCleanAdapterSync);
            customSm.cleanExpiredCheckpoints();

            // 9. SWR background revalidation calling adapter.setCachedStep and handling errors
            let swrSetCalled = false;
            const swrAdapter: StorageAdapter = {
                name: "swr-adapter",
                async setCachedStep() {
                    swrSetCalled = true;
                }
            };
            defaultStorageManager.useStorage(swrAdapter);
            const stackIdSwr = "swr-stack-direct";
            cache(stackIdSwr, "swr-step-direct", {id: 1}, 10, () => ({val: 1}), undefined, {staleWhileRevalidate: 200});
            await new Promise(r => setTimeout(r, 15));
            cache(stackIdSwr, "swr-step-direct", {id: 1}, 10, async () => ({val: 2}), undefined, {staleWhileRevalidate: 200});
            await new Promise(r => setTimeout(r, 20));
            expect(swrSetCalled).to.equal(true);

            // SWR background revalidation adapter.setCachedStep throws
            const swrFailAdapter: StorageAdapter = {
                name: "swr-fail-adapter",
                async setCachedStep() {
                    throw new Error("setCachedStep failed in SWR");
                }
            };
            defaultStorageManager.useStorage(swrFailAdapter);
            const stackIdSwrAdapterFail = "swr-adapter-fail-stack";
            cache(stackIdSwrAdapterFail, "swr-step-fail", {id: 10}, 10, () => ({val: 10}), undefined, {staleWhileRevalidate: 200});
            await new Promise(r => setTimeout(r, 15));
            cache(stackIdSwrAdapterFail, "swr-step-fail", {id: 10}, 10, async () => ({val: 20}), undefined, {staleWhileRevalidate: 200});
            await new Promise(r => setTimeout(r, 20));

            // SWR background revalidation failure handled silently
            const stackIdSwrFail = "swr-stack-fail";
            cache(stackIdSwrFail, "swr-fail", {id: 2}, 10, () => ({ok: 1}), undefined, {staleWhileRevalidate: 200});
            await new Promise(r => setTimeout(r, 15));
            cache(stackIdSwrFail, "swr-fail", {id: 2}, 10, async () => {
                throw new Error("swr fail");
            }, undefined, {staleWhileRevalidate: 200});
            await new Promise(r => setTimeout(r, 20));

            // Strict mode sync step fire-and-forget rejection
            defaultStorageManager.setErrorMode("strict");
            const syncRejectAdapter: StorageAdapter = {
                name: "sync-reject",
                async setCachedStep() {
                    throw new Error("async fail on sync step");
                }
            };
            defaultStorageManager.useStorage(syncRejectAdapter);
            cache("stack-sync", "sync-step", {}, 1000, () => ({sync: true}));
            await new Promise(r => setTimeout(r, 20));
            defaultStorageManager.setErrorMode("best-effort");
            defaultStorageManager.useStorage(undefined as any);

            // 10. OnFail outerSignal aborted, FlowTimeoutException, and CancellationException
            let signalRejected = false;
            const abortController = new AbortController();
            abortController.abort(new Error("Manual abort"));
            new OnFail(
                {name: "test"} as any,
                new Error("err"),
                () => {
                },
                (_err: any) => {
                    signalRejected = true;
                },
                {} as any,
                {},
                "test",
                () => {
                },
                () => {
                },
                undefined,
                undefined,
                {outerSignal: abortController.signal}
            );
            expect(signalRejected).to.equal(true);

            let timeoutRejected = false;
            new OnFail(
                {name: "test"} as any,
                new FlowTimeoutException("s1", 1000, 1),
                () => {
                },
                (_err: any) => {
                    timeoutRejected = true;
                },
                {} as any,
                {},
                "test",
                () => {
                },
                () => {
                },
                undefined,
                undefined,
                {}
            );
            expect(timeoutRejected).to.equal(true);

            let cancelRejected = false;
            new OnFail(
                {name: "test"} as any,
                new CancellationException("cancelled"),
                () => {
                },
                (_err: any) => {
                    cancelRejected = true;
                },
                {} as any,
                {},
                "test",
                () => {
                },
                () => {
                },
                undefined,
                undefined,
                {}
            );
            expect(cancelRejected).to.equal(true);

        });

    });
});
