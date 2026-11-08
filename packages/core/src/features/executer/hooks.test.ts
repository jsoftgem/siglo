import { expect } from 'chai';
import { Step, flow } from '../step';
import { branch, when, parallel } from '../combinators';
import {
    stepExecutionHookStorage,
    withStepExecutionHook,
    getStepExecutionHook,
    StepExecutionContext,
    StepExecutionHook,
} from './hooks';

describe('StepExecutionHook & Runtime Hooks', () => {
    it('provides getStepExecutionHook and withStepExecutionHook scoping', () => {
        expect(getStepExecutionHook()).to.be.undefined;
        expect(Step.getStepExecutionHook()).to.be.undefined;
        const dummyHook: StepExecutionHook = (_ctx, next) => next();
        withStepExecutionHook(dummyHook, () => {
            expect(getStepExecutionHook()).to.equal(dummyHook);
            expect(Step.getStepExecutionHook()).to.equal(dummyHook);
            expect(stepExecutionHookStorage.getStore()).to.equal(dummyHook);
        });
        expect(getStepExecutionHook()).to.be.undefined;
    });

    it('intercepts direct steps when registered via flow.hook()', async () => {
        const events: string[] = [];
        const step1 = Step.create('step1', async () => {
            events.push('exec:step1');
            return { s1: true };
        });
        const step2 = Step.create('step2', async () => {
            events.push('exec:step2');
            return { s2: true };
        });

        const hook: StepExecutionHook = async (ctx, next) => {
            events.push(`hook:before:${ctx.stepName}`);
            const result = await next();
            events.push(`hook:after:${ctx.stepName}`);
            return result;
        };

        const wf = flow(step1, step2).hook(hook);
        expect(wf.stepExecutionHook).to.equal(hook);

        const result = await wf.run({});
        expect(result.s1).to.be.true;
        expect(result.s2).to.be.true;
        expect(events).to.deep.equal([
            'hook:before:step1',
            'exec:step1',
            'hook:after:step1',
            'hook:before:step2',
            'exec:step2',
            'hook:after:step2',
        ]);
    });

    it('intercepts steps when passed via execution options', async () => {
        const intercepted: string[] = [];
        const step = Step.create('optStep', async (p: any) => ({ val: p.input * 2 }));

        const hook: StepExecutionHook = async (ctx, next) => {
            intercepted.push(ctx.stepName);
            expect(ctx.stepId).to.be.a('string');
            expect(ctx.attempt).to.equal(1);
            return next();
        };

        const wf = flow(step);
        const res = await wf.run({ input: 21 }, { stepExecutionHook: hook });
        expect(res.val).to.equal(42);
        expect(intercepted).to.deep.equal(['optStep']);
    });

    it('intercepts steps when Step.start is called directly with stepExecutionHook', async () => {
        const intercepted: string[] = [];
        const step = Step.create('directStep', async () => ({ direct: true }));
        const hook: StepExecutionHook = async (ctx, next) => {
            intercepted.push(ctx.stepName);
            return next();
        };

        const res: any = await Step.start(step, {}, { stepExecutionHook: hook });
        expect(res.direct).to.be.true;
        expect(intercepted).to.deep.equal(['directStep']);
    });

    it('computes attempt from function on initialParam when executing hook', async () => {
        let seenAttempt = 0;
        const step = Step.create('attemptStep', async () => ({ ok: true }));
        const hook: StepExecutionHook = async (ctx, next) => {
            seenAttempt = ctx.attempt;
            return next();
        };
        const wf = flow(step);
        await wf.run({ $attempt: () => 2 }, { stepExecutionHook: hook });
        expect(seenAttempt).to.equal(3);
    });

    it('automatically wraps nested branch and when combinator targets', async () => {
        const executedHooks: string[] = [];
        const reserveStock = Step.create('reserveStock', async () => ({ reserved: true }));
        const queueReview = Step.create('queueReview', async () => ({ review: true }));
        const cancelOrder = Step.create('cancelOrder', async () => ({ cancelled: true }));

        const placedOrder = when((o: any) => o.amount >= 1000, queueReview, reserveStock);

        const wf = flow(
            branch((e: any) => e.type, {
                'order.placed': placedOrder,
                'order.cancelled': cancelOrder,
            }),
        );

        const hook: StepExecutionHook = async (ctx, next) => {
            executedHooks.push(ctx.stepName);
            return next();
        };

        // Test route 1: order.placed with amount < 1000 -> reserveStock
        await withStepExecutionHook(hook, async () => {
            const res1 = await wf.run({ type: 'order.placed', amount: 500 });
            expect(res1.reserved).to.be.true;
        });

        expect(executedHooks).to.deep.equal(['branch', 'when', 'reserveStock']);

        executedHooks.length = 0;

        // Test route 2: order.placed with amount >= 1000 -> queueReview
        await withStepExecutionHook(hook, async () => {
            const res2 = await wf.run({ type: 'order.placed', amount: 5000 });
            expect(res2.review).to.be.true;
        });

        expect(executedHooks).to.deep.equal(['branch', 'when', 'queueReview']);

        executedHooks.length = 0;

        // Test route 3: order.cancelled -> cancelOrder
        await withStepExecutionHook(hook, async () => {
            const res3 = await wf.run({ type: 'order.cancelled' });
            expect(res3.cancelled).to.be.true;
        });

        expect(executedHooks).to.deep.equal(['branch', 'cancelOrder']);
    });

    it('intercepts steps inside parallel branches', async () => {
        const tracked: string[] = [];
        const taskA = Step.create('taskA', async () => ({ a: 1 }));
        const taskB = Step.create('taskB', async () => ({ b: 2 }));

        const wf = flow(parallel(taskA, taskB));
        const hook: StepExecutionHook = async (ctx, next) => {
            tracked.push(ctx.stepName);
            return next();
        };

        await withStepExecutionHook(hook, async () => {
            const res = await wf.run({});
            expect(res.a).to.equal(1);
            expect(res.b).to.equal(2);
        });

        expect(tracked).to.include('parallel');
        expect(tracked).to.include('taskA');
        expect(tracked).to.include('taskB');
    });

    it('intercepts reducer step iterations', async () => {
        const reducerSteps: number[] = [];
        const step = Step.create('sumStep', (param: any, current: number, index?: number) => {
            return { total: (param.total || 0) + current };
        }).reduce('items');

        const hook: StepExecutionHook = async (ctx, next) => {
            if (ctx.index !== undefined) {
                reducerSteps.push(ctx.index);
            }
            return next();
        };

        const wf = flow(step);
        const res = await withStepExecutionHook(hook, async () => {
            return wf.run({ items: [10, 20, 30] });
        });

        expect(res.total).to.equal(60);
        expect(reducerSteps).to.deep.equal([0, 1, 2]);
    });

    it('propagates errors thrown inside hook or action', async () => {
        const failStep = Step.create('failStep', async () => {
            throw new Error('boom in action');
        });

        const hook: StepExecutionHook = async (ctx, next) => {
            return next();
        };

        const wf = flow(failStep).hook(hook);
        let errorCaught: any;
        try {
            await wf.run({});
        } catch (err) {
            errorCaught = err;
        }
        expect(errorCaught).to.exist;
        expect(errorCaught.message).to.include('boom in action');
    });

    it('exposes Step static methods for execution hooks', () => {
        expect(Step.withStepExecutionHook).to.equal(withStepExecutionHook);
        expect(Step.getStepExecutionHook).to.equal(getStepExecutionHook);
        expect(Step.stepExecutionHookStorage).to.equal(stepExecutionHookStorage);
    });
});
