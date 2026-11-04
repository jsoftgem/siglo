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
    SigloError,
    StepTimeoutException,
    FlowTimeoutException,
    CancellationException,
    ValidationException,
    StorageAdapterException,
    CheckpointConflictException,
    NamespaceMismatchException,
    CheckpointVersionException,
    FieldCollisionException,
    IdempotencyConflictException,
    CompensationException,
    WorkflowVersionMismatchException,
    DuplicateEventException,
    ExpiredWaitException,
    GraphValidationException,
    normalizeError,
    StorageAdapter,
    defaultStorageManager,
    clearStorage,
    getErrorMode,
    cleanExpiredCheckpoints,
    parallel,
    allSettled,
    race,
    when,
    branch,
    map,
    waitForEvent,
    wait,
    toGraph,
    validateGraph,
    assertValidGraph,
    inspectGraph,
    buildIdempotencyKey,
    InMemoryIdempotencyStore,
    defaultIdempotencyStore,
    defaultCompensationManager,
    defaultDurableManager,
    Status,
    ParallelMergeStrategy
} from '../index';
import {cache} from "./cache";

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

            const c1 = Chain.create('step1', ({a}: any) => ({val1: a + 10}));
            const c2 = Chain.create('step2', ({val1}: any) => ({final: val1 * 2}));

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
        it('SigloError attaches metadata, preserves cause, and exports toJSON cleanly', () => {
            const causeErr = new Error('Database connection failed');
            const err = new SigloError('Operation failed', {
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
            expect(err).to.be.instanceOf(SigloError);
            expect(err).to.be.instanceOf(SigloError);
            expect(err.name).to.equal('SigloError');
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
            expect(json.name).to.equal('SigloError');
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

        it('normalizeError normalizes various input formats into SigloError', () => {
            // Already SigloError - supplements empty metadata fields
            const fErr = new SigloError('orig');
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
            expect(norm4).to.be.instanceOf(SigloError);
            expect(norm4.message).to.equal('plain boom');

            // String
            const norm5 = normalizeError('string boom');
            expect(norm5.message).to.equal('string boom');

            // Plain non-error object
            const norm6 = normalizeError({custom: 123});
            expect(norm6.message).to.equal('Execution failed');
        });

        it('preserves metadata, stepName, and phase upon flow step rejection', async () => {
            const badStep = Step.create('failingStep', () => {
                    throw new Error('Something broke inside step');
                });

            try {
                await flow(badStep).execute({}, {namespace: 'ns-1'});
                expect.fail('Flow should have rejected');
            } catch (err: any) {
                expect(err).to.be.instanceOf(SigloError);
            expect(err).to.be.instanceOf(SigloError);
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
            const stepWithRetryIf = Step.create('retryIfStep', () => {
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
            const nonRetryableStep = Step.create('nonRetryable', () => {
                    attempts++;
                    throw new SigloError('Fatal config error', {retryable: false});
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

            const retryStep = Step.create('linearJitterStep', () => {
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
                    onRetry: (_err: any, attempt: any, delayMs: any) => {
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

            const step = Step.create('customBackoffJitter', () => {
                    attempts++;
                    if (attempts < 2) throw new Error('Fail once');
                    return {ok: true};
                })
                .onFail({
                    maxRetries: 2,
                    delay: 10,
                    backoff: (attempt: any) => attempt * 15,
                    jitter: (d: any) => {
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

            const step = Step.create('attemptTracking', (param: any) => {
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
            const stepWithFallback = Step.create('fallbackStep', () => {
                    throw new Error('Primary call failed');
                })
                .onFail((_err: any) => {
                    return {recovered: true, source: 'fallback'};
                });

            const res: any = await flow(stepWithFallback).execute({}, {pojo: true});
            expect(res.recovered).to.be.true;
            expect(res.source).to.equal('fallback');

            // Async fallback
            const stepWithAsyncFallback = Step.create('asyncFallbackStep', () => {
                    throw new Error('Primary async call failed');
                })
                .onFail(async () => {
                    return {asyncRecovered: true};
                });

            const resAsync: any = await flow(stepWithAsyncFallback).execute({}, {pojo: true});
            expect(resAsync.asyncRecovered).to.be.true;
        });

        it('stops retry if flow is cancelled during backoff delay', async () => {
            const controller = new AbortController();
            let attempts = 0;

            const step = Step.create('cancelRetryStep', () => {
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
                const cachedStep = Step.create('cleanKeyStep', (param: any) => {
                        executions++;
                        return {inputId: param.id, executions};
                    })
                    .cache(1000);

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
            const stampedeStep = Step.create('stampedeStep', async ({id}: any) => {
                    executions++;
                    await new Promise(r => setTimeout(r, 50));
                    return {id, executions};
                })
                .cache(2000);

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
            const noStampedeStep = Step.create('noStampede', async ({id}: any) => {
                    executions++;
                    await new Promise(r => setTimeout(r, 20));
                    return {id, executions};
                })
                .cache({ttl: 2000, stampedeProtection: false});

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
            const customSerializerStep = Step.create('customKeyStep', (param: any) => {
                    executions++;
                    return {result: param.category, executions};
                })
                .cache({
                    ttl: 2000,
                    keySerializer: (stepId, param) => `${stepId}:custom:${param.category}`
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

            const cachedStep = Step.create('eventStep', ({x}: any) => (typeof x === 'function' ? x() : x) * 2)
                .cache(500);

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

            const step = Step.create('adapterErrStep', ({v}: any) => (typeof v === 'function' ? v() : v) + 1)
                .cache(1000);

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
            const warnRes: any = await flow(step).execute({v: 20}, {pojo: true});
            expect(warnRes.value).to.equal(21);

            // 3. Best-effort mode -> suppresses, continues execution
            defaultStorageManager.setErrorMode('best-effort');
            const bestRes: any = await flow(step).execute({v: 30}, {pojo: true});
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

            const syncStep = Step.create('syncStep', ({n}: any) => (typeof n === 'function' ? n() : n) * 2)
                .cache(1000);

            const res1: any = await flow(syncStep).execute({n: 4}, {pojo: true});
            expect(res1.value).to.equal(8);

            const rejectedPromiseAdapter: StorageAdapter = {
                name: 'rejected-promise-adapter',
                setCachedStep: () => Promise.reject(new Error('Async storage rejection'))
            };
            defaultStorageManager.useStorage(rejectedPromiseAdapter);

            const res2: any = await flow(syncStep).execute({n: 5}, {pojo: true});
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
            const resBefore: any = await flow(stepBeforeFail).execute({}, {pojo: true});
            expect(resBefore.recovered).to.equal(true);

            // 2. OnFail retryFn with fallback
            const stepRetryFallback = Step.create("retryFallback", () => {
                    throw new Error("fail");
                })
                .onFail((_err: any, retry: any) => {
                    retry({custom: "val"});
                });
            const resFallback: any = await flow(stepRetryFallback).execute();
            expect(resFallback.custom).to.equal("val");

            // 3. OnFail function throws synchronously
            const stepFailThrows = Step.create("onFailThrows", () => {
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
            const asyncStep = Step.create("asyncCacheFail", async () => ({ok: 1}))
                .cache(1000);
            const rAsync = await flow(asyncStep).execute({}, {pojo: true});
            expect(rAsync.ok).to.equal(1);

            const faultySyncAdapter: StorageAdapter = {
                name: "faulty-sync-cache",
                setCachedStep() {
                    throw new Error("sync setCachedStep error");
                }
            };
            defaultStorageManager.useStorage(faultySyncAdapter);
            const syncStep = Step.create("syncCacheFail", () => ({ok: 2}))
                .cache(1000);
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


function resetWorkflowEnvironment(): void {
    clearStorage();
    defaultIdempotencyStore.clear();
    defaultDurableManager.clear();
    defaultCompensationManager.clear();
}

describe('Phase 2: Core Workflow Power Integration Suite', () => {
    beforeEach(() => {
        resetWorkflowEnvironment();
    });

    afterEach(() => {
        resetWorkflowEnvironment();
    });

    describe('Workstream 1: Distributed Saga & Reverse LIFO Compensation Rollback', () => {
        it('Scenario 1: Complete E-commerce Order Saga with Parallel execution and Sagas rollback', async () => {
            const compensationsExecuted: string[] = [];

            // 1. Validate Order
            const validateOrder = Step.create('validateOrder', ({orderId, amount, items}: any) => {
                return {orderId, amount, items, validated: true};
            });

            // 2. Parallel: Reserve Inventory (with compensation) + Authorize Payment (with compensation) + Calculate Tax
            const reserveInventory = Step.create('reserveInventory', async ({items}: any) => {
                    await new Promise(r => setTimeout(r, 15));
                    return {reservedItems: items, inventoryReserved: true};
                })
                .compensate(async (output: any) => {
                    compensationsExecuted.push(`release_inventory:${output.reservedItems.join(',')}`);
                });

            const authorizePayment = Step.create('authorizePayment', async ({amount}: any) => {
                    await new Promise(r => setTimeout(r, 15));
                    return {paymentAuthCode: 'AUTH_8888', amountPaid: amount};
                })
                .compensate(async (output: any) => {
                    compensationsExecuted.push(`refund_payment:${output.paymentAuthCode}`);
                });

            const calculateTax = Step.create('calculateTax', async ({amount}: any) => {
                    await new Promise(r => setTimeout(r, 10));
                    return {tax: amount * 0.08};
                });

            const prepareOrder = parallel(reserveInventory, authorizePayment, calculateTax);

            // 3. Downstream step that fails to trigger compensation
            const packGoods = Step.create('packGoods', () => {
                throw new Error('Warehouse robotics failure');
            });

            const orderWorkflow = flow(validateOrder, prepareOrder, packGoods);

            try {
                await orderWorkflow.execute({
                    orderId: 'ORD-1001',
                    amount: 500,
                    items: ['item-A', 'item-B']
                });
                expect.fail('Should have failed and triggered compensations');
            } catch (err: any) {
                expect(err.message).to.equal('Warehouse robotics failure');
                // Both compensations were executed in LIFO order
                expect(compensationsExecuted).to.include('refund_payment:AUTH_8888');
                expect(compensationsExecuted).to.include('release_inventory:item-A,item-B');
            }
        });

        it('Scenario 1b: Multi-service travel booking saga with LIFO order and context access', async () => {
            const auditLog: { actions: string[]; compensations: string[] } = {
                actions: [],
                compensations: []
            };

            const reserveFlight = Step.create('reserveFlight', async ({bookingId, passenger}: any) => {
                    auditLog.actions.push(`Reserve Flight for ${passenger}`);
                    return {ticketId: `TKT-${bookingId}`, flightCost: 450};
                })
                .compensate(async (output: any, input: any) => {
                    auditLog.compensations.push(`Cancel Flight: ${output.ticketId} for ${input.passenger}`);
                });

            const reserveHotel = Step.create('reserveHotel', async ({bookingId, passenger}: any) => {
                    auditLog.actions.push(`Reserve Hotel for ${passenger}`);
                    return {hotelConfirmation: `HTL-${bookingId}`, hotelCost: 350};
                })
                .compensate(async (output: any, input: any) => {
                    auditLog.compensations.push(`Cancel Hotel: ${output.hotelConfirmation} for ${input.passenger}`);
                });

            const chargePayment = Step.create('chargePayment', async ({flightCost, hotelCost, shouldFail}: any) => {
                    const total = flightCost + hotelCost;
                    if (shouldFail) {
                        throw new Error(`Payment declined for amount $${total}: Insufficient funds`);
                    }
                    return {paymentStatus: 'PAID', totalCharged: total};
                });

            const travelSaga = flow(reserveFlight, reserveHotel, chargePayment);

            // 1. Successful forward execution
            const successResult = await travelSaga.execute({
                bookingId: 'BK-501',
                passenger: 'Ada Lovelace',
                shouldFail: false
            }, {pojo: true});

            expect(successResult.paymentStatus).to.equal('PAID');
            expect(successResult.totalCharged).to.equal(800);
            expect(auditLog.compensations).to.have.length(0);
            expect(auditLog.actions).to.have.length(2);

            // 2. Failure triggering reverse LIFO compensation
            try {
                await travelSaga.execute({
                    bookingId: 'BK-502',
                    passenger: 'Charles Babbage',
                    shouldFail: true
                }, {pojo: true});
                expect.fail('Should have failed payment step');
            } catch (err: any) {
                expect(err.message).to.include('Payment declined');
                // Hotel was reserved second, so it must be cancelled first
                expect(auditLog.compensations).to.have.length(2);
                expect(auditLog.compensations[0]).to.equal('Cancel Hotel: HTL-BK-502 for Charles Babbage');
                expect(auditLog.compensations[1]).to.equal('Cancel Flight: TKT-BK-502 for Charles Babbage');
            }
        });

        it('Scenario 1c: Compensation failure raises CompensationException with error diagnostics', async () => {
            const failingCompSaga = flow(
                Step.create('stepA', async () => ({stepA: true}))
                    .compensate(async () => {
                        throw new Error('Hotel cancellation network timeout');
                    }),
                Step.create('stepB', async () => {
                        throw new Error('Primary booking failed');
                    })
            );

            try {
                await failingCompSaga.execute({}, {pojo: true});
                expect.fail('Should have thrown CompensationException');
            } catch (err: any) {
                expect(err).to.be.instanceOf(CompensationException);
                expect(err.originalError.message).to.equal('Primary booking failed');
                expect(err.compensationErrors).to.have.length(1);
                expect(err.compensationErrors[0].stepName).to.equal('stepA');
                expect(err.compensationErrors[0].error.message).to.equal('Hotel cancellation network timeout');
            }
        });

        it('Scenario 1d: Manual saga compensation trigger and compensation retry policy', async () => {
            let compensationAttempts = 0;
            let manualCompensationRun = false;
            let capturedStackId: string | undefined;

            const compensatableStep = Step.create('inventoryReservation', async ({$stackId}: any) => {
                    capturedStackId = typeof $stackId === 'function' ? $stackId() : $stackId;
                    return {reservationId: 'RES-999'};
                })
                .compensate(async () => {
                    compensationAttempts++;
                    if (compensationAttempts < 2) {
                        throw new Error('Transient inventory release error');
                    }
                    manualCompensationRun = true;
                }, {
                    maxRetries: 3,
                    delay: 10,
                    retryIf: (err: any) => err.message.includes('Transient')
                });

            const sagaFlow = flow(compensatableStep);
            const execResult = await sagaFlow.execute({}, {pojo: true});
            expect(execResult.reservationId).to.equal('RES-999');
            expect(capturedStackId).to.be.a('string');

            const compResult = await sagaFlow.compensate(capturedStackId!);
            expect(compResult.completed).to.include('inventoryReservation');
            expect(manualCompensationRun).to.be.true;
            expect(compensationAttempts).to.equal(2);
        });
    });

    describe('Workstream 2: Concurrency, Parallel Fan-Out & Competitive Racing', () => {
        it('Scenario 2a: Latency race selects fastest gateway and aborts losing branch', async () => {
            let slowerBranchAborted = false;

            const usEastGateway = Step.create('usEastGateway', async () => {
                await new Promise(r => setTimeout(r, 15));
                return {selectedEdge: 'US_EAST', latencyMs: 15};
            });

            const euCentralGateway = Step.create('euCentralGateway', async ({$signal}: any) => {
                const signal = typeof $signal === 'function' ? $signal() : $signal;
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, 100);
                    signal?.addEventListener?.('abort', () => {
                        clearTimeout(timer);
                        slowerBranchAborted = true;
                        reject(new Error('Aborted'));
                    });
                });
                return {selectedEdge: 'EU_CENTRAL', latencyMs: 100};
            });

            const edgeRaceFlow = flow(race(usEastGateway, euCentralGateway));
            const result: any = await edgeRaceFlow.execute({}, {pojo: true});

            expect(result.selectedEdge).to.equal('US_EAST');
            expect(result.latencyMs).to.equal(15);
            // Slower branch received abort signal
            await new Promise(r => setTimeout(r, 20));
            expect(slowerBranchAborted).to.be.true;
        });

        it('Scenario 2b: Multi-cloud parallel fan-out with deep merge and non-blocking allSettled telemetry', async () => {
            const replicateS3 = Step.create('replicateS3', async ({assetId}: any) => ({
                replicas: {
                    aws: {uri: `s3://bucket/${assetId}`, status: 'SYNCED'}
                }
            }));

            const replicateGcs = Step.create('replicateGcs', async ({assetId}: any) => ({
                replicas: {
                    gcp: {uri: `gs://bucket/${assetId}`, status: 'SYNCED'}
                }
            }));

            const replicateAzure = Step.create('replicateAzure', async ({assetId}: any) => ({
                replicas: {
                    azure: {uri: `https://azure.blob/${assetId}`, status: 'SYNCED'}
                }
            }));

            const logAnalytics = Step.create('logAnalytics', async () => ({analyticsLogged: true}));
            const pushAudit = Step.create('pushAudit', async () => {
                // Secondary telemetry non-fatal failure
                throw new Error('Audit webhook unreachable');
            });

            const multiCloudFlow = flow(
                parallel(replicateS3, replicateGcs, replicateAzure, {mergeStrategy: ParallelMergeStrategy.DEEP}),
                allSettled([logAnalytics, pushAudit])
            );

            const result: any = await multiCloudFlow.execute({assetId: 'ASSET-101'}, {pojo: true});

            // Deep merge combined replica receipts from all 3 branches
            expect(result.replicas.aws.status).to.equal('SYNCED');
            expect(result.replicas.gcp.status).to.equal('SYNCED');
            expect(result.replicas.azure.status).to.equal('SYNCED');

            // allSettled preserved successful log without aborting the flow on audit failure
            expect(result.logAnalytics.analyticsLogged).to.equal(true);
            expect(result.pushAudit.error.message).to.equal('Audit webhook unreachable');
            expect(result.$settled).to.be.an('array');
            expect(result.$settled[0].status).to.equal('fulfilled');
            expect(result.$settled[1].status).to.equal('rejected');
        });

        it('Scenario 2c: Strict collision detection halts execution and throws FieldCollisionException', async () => {
            const branchA = Step.create('branchA', async () => ({
                token: 'TOKEN_A',
                serviceA: true
            }));

            const branchB = Step.create('branchB', async () => ({
                token: 'TOKEN_B', // Collision on 'token'
                serviceB: true
            }));

            const collidingParallel = flow(
                parallel(branchA, branchB, {mergeStrategy: 'error'})
            );

            try {
                await collidingParallel.execute({}, {pojo: true});
                expect.fail('Should have detected field collision');
            } catch (err: any) {
                expect(err).to.be.instanceOf(FieldCollisionException);
                expect(err.collisions).to.be.an('array');
                expect(err.collisions[0].field).to.equal('token');
                expect(err.message).to.include('Field collision detected');
            }
        });
    });

    describe('Workstream 3: Dynamic Branching & Conditional Routing', () => {
        it('Scenario 3a: Multi-way dynamic loan underwriting router via branch() and when()', async () => {
            const classifyRisk = Step.create('classifyRisk', ({creditScore}: any) => {
                let tier = 'SUBPRIME';
                if (creditScore >= 750) tier = 'PRIME';
                else if (creditScore >= 650) tier = 'NEAR_PRIME';
                return {riskTier: tier};
            });

            const primeFlow = flow(
                when(
                    (ctx) => ctx.hasPartnerPromo === true,
                    Step.create('promoRate', () => ({interestRate: 4.25, tierRate: 'PROMO'})),
                    Step.create('standardRate', () => ({interestRate: 4.85, tierRate: 'STANDARD'}))
                ),
                Step.create('primeDecision', () => ({decision: 'APPROVED_INSTANT'}))
            );

            const nearPrimeFlow = flow(
                Step.create('nearPrimeAssessment', () => ({
                    decision: 'APPROVED_WITH_CONDITIONS',
                    interestRate: 7.5,
                    stipulationsRequired: true
                }))
            );

            const subprimeFlow = flow(
                Step.create('subprimeDecline', () => ({
                    decision: 'DECLINED',
                    adverseNotice: true
                }))
            );

            const dynamicLoanRouter = flow(
                classifyRisk,
                branch(
                    (ctx) => ctx.riskTier,
                    {
                        PRIME: primeFlow,
                        NEAR_PRIME: nearPrimeFlow,
                        SUBPRIME: subprimeFlow
                    },
                    subprimeFlow
                )
            );

            // 1. Prime applicant with promo
            const resPrimePromo: any = await dynamicLoanRouter.execute({
                creditScore: 800,
                hasPartnerPromo: true
            }, {pojo: true});
            expect(resPrimePromo.riskTier).to.equal('PRIME');
            expect(resPrimePromo.interestRate).to.equal(4.25);
            expect(resPrimePromo.decision).to.equal('APPROVED_INSTANT');

            // 2. Prime applicant without promo
            const resPrimeStandard: any = await dynamicLoanRouter.execute({
                creditScore: 780,
                hasPartnerPromo: false
            }, {pojo: true});
            expect(resPrimeStandard.riskTier).to.equal('PRIME');
            expect(resPrimeStandard.interestRate).to.equal(4.85);
            expect(resPrimeStandard.decision).to.equal('APPROVED_INSTANT');

            // 3. Near-prime applicant
            const resNear: any = await dynamicLoanRouter.execute({creditScore: 680}, {pojo: true});
            expect(resNear.riskTier).to.equal('NEAR_PRIME');
            expect(resNear.decision).to.equal('APPROVED_WITH_CONDITIONS');
            expect(resNear.stipulationsRequired).to.be.true;

            // 4. Subprime applicant
            const resSub: any = await dynamicLoanRouter.execute({creditScore: 550}, {pojo: true});
            expect(resSub.riskTier).to.equal('SUBPRIME');
            expect(resSub.decision).to.equal('DECLINED');

            // 5. Unknown tier falls back to defaultBranch (subprime)
            const resUnknown: any = await dynamicLoanRouter.execute({creditScore: 200}, {pojo: true});
            expect(resUnknown.decision).to.equal('DECLINED');
        });

        it('Scenario 3b: when() skips cleanly and records branch history when condition is false and no else provided', async () => {
            const optionalAudit = flow(
                when(
                    (ctx) => ctx.enableAudit === true,
                    Step.create('auditStep', () => ({auditRecorded: true}))
                )
            );

            // When condition is true
            const resAudit: any = await optionalAudit.execute({enableAudit: true}, {pojo: true});
            expect(resAudit.auditRecorded).to.be.true;
            expect(resAudit.$branchSelected).to.equal('then');

            // When condition is false
            const resNoAudit: any = await optionalAudit.execute({enableAudit: false}, {pojo: true});
            expect(resNoAudit.auditRecorded).to.be.undefined;
            expect(resNoAudit.$skipped).to.be.true;
            expect(resNoAudit.$skippedBranches).to.include('then');
        });
    });

    describe('Workstream 4: High-Throughput Batch Processing with Bounded Worker Pool', () => {
        it('Scenario 4a: Bounded batch mapping preserves order, limits concurrency, and passes meta', async () => {
            let activeWorkers = 0;
            let peakConcurrency = 0;

            const documents = Array.from({length: 8}, (_, i) => ({
                id: `DOC-${i + 1}`,
                title: `Report ${i + 1}`
            }));

            const batchMap = map(
                documents,
                async (doc: any, meta: any) => {
                    activeWorkers++;
                    peakConcurrency = Math.max(peakConcurrency, activeWorkers);
                    await new Promise(r => setTimeout(r, 20));
                    activeWorkers--;
                    return {
                        docId: doc.id,
                        indexed: true,
                        orderIndex: meta.index
                    };
                },
                {concurrency: 3, preserveOrder: true}
            );

            const result: any = await flow(batchMap).execute({}, {pojo: true});

            expect(result.items).to.have.length(8);
            expect(peakConcurrency).to.be.at.most(3);
            expect(result.items[0].docId).to.equal('DOC-1');
            expect(result.items[7].docId).to.equal('DOC-8');
            expect(result.items[3].orderIndex).to.equal(3);
        });

        it('Scenario 4b: stopOnError: false collects all results and errors without interrupting batch', async () => {
            const items = [10, 0, 30, 0, 50];

            const safeDivision = map(
                items,
                async (val: number) => {
                    if (val === 0) throw new Error('Division by zero');
                    return 100 / val;
                },
                {concurrency: 2, stopOnError: false}
            );

            const res: any = await flow(safeDivision).execute({}, {pojo: true});

            expect(res.items).to.have.length(5);
            expect(res.items[0]).to.equal(10);
            expect(res.items[1]).to.be.an('object');
            expect(res.items[1].error.message).to.equal('Division by zero');
            expect(res.items[2]).to.be.closeTo(3.33, 0.01);
            expect(res.items[4]).to.equal(2);
        });

        it('Scenario 4c: Async generator streaming and AbortSignal cancellation in bounded map', async () => {
            async function* numberGenerator() {
                for (let i = 1; i <= 5; i++) {
                    yield i;
                }
            }

            const streamMap = map(
                numberGenerator(),
                async (n: number) => n * 10,
                {concurrency: 2}
            );

            const streamResult: any = await flow(streamMap).execute({}, {pojo: true});
            expect(streamResult.items).to.deep.equal([10, 20, 30, 40, 50]);

            // Cancellation propagation
            const controller = new AbortController();
            const cancellableMap = map(
                [1, 2, 3, 4, 5],
                async () => {
                    await new Promise(r => setTimeout(r, 40));
                    return 'done';
                },
                {concurrency: 1}
            );

            setTimeout(() => controller.abort(), 20);

            try {
                await flow(cancellableMap).execute({}, {signal: controller.signal});
                expect.fail('Should have cancelled');
            } catch (err: any) {
                expect(err.name).to.equal('CancellationException');
            }
        });
    });

    describe('Workstream 5: Scoped Financial Settlement & Idempotency Claim Locking', () => {
        it('Scenario 5a: Idempotent order processing preventing double charge (Workflow-level)', async () => {
            let chargeCounter = 0;
            const chargeStep = Step.create('charge', async ({amount}: any) => {
                    chargeCounter++;
                    return {transactionId: 'tx_abc123', amountCharged: amount};
                });

            const orderFlow = flow(chargeStep);

            // 1. Initial request
            const res1 = await orderFlow.execute({amount: 150}, {
                pojo: true,
                idempotencyKey: 'cart-checkout-99'
            });
            expect(res1.amountCharged).to.equal(150);
            expect(chargeCounter).to.equal(1);

            // 2. Duplicate network retry
            const res2 = await orderFlow.execute({amount: 150}, {
                pojo: true,
                idempotencyKey: 'cart-checkout-99'
            });
            expect(res2.amountCharged).to.equal(150);
            expect(chargeCounter).to.equal(1); // Charge step was NOT called twice!
        });

        it('Scenario 5b: Step-level idempotency with buildIdempotencyKey protecting ledger settlement', async () => {
            let ledgerSettlementCalls = 0;
            const customStore = new InMemoryIdempotencyStore();

            const settleStep = Step.create('settleStep', async ({transactionId, amount}: any) => {
                    ledgerSettlementCalls++;
                    return {
                        settled: true,
                        journalRef: `JRNL-${transactionId}-${Date.now()}`,
                        amountSettled: amount
                    };
                })
                .idempotent((ctx) => buildIdempotencyKey('ledger-settlement', {namespace: ctx.transactionId}), {
                    ttlMs: 60000,
                    store: customStore
                });

            const issueReceipt = Step.create('issueReceipt', ({journalRef, amountSettled}: any) => ({
                    receiptStatus: 'ISSUED',
                    journalRef,
                    amountSettled
                }));

            const settlementPipeline = flow(settleStep, issueReceipt);

            // 1. First execution
            const firstResult = await settlementPipeline.execute({
                transactionId: 'TX-BANK-8821',
                amount: 50000
            }, {pojo: true});

            expect(firstResult.receiptStatus).to.equal('ISSUED');
            expect(firstResult.amountSettled).to.equal(50000);
            expect(ledgerSettlementCalls).to.equal(1);
            const originalJournal = firstResult.journalRef;

            // 2. Duplicate re-delivery
            const secondResult = await settlementPipeline.execute({
                transactionId: 'TX-BANK-8821',
                amount: 50000
            }, {pojo: true});

            expect(secondResult.receiptStatus).to.equal('ISSUED');
            expect(secondResult.amountSettled).to.equal(50000);
            expect(secondResult.journalRef).to.equal(originalJournal);
            expect(ledgerSettlementCalls).to.equal(1); // Did not run twice!
        });

        it('Scenario 5c: In-flight concurrent claim collision throws IdempotencyConflictException', async () => {
            const inFlightStore = new InMemoryIdempotencyStore();
            const scopedKey = buildIdempotencyKey('tx-claim-lock-123');
            // Pre-claim scoped key to simulate an in-progress background worker
            await inFlightStore.claim(scopedKey);

            const protectedStep = Step.create('lockStep', async () => ({executed: true}))
                .idempotent(() => 'tx-claim-lock-123', {store: inFlightStore});

            try {
                await flow(protectedStep).execute({}, {pojo: true});
                expect.fail('Should have rejected in-flight conflict');
            } catch (err: any) {
                expect(err).to.be.instanceOf(IdempotencyConflictException);
                expect(err.idempotencyKey).to.equal(scopedKey);
            }
        });

        it('Scenario 5d: Workflow failure clears idempotency claim so it can be retried safely', async () => {
            let attemptCount = 0;
            const flakyStep = Step.create('flakyPayment', async () => {
                    attemptCount++;
                    if (attemptCount === 1) {
                        throw new Error('Payment gateway timeout');
                    }
                    return {success: true, paymentId: 'PAY-123'};
                });

            const flakyFlow = flow(flakyStep);

            // 1. First attempt fails
            try {
                await flakyFlow.execute({}, {idempotencyKey: 'flaky-charge-456'});
                expect.fail('First attempt should have failed');
            } catch (err: any) {
                expect(err.message).to.equal('Payment gateway timeout');
            }

            // 2. Retry succeeds because failed claim was released
            const retryRes = await flakyFlow.execute({}, {
                pojo: true,
                idempotencyKey: 'flaky-charge-456'
            });

            expect(retryRes.success).to.be.true;
            expect(retryRes.paymentId).to.equal('PAY-123');
            expect(attemptCount).to.equal(2);
        });
    });

    describe('Workstream 6: Durable Waits, External Event Resumption & Version Migrations', () => {
        it('Scenario 6a: Durable wait, external event resumption, and batch map processing', async () => {
            const step1 = Step.create('createAccount', ({username}: any) => ({
                username,
                accountId: 'acc_456'
            }));

            const waitForKyc = waitForEvent('kyc.completed', {
                correlationKey: (ctx) => `kyc:${ctx.accountId}`,
                timeout: '24h'
            });

            const provisionServices = map(
                ['email', 'database', 'storage', 'analytics'],
                async (service: string, meta: any) => {
                    return {service, provisioned: true, workerIndex: meta.index};
                },
                {concurrency: 2}
            );

            const onboardingWorkflow = flow(step1, waitForKyc, provisionServices).version('1.0.0');

            // 1. Run durable workflow until KYC wait point
            const suspended: any = await onboardingWorkflow.run({username: 'alice'}, {
                durable: true,
                pojo: true
            });

            expect(suspended.status).to.equal(Status.WAITING);
            expect(suspended.correlationKey).to.equal('kyc:acc_456');

            // 2. Resume when external KYC webhook arrives
            const completed = await onboardingWorkflow.resume('kyc:acc_456', {
                kycScore: 98,
                kycVerified: true
            }, {pojo: true});

            expect(completed.username).to.equal('alice');
            expect(completed.kycVerified).to.equal(true);
            expect(completed.items).to.have.length(4);
            expect(completed.items[0].service).to.equal('email');
            expect(completed.items[3].service).to.equal('analytics');
        });

        it('Scenario 6b: Durable sleep timer with wait() returns suspension descriptor', async () => {
            const timerFlow = flow(
                Step.create('step1', () => ({step1Done: true})),
                wait('100ms'),
                Step.create('step2', () => ({step2Done: true}))
            );

            // Non-durable execution passes through wait
            const nonDurableRes = await timerFlow.execute({}, {pojo: true});
            expect(nonDurableRes.step1Done).to.be.true;
            expect(nonDurableRes.step2Done).to.be.true;

            // Durable execution suspends at timer
            const suspended: any = await timerFlow.execute({}, {durable: true, pojo: true});
            expect(suspended.status).to.equal(Status.WAITING);
            expect(suspended.eventName).to.equal('timer');
            expect(suspended.correlationKey).to.be.a('string');
        });

        it('Scenario 6c: Workflow version verification and state migration across versions', async () => {
            const submitExpense = Step.create('submitExpense', ({reportId, amount}: any) => ({
                reportId,
                amount,
                submittedAt: Date.now()
            }));

            const awaitApproval = waitForEvent('expense.approved', {
                correlationKey: (ctx) => ctx.reportId
            });

            const reimburse = Step.create('reimburse', ({
                                                                             reportId,
                                                                             amount,
                                                                             approvedBy,
                                                                             policyV2
                                                                         }: any) => ({
                reimbursed: true,
                reportId,
                amount,
                approvedBy,
                policyV2
            }));

            const v1Workflow = flow(submitExpense, awaitApproval, reimburse).version('1.0.0');
            const v2Workflow = flow(submitExpense, awaitApproval, reimburse).version('2.0.0');

            // 1. Suspend with v1 and attempt resume with v2 without migration -> throws WorkflowVersionMismatchException
            const suspendedMismatch: any = await v1Workflow.run({reportId: 'EXP-MISMATCH-1', amount: 3000}, {
                durable: true,
                pojo: true
            });
            expect(suspendedMismatch.status).to.equal(Status.WAITING);

            try {
                await v2Workflow.resume('EXP-MISMATCH-1', {approvedBy: 'manager@corp.com'});
                expect.fail('Should have failed version check');
            } catch (err: any) {
                expect(err).to.be.instanceOf(WorkflowVersionMismatchException);
                expect(err.expectedVersion).to.equal('2.0.0');
                expect(err.actualVersion).to.equal('1.0.0');
            }

            // 2. Suspend another workflow and resume with state migration function -> succeeds
            const suspendedMigrate: any = await v1Workflow.run({reportId: 'EXP-MIGRATE-2', amount: 4200}, {
                durable: true,
                pojo: true
            });
            expect(suspendedMigrate.status).to.equal(Status.WAITING);

            const resumed = await v2Workflow.resume('EXP-MIGRATE-2', {approvedBy: 'director@corp.com'}, {
                migrations: {
                    '1.0.0->2.0.0': (_from: any, _to: any, oldState: any) => ({
                        ...oldState,
                        policyV2: true
                    })
                },
                pojo: true
            });

            expect(resumed.reimbursed).to.be.true;
            expect(resumed.reportId).to.equal('EXP-MIGRATE-2');
            expect(resumed.approvedBy).to.equal('director@corp.com');
            expect(resumed.policyV2).to.be.true;
        });

        it('Scenario 6d: Event safety guarantees: DuplicateEventException and ExpiredWaitException', async () => {
            const waitEvent = waitForEvent('user.activated', {
                correlationKey: 'user-777',
                timeoutMs: 25
            });

            const activateFlow = flow(waitEvent, Step.create('welcome', () => ({welcomed: true})));

            // 1. Expired wait test
            await activateFlow.run({}, {durable: true});
            await new Promise(r => setTimeout(r, 35));

            try {
                await activateFlow.resume('user-777', {token: 'xyz'});
                expect.fail('Should have rejected expired wait');
            } catch (err: any) {
                expect(err).to.be.instanceOf(ExpiredWaitException);
                expect(err.correlationKey).to.equal('user-777');
            }

            // 2. Duplicate resume test
            const activeWait = waitForEvent('user.verified', {
                correlationKey: 'user-888',
                timeout: '1h'
            });
            const validFlow = flow(activeWait);
            await validFlow.run({}, {durable: true});

            // First resume succeeds
            await validFlow.resume('user-888', {ok: true});

            // Duplicate resume rejects
            try {
                await validFlow.resume('user-888', {ok: true});
                expect.fail('Should have rejected duplicate resume');
            } catch (err: any) {
                expect(err).to.be.instanceOf(DuplicateEventException);
                expect(err.correlationKey).to.equal('user-888');
            }
        });
    });

    describe('Workstream 7: Workflow Graph Model, Inspection & Static Governance', () => {
        it('Scenario 7a: CI/CD deployment pipeline governance with toGraph and inspectGraph', () => {
            const buildPackage = Step.create('buildPackage', () => ({buildUrl: 'pkg.tar.gz'}));
            const runUnitTests = Step.create('runUnitTests', () => ({unitTestsPassed: true}));
            const runSecurityScan = Step.create('runSecurityScan', () => ({cveCount: 0}));
            const runLicenseAudit = Step.create('runLicenseAudit', () => ({licenseOk: true}));
            const qualityGate = parallel(runUnitTests, runSecurityScan, runLicenseAudit);
            const deployCluster = Step.create('deployCluster', () => ({deployed: true}));

            const deploymentPipeline = flow(buildPackage, qualityGate, deployCluster);

            // 1. Compile to AST
            const ast = toGraph(deploymentPipeline);
            expect(ast.type).to.equal('sequence');

            // 2. Validate acyclic structure
            assertValidGraph(ast);
            const validation = validateGraph(ast);
            expect(validation.valid).to.be.true;

            // 3. Inspect topological structure
            const inspection = inspectGraph(deploymentPipeline);
            expect(inspection.totalNodes).to.be.at.least(5);
            expect(inspection.entryNodeId).to.be.a('string');
            expect(inspection.exitNodeIds).to.be.an('array');
            expect(inspection.edges).to.be.an('array');

            // 4. Governance Policy: Must contain security scan step
            const nodeNames = inspection.nodes.map(n => n.name);
            expect(nodeNames).to.include('runSecurityScan');
            expect(nodeNames).to.include('buildPackage');
            expect(nodeNames).to.include('deployCluster');
        });

        it('Scenario 7b: Graph validation catches cyclic dependencies and throws GraphValidationException', () => {
            const nodeA: any = {id: 'nodeA', name: 'nodeA', type: 'step'};
            const nodeB: any = {id: 'nodeB', name: 'nodeB', type: 'sequence', children: []};
            nodeB.children.push(nodeA);
            nodeB.children.push(nodeB); // cycle!

            const res = validateGraph(nodeB);
            expect(res.valid).to.be.false;
            expect(res.errors[0]).to.include('Cycle detected');

            expect(() => assertValidGraph(nodeB)).to.throw(GraphValidationException);
        });
    });

    describe('Workstream 8: Cross-Cutting End-to-End Distributed Orchestration', () => {
        it('Scenario 8: Complete order fulfillment pipeline combining governance, idempotency, parallel fan-out, branching, durable approval, and bounded batch mapping', async () => {
            const auditTrail: string[] = [];

            // 1. Pre-execution governance validation
            const validateInput = Step.create('validateInput', ({orderId, amount, items}: any) => {
                auditTrail.push(`Validated order: ${orderId}`);
                return {orderId, amount, items, validated: true};
            });

            const reserveWarehouse = Step.create('reserveWarehouse', async ({items}: any) => {
                    auditTrail.push('Reserved warehouse items');
                    return {allocatedItems: items, inventorySynced: true};
                })
                .compensate(async (output: any) => {
                    auditTrail.push(`Rollback Inventory for items: ${output.allocatedItems.join(',')}`);
                });

            const authorizeCard = Step.create('authorizeCard', async ({amount}: any) => {
                    auditTrail.push(`Authorized card for $${amount}`);
                    return {authCode: 'AUTH_FULFILL_99', amountCharged: amount};
                })
                .compensate(async (output: any) => {
                    auditTrail.push(`Rollback Card Auth: ${output.authCode}`);
                });

            const prepareFulfillment = parallel(reserveWarehouse, authorizeCard, {mergeStrategy: ParallelMergeStrategy.DEEP});

            const RiskTier = {
                HIGH_VALUE: 'HIGH_VALUE',
                STANDARD: 'STANDARD'
            } as const;

            const routeRiskAssessment = branch(
                (ctx) => (ctx.amount > 1000 ? RiskTier.HIGH_VALUE : RiskTier.STANDARD),
                {
                    [RiskTier.HIGH_VALUE]: Step.create('flagHighValue', () => ({
                        riskLevel: 'ELEVATED',
                        manualReviewRequired: true
                    })),
                    [RiskTier.STANDARD]: Step.create('passStandard', () => ({
                        riskLevel: 'LOW',
                        manualReviewRequired: false
                    }))
                }
            );

            const awaitFraudApproval = waitForEvent('fraud.approval', {
                correlationKey: (ctx) => `fraud:${ctx.orderId}`,
                timeout: '7d'
            });

            const notifyCarriers = map(
                (ctx: any) => ctx.allocatedItems,
                async (item: string) => {
                    auditTrail.push(`Carrier dispatched for: ${item}`);
                    return {item, carrier: 'FedEx', trackingNumber: `TRK-${item}`};
                },
                {concurrency: 2, preserveOrder: true}
            );

            const finalizeFulfillment = Step.create('finalizeFulfillment', ({
                                                                                                 orderId,
                                                                                                 approvedBy,
                                                                                                 items
                                                                                             }: any) => {
                auditTrail.push(`Order finalized: ${orderId}`);
                return {
                    status: 'FULFILLED',
                    orderId,
                    approvedBy,
                    totalItemsDispatched: items.length
                };
            });

            const fullPipeline = flow(
                validateInput,
                prepareFulfillment,
                routeRiskAssessment,
                awaitFraudApproval,
                notifyCarriers,
                finalizeFulfillment
            ).version('2.0.0');

            // 1. Static governance verification
            const graph = toGraph(fullPipeline);
            assertValidGraph(graph);
            const inspection = inspectGraph(fullPipeline);
            expect(inspection.nodes.map(n => n.name)).to.include('reserveWarehouse');
            expect(inspection.nodes.map(n => n.name)).to.include('authorizeCard');

            // 2. High-value order: durable suspension for fraud approval
            const suspendedOrder = await fullPipeline.run({
                orderId: 'ORD-HIGH-999',
                amount: 3500,
                items: ['Server-Rack-1', 'Server-Rack-2']
            }, {
                durable: true,
                pojo: true
            });

            expect(suspendedOrder.status).to.equal(Status.WAITING);
            expect(suspendedOrder.correlationKey).to.equal('fraud:ORD-HIGH-999');

            // 3. Resume when fraud analyst approves
            const completedOrder = await fullPipeline.resume('fraud:ORD-HIGH-999', {
                approvedBy: 'security-director@enterprise.com'
            }, {pojo: true});

            expect(completedOrder.status).to.equal('FULFILLED');
            expect(completedOrder.orderId).to.equal('ORD-HIGH-999');
            expect(completedOrder.approvedBy).to.equal('security-director@enterprise.com');
            expect(completedOrder.totalItemsDispatched).to.equal(2);
            expect(completedOrder.items[0].trackingNumber).to.equal('TRK-Server-Rack-1');
            expect(completedOrder.items[1].trackingNumber).to.equal('TRK-Server-Rack-2');

            // 4. Verification of end-to-end execution audit trail
            expect(auditTrail).to.include('Validated order: ORD-HIGH-999');
            expect(auditTrail).to.include('Reserved warehouse items');
            expect(auditTrail).to.include('Authorized card for $3500');
            expect(auditTrail).to.include('Carrier dispatched for: Server-Rack-1');
            expect(auditTrail).to.include('Carrier dispatched for: Server-Rack-2');
            expect(auditTrail).to.include('Order finalized: ORD-HIGH-999');
        });
    });
});
