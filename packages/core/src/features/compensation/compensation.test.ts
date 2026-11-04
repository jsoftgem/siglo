import { expect } from 'chai';
import {
    Step,
    flow,
    defaultCompensationManager,
    CompensationException,
    clearStorage,
    defaultStorageManager
} from '../../index';

describe('Compensation and Sagas Unit Tests', () => {
    beforeEach(() => {
        clearStorage();
        defaultCompensationManager.clear();
    });

    afterEach(() => {
        clearStorage();
        defaultCompensationManager.clear();
    });

    it('executes compensations in reverse order (LIFO) when flow fails', async () => {
        const executionOrder: string[] = [];
        const compensationOrder: string[] = [];

        // Step 1: Reserve Inventory
        const reserveStep = Step.create('reserveInventory', ({ item }: any) => {
                executionOrder.push('reserveInventory');
                return { item, reserved: true };
            })
            .compensate(async (output: any, input: any) => {
                compensationOrder.push(`release:${output.item}`);
                expect(input.item).to.equal('laptop');
            });

        // Step 2: Authorize Payment
        const paymentStep = Step.create('authorizePayment', () => {
                executionOrder.push('authorizePayment');
                return { chargeId: 'ch_123', paid: true };
            })
            .compensate(async (output: any) => {
                compensationOrder.push(`refund:${output.chargeId}`);
            });

        // Step 3: Ship Goods (Fails!)
        const shipStep = Step.create('shipGoods', () => {
                executionOrder.push('shipGoods');
                throw new Error('Out of delivery slots');
            });

        const orderWorkflow = flow(reserveStep, paymentStep, shipStep);

        try {
            await orderWorkflow.execute({ item: 'laptop' });
            expect.fail('Workflow should have rejected');
        } catch (err: any) {
            expect(err.message).to.equal('Out of delivery slots');
            // Execution order
            expect(executionOrder).to.deep.equal(['reserveInventory', 'authorizePayment', 'shipGoods']);
            // Compensations executed in reverse order (LIFO): payment refunded, then inventory released!
            expect(compensationOrder).to.deep.equal(['refund:ch_123', 'release:laptop']);
        }
    });

    it('supports compensation retry policy when compensation handler transiently fails', async () => {
        let compAttempts = 0;

        const flakyCompensationStep = Step.create('flakyService', () => ({ data: 'ok' }))
            .compensate(async () => {
                compAttempts++;
                if (compAttempts < 2) throw new Error('Transient DB timeout');
            }, { maxRetries: 2, delay: 10 });

        const failingDownstream = Step.create('failStep', () => {
            throw new Error('Downstream boom');
        });

        try {
            await flow(flakyCompensationStep, failingDownstream).execute();
            expect.fail('Should have failed');
        } catch (err: any) {
            expect(err.message).to.equal('Downstream boom');
            expect(compAttempts).to.equal(2);
        }
    });

    it('throws CompensationException when a compensation fails and exhausts retries', async () => {
        const badCompStep = Step.create('stepWithFailingCompensation', () => ({ ready: true }))
            .compensate(() => {
                throw new Error('Compensation network dropped');
            });

        const failingStep = Step.create('failingStep', () => {
            throw new Error('Primary error');
        });

        try {
            await flow(badCompStep, failingStep).execute();
            expect.fail('Should throw CompensationException');
        } catch (err: any) {
            expect(err).to.be.instanceOf(CompensationException);
            expect(err.name).to.equal('CompensationException');
            expect((err as CompensationException).originalError).to.be.instanceOf(Error);
            expect(((err as CompensationException).originalError as Error).message).to.equal('Primary error');
            expect((err as CompensationException).compensationErrors).to.have.length(1);
            expect((err as CompensationException).compensationErrors[0].stepName).to.equal('stepWithFailingCompensation');
        }
    });

    it('supports manual compensation execution via defaultCompensationManager and flow.compensate', async () => {
        let compensated = false;
        const stackId = 'manual-saga-stack';

        defaultCompensationManager.registerCompensation(stackId, {
            stepId: 'step-manual',
            stepName: 'manualStep',
            output: { id: 10 },
            input: {},
            handler: async () => {
                compensated = true;
            }
        });

        const f = flow(Step.create('dummy'));
        const result = await f.compensate(stackId);
        expect(result.completed).to.include('manualStep');
        expect(compensated).to.be.true;
    });

    it('supports compensations defined as Step/Flow instances with execute method', async () => {
        let stepCompRan = false;
        const compStep = Step.create('undo', () => {
            stepCompRan = true;
        });

        const mainStep = Step.create('main', () => ({ val: 1 }))
            .compensate(compStep);

        const failStep = Step.create('fail', () => {
            throw new Error('Error');
        });

        try {
            await flow(mainStep, failStep).execute();
            expect.fail('Should fail');
        } catch {
            expect(stepCompRan).to.be.true;
        }
    });

    it("handles already-completed records and retryIf abort in compensation manager", async () => {
        const stackId = "test-manager-edge";
        defaultCompensationManager.registerCompensation(stackId, {
            stepId: "comp-1",
            stepName: "alreadyCompleted",
            output: {},
            input: {},
            handler: () => {},
            status: "completed"
        });

        let attempts = 0;
        defaultCompensationManager.registerCompensation(stackId, {
            stepId: "comp-2",
            stepName: "retryIfStep",
            output: {},
            input: {},
            options: {
                maxRetries: 3,
                retryIf: () => false
            },
            handler: () => {
                attempts++;
                throw new Error("Fatal non-retryable");
            }
        });

        try {
            await defaultCompensationManager.runCompensations(stackId);
            expect.fail("Should fail");
        } catch (err: any) {
            expect(err).to.be.instanceOf(CompensationException);
            expect(attempts).to.equal(1);
        }
    });

    it('clear() removes all registered compensations across all stacks', () => {
        defaultCompensationManager.registerCompensation('stack-clear-1', {
            stepId: 's1',
            stepName: 'step1',
            output: {},
            input: {},
            handler: () => {}
        });
        defaultCompensationManager.registerCompensation('stack-clear-2', {
            stepId: 's2',
            stepName: 'step2',
            output: {},
            input: {},
            handler: () => {}
        });

        expect(defaultCompensationManager.getCompensations('stack-clear-1')).to.have.length(1);
        expect(defaultCompensationManager.getCompensations('stack-clear-2')).to.have.length(1);

        defaultCompensationManager.clear();

        expect(defaultCompensationManager.getCompensations('stack-clear-1')).to.have.length(0);
        expect(defaultCompensationManager.getCompensations('stack-clear-2')).to.have.length(0);
    });

    it('hydrates compensations from checkpoint metadata when in-memory registry is cleared', async () => {
        let compensated = false;

        const step1 = Step.create('bookHotel', () => ({ bookingId: 'hotel-123' }))
            .compensate(async () => {
                compensated = true;
            });
        const waitStep = Step.create('waitConfirm', () => {
            const err: any = new Error('Suspended');
            err.name = 'WorkflowSuspendedException';
            err.correlationKey = 'corr-hydrate';
            throw err;
        });

        const f = flow(step1, waitStep);
        const suspension = await f.run({}, { durable: true });
        const stackId = suspension.stackId;

        // Verify checkpoint contains compensations
        const cp = await defaultStorageManager.getCheckpoint(stackId);
        expect(cp?.metadata?.compensations).to.be.an('array');
        expect(cp?.metadata?.compensations).to.have.length(1);

        // Clear in-memory compensation registry to simulate node restart
        defaultCompensationManager.clear();
        expect(defaultCompensationManager.getCompensations(stackId)).to.have.length(0);

        // Call f.compensate: should hydrate and execute!
        const result = await f.compensate(stackId);
        expect(result.completed).to.include('bookHotel');
        expect(compensated).to.be.true;
    });
});
