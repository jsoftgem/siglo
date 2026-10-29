import { expect } from 'chai';
import Step, { flow, waitForEvent } from 'siglo';
import {
    createWorkflowHarness,
    FakeClock,
    InMemoryStorageFake,
    sanitizeExecutionRecord,
    replayExecution,
    ExecutionRecord
} from './index';

describe('@siglo/testing: Deterministic Test Utilities', () => {
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

            expect(() => harness.assertStepExecuted('nonExistent')).to.throw("Expected step 'nonExistent' to be executed");
            expect(() => harness.assertStepExecuted('fetchData', 2)).to.throw("Expected step 'fetchData' to be executed 2 time(s), but was executed 1 time(s).");
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
            expect(() => harness.assertStepFailed('broken', 'other error')).to.throw("did not match expected pattern");
            expect(() => harness.assertStepFailed('nonExistentStep')).to.throw("Expected step 'nonExistentStep' to fail");
        });

        it('should inject events into durable workflows', async () => {
            const stepBefore = Step.create('init', () => ({ orderId: 'ord-123' }));
            const durableWait = waitForEvent('waitForApproval', { correlationKey: (p: any) => p.$stackId, timeout: '1h' });
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
                        customSecret: 'my-custom-value'
                    }
                },
                output: {
                    status: 'success',
                    token: 'jwt.token.here'
                },
                trace: [
                    {
                        stepName: 'auth',
                        phase: 'start',
                        timestamp: 1000,
                        input: { token: 'jwt.token.here' }
                    }
                ]
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

        it('should replay workflow and verify deterministic parity', async () => {
            const s1 = Step.create('add', (p: { x: number; y: number }) => ({ sum: p.x + p.y }));
            const wf = flow(s1);

            const initialHarness = createWorkflowHarness(wf);
            await initialHarness.run({ x: 5, y: 10 });
            const record = initialHarness.exportExecutionRecord();

            const replay = await replayExecution(record, wf);
            expect(replay.matched).to.be.true;
            expect(replay.discrepancies).to.have.length(0);
            expect(replay.actualOutput.sum).to.equal(15);
        });

        it('should detect discrepancies during replay if output deviates', async () => {
            const wf = flow(Step.create('calc', () => ({ val: 99 })));
            const fakeRecord: ExecutionRecord = {
                input: {},
                output: { val: 42 },
                trace: [],
                recordedAt: new Date().toISOString()
            };

            const replay = await replayExecution(fakeRecord, wf);
            expect(replay.matched).to.be.false;
            expect(replay.discrepancies[0]).to.include('Output mismatch');
        });

        it('should allow substituting step fixtures during replay', async () => {
            const s1 = Step.create('externalApi', () => ({ data: 'original' }));
            const s2 = Step.create('format', (p: any) => ({ formatted: p.data.toUpperCase() }));
            const wf = flow(s1, s2);

            const fakeRecord: ExecutionRecord = {
                input: {},
                output: { data: 'mock_value', formatted: 'MOCK_VALUE' },
                trace: [],
                recordedAt: new Date().toISOString()
            };

            const replay = await replayExecution(fakeRecord, wf, {
                substituteFixtures: {
                    externalApi: { data: 'mock_value' }
                }
            });

            expect(replay.matched).to.be.true;
            expect(replay.actualOutput.formatted).to.equal('MOCK_VALUE');
        });
    });
});
