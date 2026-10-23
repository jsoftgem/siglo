import { expect } from 'chai';
import { Step, flow } from '../step';
import { StepTimeoutException, FlowTimeoutException } from './exceptions';
import { combineAbortSignals } from './signals';

describe('Resilient Execution & Timeouts Unit Tests', () => {
    describe('Timeout Exception Classes', () => {
        it('StepTimeoutException initializes with correct properties and prototype', () => {
            const ex = new StepTimeoutException('testStep', 3000, 3050);
            expect(ex.name).to.equal('StepTimeoutException');
            expect(ex.stepName).to.equal('testStep');
            expect(ex.timeoutMs).to.equal(3000);
            expect(ex.elapsedMs).to.equal(3050);
            expect(ex.message).to.equal("Step 'testStep' timed out after 3000ms (elapsed: 3050ms).");
            expect(ex).to.be.an.instanceof(StepTimeoutException);
            expect(ex).to.be.an.instanceof(Error);
        });

        it('FlowTimeoutException initializes with correct properties and prototype', () => {
            const ex = new FlowTimeoutException('stack_123', 5000, 2);
            expect(ex.name).to.equal('FlowTimeoutException');
            expect(ex.stackId).to.equal('stack_123');
            expect(ex.timeoutMs).to.equal(5000);
            expect(ex.completedSteps).to.equal(2);
            expect(ex.message).to.equal("Flow timed out after 5000ms on stack 'stack_123' (completed steps: 2).");
            expect(ex).to.be.an.instanceof(FlowTimeoutException);
            expect(ex).to.be.an.instanceof(Error);
        });
    });

    describe('combineAbortSignals Helper', () => {
        it('returns undefined signal when given empty array or only undefined', () => {
            const res1 = combineAbortSignals([]);
            expect(res1.signal).to.be.undefined;
            res1.cleanup();

            const res2 = combineAbortSignals([undefined, undefined]);
            expect(res2.signal).to.be.undefined;
            res2.cleanup();
        });

        it('returns single signal directly when given one active signal', () => {
            const ctrl = new AbortController();
            const res = combineAbortSignals([undefined, ctrl.signal]);
            expect(res.signal).to.equal(ctrl.signal);
            res.cleanup();
        });

        it('returns already-aborted signal when one of multiple signals is already aborted', () => {
            const ctrl1 = new AbortController();
            const ctrl2 = new AbortController();
            ctrl1.abort(new Error('Pre-aborted'));

            const res = combineAbortSignals([ctrl1.signal, ctrl2.signal]);
            expect(res.signal?.aborted).to.be.true;
            expect(res.signal?.reason?.message).to.equal('Pre-aborted');
            res.cleanup();
        });

        it('aborts combined signal when any constituent signal fires', (done) => {
            const ctrl1 = new AbortController();
            const ctrl2 = new AbortController();

            const res = combineAbortSignals([ctrl1.signal, ctrl2.signal]);
            expect(res.signal).to.not.be.undefined;

            res.signal?.addEventListener('abort', () => {
                expect(res.signal?.aborted).to.be.true;
                expect(res.signal?.reason?.message).to.equal('Ctrl2 fired');
                res.cleanup();
                done();
            }, { once: true });

            ctrl2.abort(new Error('Ctrl2 fired'));
        });

        it('falls back to manual controller when AbortSignal.any is undefined', (done) => {
            const originalAny = (AbortSignal as any).any;
            try {
                (AbortSignal as any).any = undefined;
                const ctrl1 = new AbortController();
                const ctrl2 = new AbortController();

                const res = combineAbortSignals([ctrl1.signal, ctrl2.signal]);
                expect(res.signal).to.not.be.undefined;

                res.signal?.addEventListener('abort', () => {
                    expect(res.signal?.aborted).to.be.true;
                    res.cleanup();
                    done();
                }, { once: true });

                ctrl1.abort(new Error('Fallback abort'));
            } finally {
                (AbortSignal as any).any = originalAny;
            }
        });
    });

    describe('Step-Level Timeout (step.timeout(ms))', () => {
        it('completes normally when action finishes before step timeout', async () => {
            const step = Step.create('quickStep', async (p: any) => {
                await new Promise(r => setTimeout(r, 20));
                return { done: true, value: p.value.val + 1 };
            }).timeout(200);

            const result = await step.run({ value: 10 });
            expect(result.done.val).to.be.true;
            expect(result.value.val).to.equal(11);
        });

        it('works with synchronous step action when step timeout is set', async () => {
            const syncStep = Step.create('syncStep', (p: any) => {
                return { syncDone: true, doubled: p.num.val * 2 };
            }).timeout(200);

            const res = await syncStep.run({ num: 5 });
            expect(res.syncDone.val).to.be.true;
            expect(res.doubled.val).to.equal(10);
        });

        it('rejects with StepTimeoutException when action exceeds timeout without onFail', async () => {
            const step = Step.create('slowStep', async () => {
                await new Promise(r => setTimeout(r, 150));
                return { done: true };
            }).timeout(50);

            try {
                await step.run();
                throw new Error('Should have failed');
            } catch (err: any) {
                const error = err.error || err;
                expect(error.name).to.equal('StepTimeoutException');
                expect(error).to.be.an.instanceof(StepTimeoutException);
                expect(error.stepName).to.equal('slowStep');
                expect(error.timeoutMs).to.equal(50);
            }
        });

        it('cooperatively notifies action via param.$signal() on timeout', async () => {
            let wasAborted = false;
            let abortReason: any;

            const step = Step.create('cooperativeStep', async (p: any) => {
                const sig = p.$signal?.();
                if (sig) {
                    sig.addEventListener('abort', () => {
                        wasAborted = true;
                        abortReason = sig.reason;
                    }, { once: true });
                }
                await new Promise(r => setTimeout(r, 150));
                return { done: true };
            }).timeout(40);

            try {
                await step.run();
                throw new Error('Should have failed');
            } catch {
                expect(wasAborted).to.be.true;
                expect(abortReason).to.be.an.instanceof(StepTimeoutException);
            }
        });

        it('races hanging promise that never resolves and triggers timeout', async () => {
            const step = Step.create('hangingStep', () => {
                return new Promise(() => {
                    // Intentionally never resolve or reject
                });
            }).timeout(50);

            try {
                await step.run();
                throw new Error('Should have failed');
            } catch (err: any) {
                const error = err.error || err;
                expect(error).to.be.an.instanceof(StepTimeoutException);
            }
        });

        it('step timeout triggers onFail retry policy and succeeds on subsequent attempt', async () => {
            let attempts = 0;

            const step = Step.create('retryingStep', async () => {
                attempts++;
                if (attempts === 1) {
                    await new Promise(r => setTimeout(r, 150)); // Times out
                }
                return { attempts, success: true };
            })
            .timeout(50)
            .onFail({
                maxRetries: 2,
                delay: 20
            });

            const result = await step.run();
            expect(result.success.val).to.be.true;
            expect(result.attempts.val).to.equal(2);
        });

        it('step timeout exhausts onFail retries and rejects with StepTimeoutException', async () => {
            let attempts = 0;

            const step = Step.create('alwaysSlowStep', async () => {
                attempts++;
                await new Promise(r => setTimeout(r, 100));
                return { done: true };
            })
            .timeout(30)
            .onFail({
                maxRetries: 2,
                delay: 10
            });

            try {
                await step.run();
                throw new Error('Should have failed');
            } catch (err: any) {
                const error = err.error || err;
                expect(error).to.be.an.instanceof(StepTimeoutException);
                expect(attempts).to.equal(3); // 1 initial + 2 retries
            }
        });
    });

    describe('Flow-Level Timeout (flow.timeout(ms) & options.timeout)', () => {
        it('flow completes normally when within flow deadline', async () => {
            const s1 = Step.create('step1', async () => {
                await new Promise(r => setTimeout(r, 20));
                return { step1: true };
            });
            const s2 = Step.create('step2', async () => {
                await new Promise(r => setTimeout(r, 20));
                return { step2: true };
            });

            const f = flow(s1, s2).timeout(200);
            expect(f.timeoutMs).to.equal(200);

            const result = await f.run({}, { pojo: true });
            expect(result.step2).to.be.true;
            expect(result.$steps[0].step1).to.be.true;
        });

        it('aborts flow and rejects with FlowTimeoutException when cumulative time exceeds flow budget', async () => {
            const s1 = Step.create(async () => {
                await new Promise(r => setTimeout(r, 30));
                return { step1: true };
            });
            const s2 = Step.create(async () => {
                await new Promise(r => setTimeout(r, 150));
                return { step2: true };
            });
            const s3 = Step.create(async () => {
                return { step3: true };
            });

            const f = flow(s1, s2, s3);

            try {
                await f.run({}, { timeout: 60 });
                throw new Error('Should have failed');
            } catch (err: any) {
                const error = err.error || err;
                expect(error).to.be.an.instanceof(FlowTimeoutException);
                expect(error.name).to.equal('FlowTimeoutException');
                expect(error.timeoutMs).to.equal(60);
                expect(error.completedSteps).to.equal(1); // s1 finished, s2 timed out
                expect(err.stackId).to.not.be.undefined;
            }
        });

        it('flow timeout cancels active retry delay immediately', async () => {
            const startTime = Date.now();

            const failingStep = Step.create(async () => {
                throw new Error('Transient error');
            }).onFail({
                maxRetries: 5,
                delay: 2000 // 2s backoff delay
            });

            const f = flow(failingStep).timeout(50);

            try {
                await f.run();
                throw new Error('Should have failed');
            } catch (err: any) {
                const elapsed = Date.now() - startTime;
                expect(elapsed).to.be.below(1000); // Did not wait for the 2s retry delay!
                const error = err.error || err;
                expect(error).to.be.an.instanceof(FlowTimeoutException);
            }
        });

        it('aborts retry delay if signal was already aborted before delay starts', (done) => {
            const controller = new AbortController();
            controller.abort(new Error('Already aborted'));

            const step = Step.create(() => {
                throw new Error('Failed');
            }).onFail({
                maxRetries: 2,
                delay: 500
            });

            step.run({}, { signal: controller.signal }).catch((err: any) => {
                const msg = err.error?.message || err.message;
                expect(msg).to.equal('Already aborted');
                done();
            });
        });

        it('pre-aborted flow option rejects synchronously without executing steps', async () => {
            let executed = false;
            const step = Step.create(async () => {
                executed = true;
                return { ok: true };
            });

            const controller = new AbortController();
            controller.abort(new Error('Manual cancellation'));

            try {
                await flow(step).run({}, { signal: controller.signal });
                throw new Error('Should have failed');
            } catch (err: any) {
                expect(executed).to.be.false;
                expect(err.message).to.equal('Manual cancellation');
            }
        });
    });
});
