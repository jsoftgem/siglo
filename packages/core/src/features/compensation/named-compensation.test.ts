import { expect } from 'chai';
import {
    Step,
    flow,
    registerCompensationHandler,
    getCompensationHandler,
    hasCompensationHandler,
    unregisterCompensationHandler,
    clearCompensationHandlers,
    reconcileAbandonedStacks,
    UnresolvableCompensationException,
    CompensationException,
    defaultCompensationManager,
    defaultStorageManager,
    clearStorage,
    Status,
} from '../../index';

describe('Phase 4: Named Compensation Registry, DLQ & Stack Reconciler', () => {
    beforeEach(() => {
        clearStorage();
        defaultCompensationManager.clear();
        clearCompensationHandlers();
    });

    afterEach(() => {
        clearStorage();
        defaultCompensationManager.clear();
        clearCompensationHandlers();
    });

    describe('Named Compensation Registry API', () => {
        it('registers, retrieves, checks, and unregisters named handlers', () => {
            const handler = async (output: any) => output;
            expect(hasCompensationHandler('refundPayment')).to.be.false;

            registerCompensationHandler('refundPayment', handler);
            expect(hasCompensationHandler('refundPayment')).to.be.true;
            expect(getCompensationHandler('refundPayment')).to.equal(handler);

            const deleted = unregisterCompensationHandler('refundPayment');
            expect(deleted).to.be.true;
            expect(hasCompensationHandler('refundPayment')).to.be.false;
            expect(getCompensationHandler('refundPayment')).to.be.undefined;

            const deletedAgain = unregisterCompensationHandler('refundPayment');
            expect(deletedAgain).to.be.false;
        });

        it('supports handler objects with an execute method', () => {
            const handlerObj = {
                execute: async (ctx: any) => ctx,
            };
            registerCompensationHandler('objHandler', handlerObj as any);
            expect(getCompensationHandler('objHandler')).to.equal(handlerObj);
        });

        it('throws an error if handler name is empty or invalid', () => {
            expect(() => registerCompensationHandler('', () => {})).to.throw(
                'Compensation handler name must be a non-empty string',
            );
            expect(() => registerCompensationHandler(null as any, () => {})).to.throw(
                'Compensation handler name must be a non-empty string',
            );
        });

        it('throws an error if handler is not a function or object with execute', () => {
            expect(() => registerCompensationHandler('invalid', null as any)).to.throw(
                "Compensation handler for 'invalid' must be a function or have an execute method",
            );
            expect(() => registerCompensationHandler('invalid', 123 as any)).to.throw(
                "Compensation handler for 'invalid' must be a function or have an execute method",
            );
        });

        it('clears all registered named compensation handlers', () => {
            registerCompensationHandler('h1', () => {});
            registerCompensationHandler('h2', () => {});
            expect(hasCompensationHandler('h1')).to.be.true;
            expect(hasCompensationHandler('h2')).to.be.true;

            clearCompensationHandlers();
            expect(hasCompensationHandler('h1')).to.be.false;
            expect(hasCompensationHandler('h2')).to.be.false;
        });
    });

    describe('Step .compensate() overloads and execution', () => {
        it('executes a named compensation handler when downstream fails', async () => {
            const log: string[] = [];
            registerCompensationHandler('releaseInventory', async (payload: any, input: any) => {
                log.push(`released:${payload.sku}:${payload.qty}:${input.orderId}`);
            });

            const step1 = Step.create('reserve', ({ sku, qty }: any) => ({
                sku,
                qty,
                reservedId: 'res-99',
            })).compensate(
                'releaseInventory',
                (output, input) => ({
                    sku: output.sku,
                    qty: output.qty,
                }),
                { maxRetries: 1 },
            );

            const step2 = Step.create('failStep', () => {
                throw new Error('Payment declined');
            });

            const workflow = flow(step1, step2);
            try {
                await workflow.run({ sku: 'WIDGET-1', qty: 2, orderId: 'ORD-100' });
                expect.fail('Workflow should fail');
            } catch (err: any) {
                expect(err.message).to.equal('Payment declined');
                expect(log).to.deep.equal(['released:WIDGET-1:2:ORD-100']);
            }
        });

        it('supports .compensate(name, options) without a payload mapper', async () => {
            let receivedOutput: any = null;
            registerCompensationHandler('cancelTicket', async (payload: any) => {
                receivedOutput = payload;
            });

            const step1 = Step.create('issueTicket', () => ({ ticketNo: 'T-456' })).compensate('cancelTicket', {
                maxRetries: 0,
            });

            const step2 = Step.create('boom', () => {
                throw new Error('Crash');
            });

            try {
                await flow(step1, step2).run();
                expect.fail('Expected crash');
            } catch (err: any) {
                expect(err.message).to.equal('Crash');
                expect(receivedOutput).to.deep.equal({ ticketNo: 'T-456' });
            }
        });

        it('supports .compensate(name) with no options and no mapper', async () => {
            let ran = false;
            registerCompensationHandler('simpleComp', async () => {
                ran = true;
            });

            const step1 = Step.create('step1', () => ({ ok: true })).compensate('simpleComp');

            const step2 = Step.create('fail', () => {
                throw new Error('Fail');
            });

            try {
                await flow(step1, step2).run();
                expect.fail('Expected failure');
            } catch {
                expect(ran).to.be.true;
            }
        });
    });

    describe('UnresolvableCompensationException & No Silent Drops', () => {
        it('throws UnresolvableCompensationException when named handler is missing in strict mode', async () => {
            const step1 = Step.create('orderStep', () => ({ item: 'phone' })).compensate('nonExistentHandler');

            const step2 = Step.create('failStep', () => {
                throw new Error('Card expired');
            });

            try {
                await flow(step1, step2).run();
                expect.fail('Workflow should fail');
            } catch (err: any) {
                expect(err).to.be.instanceOf(CompensationException);
                const compEx = err as CompensationException;
                expect(compEx.compensationErrors).to.have.length(1);
                const firstErr = compEx.compensationErrors[0].error;
                expect(firstErr).to.be.instanceOf(UnresolvableCompensationException);
                expect(firstErr.name).to.equal('UnresolvableCompensationException');
                expect(firstErr.handlerName).to.equal('nonExistentHandler');
                expect(firstErr.phase).to.equal('compensation');
                expect(firstErr.retryable).to.be.false;
            }
        });

        it('constructs UnresolvableCompensationException with and without handlerName', () => {
            const ex1 = new UnresolvableCompensationException('stepA', 'handlerA', { stackId: 'stk-1' });
            expect(ex1.message).to.include("'handlerA'");
            expect(ex1.message).to.include("'stepA'");
            expect(ex1.handlerName).to.equal('handlerA');
            expect(ex1.stackId).to.equal('stk-1');

            const ex2 = new UnresolvableCompensationException('stepB');
            expect(ex2.message).to.include("for step 'stepB'");
            expect(ex2.handlerName).to.be.undefined;
        });
    });

    it('skips already completed compensation records', async () => {
        const stackId = 'already-completed-stack';
        defaultCompensationManager.registerCompensation(stackId, {
            stepId: 'step-already-done',
            stepName: 'doneStep',
            output: {},
            input: {},
            handler: () => {},
            status: Status.COMPLETED,
        });

        const result = await defaultCompensationManager.runCompensations(stackId);
        expect(result.completed).to.include('doneStep');
    });

    describe('Best-Effort Compensation Mode & Dead Letter Queue (DLQ)', () => {
        it('continues executing remaining compensations in best-effort mode and reports to DLQ', async () => {
            const dlqEntries: any[] = [];
            const dlq = {
                send: async (entry: any) => {
                    dlqEntries.push(entry);
                },
            };

            const onFailureCalls: any[] = [];
            const onFailure = (failed: any, err: any) => {
                onFailureCalls.push({ failed, err });
            };

            const executedCompensations: string[] = [];

            const stackId = 'stack-dlq-test';
            defaultCompensationManager.registerCompensation(stackId, {
                stepId: 's1',
                stepName: 'step1',
                output: { n: 1 },
                input: {},
                handler: async () => {
                    executedCompensations.push('step1');
                },
            });
            defaultCompensationManager.registerCompensation(stackId, {
                stepId: 's2',
                stepName: 'step2',
                output: { n: 2 },
                input: {},
                handler: async () => {
                    throw new Error('Comp 2 failed');
                },
            });
            defaultCompensationManager.registerCompensation(stackId, {
                stepId: 's3',
                stepName: 'step3',
                output: { n: 3 },
                input: {},
                handlerName: 'unregisteredCompHandler',
            });
            defaultCompensationManager.registerCompensation(stackId, {
                stepId: 's4',
                stepName: 'step4',
                output: { n: 4 },
                input: {},
                handler: async () => {
                    executedCompensations.push('step4');
                },
            });

            try {
                await defaultCompensationManager.runCompensations(stackId, new Error('Pipeline exploded'), {
                    mode: 'best-effort',
                    deadLetterQueue: dlq,
                    onFailure,
                });
                expect.fail('Should throw CompensationException');
            } catch (err: any) {
                expect(err).to.be.instanceOf(CompensationException);
                expect(err.message).to.include('One or more compensations failed (2/4)');
                // In LIFO order: s4 -> s3 (fails) -> s2 (fails) -> s1 (runs)
                expect(executedCompensations).to.deep.equal(['step4', 'step1']);
                expect(dlqEntries).to.have.length(2);
                expect(dlqEntries[0].stepName).to.equal('step3');
                expect(dlqEntries[1].stepName).to.equal('step2');
                expect(onFailureCalls).to.have.length(2);
            }
        });

        it('aborts at first failure in strict mode', async () => {
            const stackId = 'stack-strict-test';
            const executed: string[] = [];

            defaultCompensationManager.registerCompensation(stackId, {
                stepId: 's1',
                stepName: 'step1',
                output: {},
                input: {},
                handler: async () => {
                    executed.push('step1');
                },
            });
            defaultCompensationManager.registerCompensation(stackId, {
                stepId: 's2',
                stepName: 'step2',
                output: {},
                input: {},
                handler: async () => {
                    throw new Error('Strict failure');
                },
            });
            defaultCompensationManager.registerCompensation(stackId, {
                stepId: 's3',
                stepName: 'step3',
                output: {},
                input: {},
                handler: async () => {
                    executed.push('step3');
                },
            });

            try {
                await defaultCompensationManager.runCompensations(stackId, undefined, { mode: 'strict' });
                expect.fail('Should fail');
            } catch (err: any) {
                expect(err).to.be.instanceOf(CompensationException);
                // LIFO: s3 runs, s2 fails and aborts, s1 never runs
                expect(executed).to.deep.equal(['step3']);
            }
        });
    });

    describe('Checkpoint Hydration of Named Compensations', () => {
        it('serializes and hydrates handlerName and payload from checkpoint', async () => {
            let compensatedPayload: any = null;
            registerCompensationHandler('refundCharge', async (payload: any) => {
                compensatedPayload = payload;
            });

            const step1 = Step.create('chargeStep', () => ({ chargeId: 'ch_999', currency: 'usd' })).compensate(
                'refundCharge',
                out => ({ refundId: out.chargeId }),
            );

            const waitStep = Step.create('waitStep', () => {
                const err: any = new Error('Suspended');
                err.name = 'WorkflowSuspendedException';
                err.correlationKey = 'corr-phase4';
                throw err;
            });

            const wf = flow(step1, waitStep);
            const suspension = await wf.run({}, { durable: true });
            const stackId = suspension.stackId;

            // Check checkpoint metadata
            const cp = await defaultStorageManager.getCheckpoint(stackId);
            expect(cp?.metadata?.compensations).to.be.an('array');
            expect(cp?.metadata?.compensations[0].handlerName).to.equal('refundCharge');
            expect(cp?.metadata?.compensations[0].payload).to.deep.equal({ refundId: 'ch_999' });

            // Clear in-memory compensation manager
            defaultCompensationManager.clear();

            // Reconcile/compensate using flow.compensate
            const result = await wf.compensate(stackId);
            expect(result.completed).to.include('chargeStep');
            expect(compensatedPayload).to.deep.equal({ refundId: 'ch_999' });
        });
    });

    describe('Abandoned Stack Reconciler & Storage getAllStacks', () => {
        it('returns all stacks via defaultStorageManager.getAllStacks()', () => {
            const stackId = defaultStorageManager.createStack('test-stack-storage');
            const all = defaultStorageManager.getAllStacks();
            expect(all).to.be.an('array');
            expect(all.some(s => s.stackId === stackId)).to.be.true;
        });

        it('inspects stale stacks without modifying them in inspect action', async () => {
            const now = Date.now();
            const staleTime = now - 20 * 60 * 1000; // 20 min ago

            const dummyStacks = [
                { stackId: 'stale-1', status: Status.RUNNING, timestamp: staleTime, workflowId: 'wf-1' },
                { stackId: 'fresh-1', status: Status.RUNNING, timestamp: now - 1000, workflowId: 'wf-2' },
                { stackId: 'completed-1', status: Status.COMPLETED, timestamp: staleTime, workflowId: 'wf-3' },
            ];

            const report = await reconcileAbandonedStacks({
                staleThresholdMs: 10 * 60 * 1000,
                action: 'inspect',
                stacks: dummyStacks,
            });

            expect(report.inspected).to.equal(3);
            expect(report.staleStacks).to.have.length(1);
            expect(report.staleStacks[0].stackId).to.equal('stale-1');
            expect(report.reconciled).to.have.length(0);
        });

        it('transitions stale stacks to FAILED in fail action', async () => {
            const staleTime = Date.now() - 15 * 60 * 1000;
            const stackId = 'abandoned-fail-stack';

            defaultStorageManager.createStack(stackId);
            const stack = defaultStorageManager.getStack(stackId);
            stack.timestamp = staleTime;

            const report = await reconcileAbandonedStacks({
                staleThresholdMs: 10 * 60 * 1000,
                action: 'fail',
            });

            expect(report.staleStacks.some(s => s.stackId === stackId)).to.be.true;
            expect(report.reconciled).to.include(stackId);

            expect(stack.status).to.equal(Status.FAILED);
        });

        it('triggers compensations for stale stacks in compensate action', async () => {
            const staleTime = Date.now() - 15 * 60 * 1000;
            const stackId = 'abandoned-compensate-stack';
            let compensated = false;

            registerCompensationHandler('reconcileComp', async () => {
                compensated = true;
            });

            defaultStorageManager.createStack(stackId);
            const stack = defaultStorageManager.getStack(stackId);
            stack.timestamp = staleTime;
            stack.metadata = {
                compensations: [
                    {
                        stepId: 'step-abandoned',
                        stepName: 'abandonedStep',
                        output: { x: 1 },
                        input: {},
                        handlerName: 'reconcileComp',
                    },
                ],
            };

            const report = await reconcileAbandonedStacks({
                staleThresholdMs: 10 * 60 * 1000,
                action: 'compensate',
            });

            expect(report.reconciled).to.include(stackId);
            expect(compensated).to.be.true;
            expect(stack.status).to.equal(Status.FAILED);
        });

        it('filters stacks by namespace', async () => {
            const staleTime = Date.now() - 15 * 60 * 1000;
            const stacks = [
                { stackId: 'ns-target', namespace: 'tenant-a', status: Status.RUNNING, timestamp: staleTime },
                { stackId: 'ns-other', namespace: 'tenant-b', status: Status.RUNNING, timestamp: staleTime },
            ];

            const report = await reconcileAbandonedStacks({
                staleThresholdMs: 10 * 60 * 1000,
                action: 'fail',
                namespace: 'tenant-a',
                stacks,
            });

            expect(report.staleStacks).to.have.length(1);
            expect(report.staleStacks[0].stackId).to.equal('ns-target');
        });

        it('records failed reconciliations when compensation cannot resolve handler', async () => {
            const staleTime = Date.now() - 15 * 60 * 1000;
            const stackId = 'abandoned-unresolvable';

            defaultStorageManager.createStack(stackId);
            const stack = defaultStorageManager.getStack(stackId);
            stack.timestamp = staleTime;
            stack.metadata = {
                compensations: [
                    {
                        stepId: 'step-missing',
                        stepName: 'missingStep',
                        output: {},
                        input: {},
                        handlerName: 'nonExistentReconcileHandler',
                    },
                ],
            };

            const report = await reconcileAbandonedStacks({
                staleThresholdMs: 10 * 60 * 1000,
                action: 'compensate',
                mode: 'strict',
            });

            expect(report.failed).to.have.length(1);
            expect(report.failed[0].stackId).to.equal(stackId);
        });

        it('reconciles using flowLookup if flow is provided', async () => {
            const staleTime = Date.now() - 15 * 60 * 1000;
            const stackId = 'abandoned-flow-lookup';
            let flowCompCalled = false;

            const dummyFlow = {
                compensate: async (id: string) => {
                    expect(id).to.equal(stackId);
                    flowCompCalled = true;
                    return { completed: ['stepA'], failed: [] };
                },
            };

            const stacks = [{ stackId, workflowId: 'wf-lookup', status: Status.RUNNING, timestamp: staleTime }];

            const report = await reconcileAbandonedStacks({
                staleThresholdMs: 10 * 60 * 1000,
                action: 'compensate',
                stacks,
                flowLookup: (wfId: any) => (wfId === 'wf-lookup' ? dummyFlow : undefined),
            });

            expect(flowCompCalled).to.be.true;
            expect(report.reconciled).to.include(stackId);
        });
        it('registers compensation for reducer steps and handles throwing payload mapper safely', async () => {
            const stackId = 'reducer-comp-stack';
            let compensated = false;

            registerCompensationHandler('refundItems', async (payload: any) => {
                compensated = true;
                expect(payload.refundAmount).to.equal(50);
            });

            const throwingStep = Step.create('throwingCompStep', () => ({ processed: true })).compensate(
                'refundItems',
                () => {
                    throw new Error('Mapper exploded');
                },
            );

            // Throwing mapper should be caught safely without unhandled rejection
            const throwRes: any = await throwingStep.execute({}, { stackId: 'throwing-stack' });
            expect(throwRes.processed).to.be.true;

            const reducerStep = Step.create('reduceCompStep', (param: any, current: any) => {
                return (param.value || 0) + current;
            })
                .reduce('items')
                .compensate('refundItems', (output: any) => ({ refundAmount: output.value * 10 }));

            await reducerStep.execute({ items: [2, 3] }, { stackId });

            const report = await defaultCompensationManager.runCompensations(stackId);
            expect(report.completed).to.include('reduceCompStep');
            expect(compensated).to.be.true;
        });
    });
    describe('Compensation recovery without serialized functions', () => {
        it('recovers inline and named handlers from workflow steps after restart', async () => {
            const restored: string[] = [];
            registerCompensationHandler('release-restored', () => {
                restored.push('named');
            });
            const inline = Step.create('inline-restored', () => ({})).compensate(() => {
                restored.push('inline');
            });
            const named = Step.create('named-restored', () => ({})).compensate('release-restored');
            const workflow = flow(inline, named);
            const original = defaultStorageManager.getCheckpoint;
            defaultStorageManager.getCheckpoint = async () =>
                ({
                    metadata: {
                        compensations: [
                            { stepId: 'old-inline-id', stepName: 'inline-restored', output: {}, input: {} },
                            { stepId: 'old-named-id', stepName: 'named-restored', output: {}, input: {} },
                        ],
                    },
                }) as any;
            try {
                const result = await workflow.compensate('restored-handler-stack');
                expect(result.failed).to.deep.equal([]);
                expect(restored).to.deep.equal(['named', 'inline']);
            } finally {
                defaultStorageManager.getCheckpoint = original;
            }
        });

        it('rejects recovery when a persisted compensation has no resolvable handler', async () => {
            const original = defaultStorageManager.getCheckpoint;
            defaultStorageManager.getCheckpoint = async () =>
                ({
                    metadata: {
                        compensations: [{ stepId: 'removed-id', stepName: 'removed-step', output: {}, input: {} }],
                    },
                }) as any;
            try {
                try {
                    await flow(Step.create('remaining-step', () => ({}))).compensate('missing-handler-stack');
                    expect.fail('Expected unresolved compensation to reject');
                } catch (error) {
                    expect(error).to.be.instanceOf(UnresolvableCompensationException);
                }
            } finally {
                defaultStorageManager.getCheckpoint = original;
            }
        });

        it('tolerates an unavailable checkpoint when no compensations are registered', async () => {
            const original = defaultStorageManager.getCheckpoint;
            defaultStorageManager.getCheckpoint = async () => {
                throw new Error('storage offline');
            };
            try {
                const result = await flow(Step.create('empty-recovery', () => ({}))).compensate(
                    'offline-checkpoint-stack',
                );
                expect(result).to.deep.equal({ completed: [], failed: [] });
            } finally {
                defaultStorageManager.getCheckpoint = original;
            }
        });
    });
});
