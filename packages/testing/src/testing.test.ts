import { expect } from 'chai';
import Step, { clearStorage, flow, waitForEvent } from '@siglo/core';
import {
    createWorkflowHarness,
    FakeClock,
    InMemoryStorageFake,
    sanitizeExecutionRecord,
    replayExecution,
    ExecutionRecord,
} from './index';

describe('@siglo/testing: Deterministic Test Utilities', () => {
    beforeEach(() => {
        clearStorage();
    });

    describe('FakeClock', () => {
        it('should advance time and tick deterministically', async () => {
            const clock = new FakeClock(1000);
            expect(clock.now()).to.equal(1000);

            clock.advanceTime(500);
            expect(clock.now()).to.equal(1500);

            await clock.tick(250);
            expect(clock.now()).to.equal(1750);

            clock.reset(5000);
            expect(clock.now()).to.equal(5000);
        });
    });

    describe('InMemoryStorageFake', () => {
        it('should save and retrieve checkpoints and cache', async () => {
            const fakeStorage = new InMemoryStorageFake();
            expect(fakeStorage.name).to.equal('in-memory-fake');

            await fakeStorage.saveCheckpoint({ stackId: 'cp-1', state: 'ok' });
            const retrieved = await fakeStorage.getCheckpoint('cp-1');
            expect(retrieved).to.deep.equal({ stackId: 'cp-1', state: 'ok' });

            const missing = await fakeStorage.getCheckpoint('missing');
            expect(missing).to.be.undefined;

            await fakeStorage.setCachedStep('step-cache-1', { res: 42 });
            const cached = await fakeStorage.getCachedStep('step-cache-1');
            expect(cached).to.deep.equal({ res: 42 });

            await fakeStorage.onContextChange({ stackId: 's-1', key: 'foo' });
            expect(fakeStorage.contextChanges).to.have.length(1);

            expect(fakeStorage.getCheckpoints().size).to.equal(1);

            fakeStorage.clear();
            expect(fakeStorage.getCheckpoints().size).to.equal(0);
            expect(fakeStorage.contextChanges).to.have.length(0);
        });
    });

    describe('WorkflowHarness', () => {
        it('should track step execution, spies, traces, and assertions', async () => {
            const s1 = Step.create('fetchData', () => ({ items: [1, 2, 3] }));
            const s2 = Step.create('processData', (param: any) => ({ count: param.items.length }));
            const wf = flow(s1, s2);

            const harness = createWorkflowHarness(wf);
            const spy1 = harness.spyStep('fetchData');
            const spy2 = harness.spyStep('processData');

            const result = await harness.run({ orgId: 'org-1' });

            expect(result.count).to.equal(3);
            expect(spy1.called).to.be.true;
            expect(spy1.callCount).to.equal(1);
            expect(spy1.firstCall()?.input.orgId).to.equal('org-1');
            expect(spy2.lastCall()?.output).to.deep.equal({ count: 3 });

            harness.assertStepExecuted('fetchData', 1);
            harness.assertStepExecuted('processData');

            expect(() => harness.assertStepExecuted('nonExistent')).to.throw(
                "Expected step 'nonExistent' to be executed",
            );
            expect(() => harness.assertStepExecuted('fetchData', 2)).to.throw(
                "Expected step 'fetchData' to be executed 2 time(s), but was executed 1 time(s).",
            );
        });

        it('should mock steps with custom implementations', async () => {
            const externalServiceStep = Step.create('callStripe', () => {
                throw new Error('Real network call should not happen in unit tests');
            });
            const followUpStep = Step.create('notify', (p: any) => ({ chargeId: p.chargeId, status: 'sent' }));
            const wf = flow(externalServiceStep, followUpStep);

            const harness = createWorkflowHarness(wf);
            harness.mockStep('callStripe', () => ({ chargeId: 'ch_mock_123' }));

            const result = await harness.execute({ amount: 100 });
            expect(result.chargeId).to.equal('ch_mock_123');
            expect(result.status).to.equal('sent');
        });

        it('should assert step retries and failures', async () => {
            let attempts = 0;
            const failingStep = Step.create('flakyStep', () => {
                attempts++;
                if (attempts < 3) {
                    throw new Error('Temporary gateway error');
                }
                return { success: true };
            }).onFail({ maxRetries: 3, delay: 10 });

            const wf = flow(failingStep);
            const harness = createWorkflowHarness(wf);

            const result = await harness.run();
            expect(result.success).to.be.true;

            harness.assertStepRetried('flakyStep', 2);
        });

        it('should record step failure in trace and assertStepFailed', async () => {
            const brokenStep = Step.create('broken', () => {
                throw new Error('Fatal validation crash');
            });
            const wf = flow(brokenStep);
            const harness = createWorkflowHarness(wf);

            let threw = false;
            try {
                await harness.run();
            } catch {
                threw = true;
            }
            expect(threw).to.be.true;

            harness.assertStepFailed('broken', 'Fatal validation crash');
            harness.assertStepFailed('broken', /validation/);
            expect(() => harness.assertStepFailed('broken', 'other error')).to.throw('did not match expected pattern');
            expect(() => harness.assertStepFailed('nonExistentStep')).to.throw(
                "Expected step 'nonExistentStep' to fail",
            );
        });

        it('should inject events into durable workflows', async () => {
            const stepBefore = Step.create('init', () => ({ orderId: 'ord-123' }));
            const durableWait = waitForEvent('waitForApproval', {
                correlationKey: (p: any) => p.$stackId,
                timeout: '1h',
            });
            const stepAfter = Step.create('finalize', (p: any) => ({ approvedBy: p.approvedBy }));

            const wf = flow(stepBefore, durableWait, stepAfter);
            const harness = createWorkflowHarness(wf);

            // In-memory run
            const initialRes = await harness.run({ initial: true }, { durable: true });
            expect(initialRes.status).to.equal('waiting');

            // Inject the event to resume workflow
            const res = await harness.injectEvent('waitForApproval', initialRes.stackId, { approvedBy: 'manager-dan' });
            expect(res.approvedBy).to.equal('manager-dan');
        });

        it('should support Step.compute synchronously with spyStep, mockStep, assertStepExecuted, and .cache()', async () => {
            const fetchCart = Step.create('fetchCart', async (p: { cartId: string }) => ({
                cartId: p.cartId,
                subtotal: 200,
                discount: 50,
            }));

            const calculateTotals = Step.compute(
                'calculateTotals',
                (p: { subtotal: number; discount: number; taxRate: number }) => {
                    const taxable = Math.max(0, p.subtotal - p.discount);
                    const tax = Math.round(taxable * p.taxRate * 100) / 100;
                    return { tax, total: taxable + tax };
                },
            )
                .spec('subtotal', { require: true, validate: v => typeof v === 'number' && v >= 0 })
                .spec('discount', { default: 0 })
                .spec('taxRate', { default: 0.1 })
                .cache('5m');

            const checkoutFlow = flow(fetchCart, calculateTotals);
            const harness = createWorkflowHarness(checkoutFlow);
            const computeSpy = harness.spyStep('calculateTotals');

            // First run: executes calculateTotals
            const res1 = await harness.run({ cartId: 'cart-1' });
            expect(res1.tax).to.equal(15);
            expect(res1.total).to.equal(165);
            expect(computeSpy.called).to.be.true;
            expect(computeSpy.callCount).to.equal(1);
            expect(computeSpy.firstCall()?.input.taxRate).to.equal(0.1);
            expect(computeSpy.lastCall()?.output).to.deep.equal({ tax: 15, total: 165 });

            // Second run with same post-.spec() input: served from in-memory compute cache
            const res2 = await harness.run({ cartId: 'cart-1', taxRate: 0.1 });
            expect(res2.total).to.equal(165);
            expect(computeSpy.callCount).to.equal(1);
            harness.assertStepExecuted('fetchCart', 2);
            harness.assertStepExecuted('calculateTotals', 1);

            // Mock a Step.compute step
            clearStorage();
            const mockHarness = createWorkflowHarness(checkoutFlow);
            mockHarness.mockStep('calculateTotals', () => ({ tax: 0, total: 100 }));
            const mockedRes = await mockHarness.run({ cartId: 'cart-2' });
            expect(mockedRes.total).to.equal(100);
            mockHarness.assertStepExecuted('calculateTotals', 1);
        });

        it('should isolate Step.compute caches across separate WorkflowHarness instances and invalidate cache on mockStep', async () => {
            const cachedCompute = Step.compute('cachedCompute', (p: { x: number }) => ({
                y: p.x * 10,
            })).cache('5m');
            const wf = flow(cachedCompute);

            // Harness A populates its own cache
            const harnessA = createWorkflowHarness(wf);
            const resA1 = await harnessA.run({ x: 3 });
            expect(resA1.y).to.equal(30);
            harnessA.assertStepExecuted('cachedCompute', 1);

            // Harness B (created WITHOUT clearStorage()) must NOT share Harness A's cache!
            const harnessB = createWorkflowHarness(wf);
            const spyB = harnessB.spyStep('cachedCompute');
            const resB1 = await harnessB.run({ x: 3 });
            expect(resB1.y).to.equal(30);
            expect(spyB.callCount).to.equal(1);
            harnessB.assertStepExecuted('cachedCompute', 1);

            // Calling mockStep on Harness A after cache was populated must clear Harness A's cache so the mock executes
            harnessA.mockStep('cachedCompute', () => ({ y: 999 }));
            const resA2 = await harnessA.run({ x: 3 });
            expect(resA2.y).to.equal(999);
            harnessA.assertStepExecuted('cachedCompute', 2);
        });

        it('should record Step.compute failures for action errors, .spec() validation errors, and async mock violations', async () => {
            const computeStep = Step.compute('riskScore', (p: { income: number; debt: number }) => {
                if (p.income === 0) {
                    throw new Error('Income cannot be zero');
                }
                return { ratio: p.debt / p.income };
            }).spec('income', { require: true, validate: v => typeof v === 'number' && v >= 0 });

            // 1. Action error
            const harness1 = createWorkflowHarness(flow(computeStep));
            const spy1 = harness1.spyStep('riskScore');
            let actionThrew = false;
            try {
                await harness1.run({ income: 0, debt: 50 });
            } catch {
                actionThrew = true;
            }
            expect(actionThrew).to.be.true;
            expect(spy1.lastCall()?.error?.message).to.include('Income cannot be zero');
            harness1.assertStepFailed('riskScore', 'Income cannot be zero');

            // 2. .spec() validation error
            const harness2 = createWorkflowHarness(flow(computeStep));
            const spy2 = harness2.spyStep('riskScore');
            let specThrew = false;
            try {
                await harness2.run({ income: -10, debt: 50 });
            } catch {
                specThrew = true;
            }
            expect(specThrew).to.be.true;
            expect(spy2.called).to.be.true;
            harness2.assertStepFailed('riskScore', /Validation failed/);

            // 3. Async mock on Step.compute must reject with synchronous thenable guard error
            const harness3 = createWorkflowHarness(computeStep);
            harness3.mockStep('riskScore', async () => ({ ratio: 0.5 }));
            let asyncMockThrew = false;
            try {
                await harness3.run({ income: 100, debt: 20 });
            } catch {
                asyncMockThrew = true;
            }
            expect(asyncMockThrew).to.be.true;
            harness3.assertStepFailed('riskScore', /must be synchronous and cannot return a Promise/);
        });
    });

    describe('Execution Record Sanitization & Replay', () => {
        it('should redact sensitive keys in execution records', () => {
            const rawRecord: ExecutionRecord = {
                workflowVersion: '1.0.0',
                recordedAt: '2026-10-26T00:00:00.000Z',
                input: {
                    userId: 'user-1',
                    password: 'super-secret-password',
                    apiKey: 'sk-12345678',
                    nested: {
                        creditCard: '4111-1111-1111-1111',
                        customSecret: 'my-custom-value',
                    },
                },
                output: {
                    status: 'success',
                    token: 'jwt.token.here',
                },
                trace: [
                    {
                        stepName: 'auth',
                        phase: 'start',
                        timestamp: 1000,
                        input: { token: 'jwt.token.here' },
                    },
                ],
            };

            const sanitized = sanitizeExecutionRecord(rawRecord, { excludeKeys: ['customSecret'] });

            expect(sanitized.input.password).to.equal('[REDACTED]');
            expect(sanitized.input.apiKey).to.equal('[REDACTED]');
            expect(sanitized.input.nested.creditCard).to.equal('[REDACTED]');
            expect(sanitized.input.nested.customSecret).to.equal('[REDACTED]');
            expect(sanitized.input.userId).to.equal('user-1');
            expect(sanitized.output.token).to.equal('[REDACTED]');
            expect(sanitized.trace[0].input.token).to.equal('[REDACTED]');
        });

        it('should replay workflow and verify deterministic parity (including cached Step.compute)', async () => {
            const s1 = Step.create('add', (p: { x: number; y: number }) => ({ sum: p.x + p.y }));
            const s2 = Step.compute('double', (p: { sum: number }) => ({ doubled: p.sum * 2 })).cache('5m');
            const wf = flow(s1, s2);

            const initialHarness = createWorkflowHarness(wf);
            await initialHarness.run({ x: 5, y: 10 });
            const record = initialHarness.exportExecutionRecord();

            const replay = await replayExecution(record, wf);
            expect(replay.matched).to.be.true;
            expect(replay.discrepancies).to.have.length(0);
            expect(replay.actualOutput.sum).to.equal(15);
            expect(replay.actualOutput.doubled).to.equal(30);
        });

        it('should detect discrepancies during replay if output deviates', async () => {
            const wf = flow(Step.create('calc', () => ({ val: 99 })));
            const fakeRecord: ExecutionRecord = {
                input: {},
                output: { val: 42 },
                trace: [],
                recordedAt: new Date().toISOString(),
            };

            const replay = await replayExecution(fakeRecord, wf);
            expect(replay.matched).to.be.false;
            expect(replay.discrepancies[0]).to.include('Output mismatch');
        });

        it('should allow substituting step fixtures during replay', async () => {
            const s1 = Step.create('externalApi', () => ({ data: 'original' }));
            const s2 = Step.compute('format', (p: any) => ({ formatted: p.data.toUpperCase() }));
            const wf = flow(s1, s2);

            const fakeRecord: ExecutionRecord = {
                input: {},
                output: { data: 'mock_value', formatted: 'MOCK_VALUE' },
                trace: [],
                recordedAt: new Date().toISOString(),
            };

            const replay = await replayExecution(fakeRecord, wf, {
                substituteFixtures: {
                    externalApi: { data: 'mock_value' },
                },
            });

            expect(replay.matched).to.be.true;
            expect(replay.actualOutput.formatted).to.equal('MOCK_VALUE');
        });
    });
});
