import { expect } from 'chai';
import {
    Step,
    flow,
    waitForEvent,
    wait,
    parseDuration,
    defaultDurableManager,
    resumeWorkflow,
    DuplicateEventException,
    ExpiredWaitException,
    WorkflowVersionMismatchException,
    defaultStorageManager,
    validateWorkflowVersion,
    clearStorage
} from '../../index';

describe('Durable Waits, External Events, and Versioning Tests', () => {
    beforeEach(() => {
        clearStorage();
        defaultDurableManager.clear();
    });

    afterEach(() => {
        clearStorage();
        defaultDurableManager.clear();
    });

    describe('Duration Parser', () => {
        it('parses days, hours, minutes, seconds, milliseconds, and numeric values', () => {
            expect(parseDuration('1d')).to.equal(86400000);
            expect(parseDuration('2h')).to.equal(7200000);
            expect(parseDuration('15m')).to.equal(900000);
            expect(parseDuration('30s')).to.equal(30000);
            expect(parseDuration('500ms')).to.equal(500);
            expect(parseDuration(1234)).to.equal(1234);
            expect(parseDuration(undefined)).to.be.undefined;
        });
    });

    describe('Durable Workflow Wait & Suspension', () => {
        it('non-durable execution passes through wait and waitForEvent without suspending', async () => {
            const stepWait = wait(10);
            const resWait = await flow(stepWait).execute({}, { pojo: true });
            expect(resWait.waitedMs).to.equal(10);

            const stepEvent = waitForEvent('order.shipped', { correlationKey: 'ord-1' });
            const resEvent = await flow(stepEvent).execute({}, { pojo: true });
            expect(resEvent.waited).to.be.true;
        });

        it('durable execution pauses at waitForEvent, checkpoints status as waiting, and returns suspension descriptor', async () => {
            const step1 = Step.create('validateOrder').onStart(({ orderId, amount }: any) => {
                return { orderId, amount, validated: true };
            });

            const stepWait = waitForEvent('payment.authorized', {
                correlationKey: (ctx) => `order:${ctx.orderId}`,
                timeout: '1h'
            });

            const step3 = Step.create('fulfillOrder').onStart(({ orderId, authCode }: any) => {
                return { orderId, fulfilled: true, authCode };
            });

            const workflow = flow(step1, stepWait, step3).version('1.0.0');

            const suspensionResult = await workflow.run({ orderId: 'ord-999', amount: 250 }, {
                durable: true,
                pojo: true
            });

            expect(suspensionResult.status).to.equal('waiting');
            expect(suspensionResult.correlationKey).to.equal('order:ord-999');
            expect(suspensionResult.eventName).to.equal('payment.authorized');
            expect(suspensionResult.stackId).to.be.a('string');

            // Verify wait record in DurableManager
            const record = defaultDurableManager.getWaiting('order:ord-999');
            expect(record).to.be.an('object');
            expect(record?.status).to.equal('waiting');
            expect(record?.continuationStepIndex).to.equal(2);

            // Verify checkpoint in StorageManager
            const cp = await defaultStorageManager.getCheckpoint(suspensionResult.stackId);
            expect(cp?.status).to.equal('waiting');
            const hasValidated = Object.values(cp?.contexts || {}).some((ctx: any) => ctx.validated === true);
            expect(hasValidated).to.equal(true);
        });

        it('durable wait timer pauses execution and returns suspension descriptor', async () => {
            const stepTimer = wait(1000);
            const res = await flow(stepTimer).run({}, { durable: true, pojo: true });
            expect(res.status).to.equal('waiting');
            expect(res.eventName).to.equal('timer');
            expect(res.correlationKey).to.be.a('string');
        });
    });

    describe('Resume API and Event Safety', () => {
        it('resumeWorkflow resumes waiting workflow with event payload and finishes remaining steps', async () => {
            const step1 = Step.create('step1').onStart(() => ({ step1Done: true }));
            const waitStep = waitForEvent('user.verified', {
                correlationKey: (ctx) => `user:${ctx.userId}`
            });
            const step2 = Step.create('step2').onStart((ctx: any) => ({
                step2Done: true,
                verifiedBy: ctx.verifiedBy
            }));

            const userWorkflow = flow(step1, waitStep, step2);

            // 1. Run durable workflow until suspension
            const suspended = await userWorkflow.run({ userId: 'u-123' }, { durable: true, pojo: true });
            expect(suspended.status).to.equal('waiting');

            // 2. Resume workflow via flow.resume() with external event payload
            const finalResult = await userWorkflow.resume('user:u-123', {
                verifiedBy: 'admin@corp.com'
            }, { pojo: true });

            expect(finalResult.step1Done).to.equal(true);
            expect(finalResult.step2Done).to.equal(true);
            expect(finalResult.verifiedBy).to.equal('admin@corp.com');
        });

        it('resumeWorkflow can also resume using stackId', async () => {
            const waitStep = waitForEvent('signal.ready', {
                correlationKey: 'sig-1'
            });
            const afterStep = Step.create('after').onStart((ctx: any) => ({ completed: true, token: ctx.token }));

            const f = flow(waitStep, afterStep);
            const suspended = await f.run({}, { durable: true, pojo: true });

            const res = await resumeWorkflow(f, suspended.stackId, { token: 'jwt-xyz' }, { pojo: true });
            expect(res.completed).to.equal(true);
            expect(res.token).to.equal('jwt-xyz');
        });

        it('rejects duplicate resume with DuplicateEventException', async () => {
            const waitStep = waitForEvent('ticket.approved', { correlationKey: 't-1' });
            const f = flow(waitStep);
            await f.run({}, { durable: true });

            // First resume succeeds
            await f.resume('t-1');

            // Second duplicate resume must fail safely
            try {
                await f.resume('t-1');
                expect.fail('Should have rejected duplicate event');
            } catch (err: any) {
                expect(err).to.be.instanceOf(DuplicateEventException);
                expect(err.correlationKey).to.equal('t-1');
            }
        });

        it('rejects expired event wait with ExpiredWaitException', async () => {
            const waitStep = waitForEvent('short.window', {
                correlationKey: 'exp-key',
                timeoutMs: 15 // 15ms TTL
            });
            const f = flow(waitStep);
            await f.run({}, { durable: true });

            // Wait until expired
            await new Promise(r => setTimeout(r, 25));

            try {
                await f.resume('exp-key');
                expect.fail('Should have rejected expired wait');
            } catch (err: any) {
                expect(err).to.be.instanceOf(ExpiredWaitException);
                expect(err.correlationKey).to.equal('exp-key');
            }
        });
    });

    describe('Workflow Versioning & Migrations', () => {
        it('resumes successfully when workflow versions match', async () => {
            const waitStep = waitForEvent('ev', { correlationKey: 'ver-match' });
            const f = flow(waitStep, Step.create('ok').onStart(() => ({ ok: true }))).version('2.1.0');

            await f.run({}, { durable: true });
            const res = await f.resume('ver-match', {}, { pojo: true });
            expect(res.ok).to.equal(true);
        });

        it('rejects resumption when workflow versions mismatch and no migration is provided', async () => {
            const waitStep = waitForEvent('ev', { correlationKey: 'ver-mismatch' });
            const v1Flow = flow(waitStep).version('1.0.0');
            await v1Flow.run({}, { durable: true });

            // Now a v2.0.0 deployment tries to resume v1.0.0 state without migration
            const v2Flow = flow(waitStep, Step.create('next')).version('2.0.0');
            try {
                await v2Flow.resume('ver-mismatch');
                expect.fail('Should have thrown WorkflowVersionMismatchException');
            } catch (err: any) {
                expect(err).to.be.instanceOf(WorkflowVersionMismatchException);
                expect(err.expectedVersion).to.equal('2.0.0');
                expect(err.actualVersion).to.equal('1.0.0');
            }
        });

        it('applies state migration function on version upgrade when resuming', async () => {
            const s1 = Step.create('init').onStart(() => ({ user_name: 'John Doe' }));
            const waitStep = waitForEvent('ev', { correlationKey: 'migrate-key' });
            const s2 = Step.create('finish').onStart((ctx: any) => ({
                displayName: ctx.user?.name
            }));

            // Version 1.0.0 ran and suspended
            const v1 = flow(s1, waitStep).version('1.0.0');
            await v1.run({}, { durable: true });

            // Version 2.0.0 expects { user: { name } } instead of flat { user_name }
            const v2 = flow(waitStep, s2).version('2.0.0');

            const res = await v2.resume('migrate-key', {}, {
                pojo: true,
                migrations: {
                    '1.0.0->2.0.0': (_fromVer: any, _toVer: any, oldState: any) => {
                        return {
                            user: { name: oldState.user_name }
                        };
                    }
                }
            });

            expect(res.displayName).to.equal('John Doe');
        });
        it("covers validateWorkflowVersion equality and function migrations", () => {
            const state = { a: 1 };
            expect(validateWorkflowVersion("1.0", "1.0", undefined, state)).to.equal(state);
            expect(validateWorkflowVersion(undefined, "1.0", undefined, state)).to.equal(state);
            const migrated = validateWorkflowVersion("2.0", "1.0", (_from, _to, s) => ({ ...s, migrated: true }), state);
            expect(migrated).to.deep.equal({ a: 1, migrated: true });
            expect(defaultDurableManager.size).to.be.a("number");
        });

        it("resumeWorkflow supports flow containing only continuation step", async () => {
            const waitStep = waitForEvent("step.alone", { correlationKey: "alone-key" });
            const origFlow = flow(waitStep);
            await origFlow.run({}, { durable: true });

            const contStep = Step.create("contOnly").onStart(() => ({ done: true }));
            const contFlow = flow(contStep);
            const res = await resumeWorkflow(contFlow, "alone-key", {}, { pojo: true });
            expect(res.done).to.equal(true);
        });
    });
});
