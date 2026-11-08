import { expect } from 'chai';
import {
    Step,
    flow,
    waitForEvent,
    wait,
    parseDuration,
    DurableManager,
    defaultDurableManager,
    resumeWorkflow,
    DuplicateEventException,
    ExpiredWaitException,
    WorkflowVersionMismatchException,
    defaultStorageManager,
    validateWorkflowVersion,
    clearStorage,
    WorkflowEventEmitter,
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
            const resWait = await flow(stepWait).run({}, { pojo: true });
            expect(resWait.waitedMs).to.equal(10);

            const stepEvent = waitForEvent('order.shipped', { correlationKey: 'ord-1' });
            const resEvent = await flow(stepEvent).run({}, { pojo: true });
            expect(resEvent.waited).to.be.true;
        });

        it('durable execution pauses at waitForEvent, checkpoints status as waiting, and returns suspension descriptor', async () => {
            const step1 = Step.create('validateOrder', ({ orderId, amount }: any) => {
                return { orderId, amount, validated: true };
            });

            const stepWait = waitForEvent('payment.authorized', {
                correlationKey: ctx => `order:${ctx.orderId}`,
                timeout: '1h',
            });

            const step3 = Step.create('fulfillOrder', ({ orderId, authCode }: any) => {
                return { orderId, fulfilled: true, authCode };
            });

            const workflow = flow(step1, stepWait, step3).version('1.0.0');

            const suspensionResult = await workflow.run(
                { orderId: 'ord-999', amount: 250 },
                {
                    durable: true,
                    pojo: true,
                },
            );

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
            const step1 = Step.create('step1', () => ({ step1Done: true }));
            const waitStep = waitForEvent('user.verified', {
                correlationKey: ctx => `user:${ctx.userId}`,
            });
            const step2 = Step.create('step2', (ctx: any) => ({
                step2Done: true,
                verifiedBy: ctx.verifiedBy,
            }));

            const userWorkflow = flow(step1, waitStep, step2);

            // 1. Run durable workflow until suspension
            const suspended = await userWorkflow.run({ userId: 'u-123' }, { durable: true, pojo: true });
            expect(suspended.status).to.equal('waiting');

            // 2. Resume workflow via flow.resume() with external event payload
            const finalResult = await userWorkflow.resume(
                'user:u-123',
                {
                    verifiedBy: 'admin@corp.com',
                },
                { pojo: true },
            );

            expect(finalResult.step1Done).to.equal(true);
            expect(finalResult.step2Done).to.equal(true);
            expect(finalResult.verifiedBy).to.equal('admin@corp.com');
        });

        it('resumeWorkflow can also resume using stackId', async () => {
            const waitStep = waitForEvent('signal.ready', {
                correlationKey: 'sig-1',
            });
            const afterStep = Step.create('after', (ctx: any) => ({ completed: true, token: ctx.token }));

            const f = flow(waitStep, afterStep);
            const suspended = await f.run({}, { durable: true, pojo: true });

            const res = await resumeWorkflow(f, suspended.stackId, { token: 'jwt-xyz' }, { pojo: true });
            expect(res.completed).to.equal(true);
            expect(res.token).to.equal('jwt-xyz');
        });

        it('resumeWorkflow emits flow:resumed and attaches monitor to resumed flow', async () => {
            const events: any[] = [];
            const emitter = new WorkflowEventEmitter();
            emitter.on('*', ev => events.push(ev));

            const waitStep = waitForEvent('signal.monitored', {
                correlationKey: 'sig-mon-1',
            });
            const afterStep = Step.create('after', (ctx: any) => ({ completed: true, token: ctx.token }));

            const f = flow(waitStep, afterStep);
            f.monitor(emitter);
            const suspended = await f.run({}, { durable: true, pojo: true });

            const res = await resumeWorkflow(f, suspended.stackId, { token: 'jwt-mon' }, { pojo: true });
            expect(res.completed).to.equal(true);
            expect(events.some(e => e.type === 'flow:resumed')).to.be.true;
            expect(events.some(e => e.type === 'step:complete' && e.stepName === 'after')).to.be.true;
            expect(events.some(e => e.type === 'flow:complete')).to.be.true;
        });

        it('supports atomic claimWaitRecord via storage adapter and hydrates $steps accessors', async () => {
            let claimed = false;
            let storedStackId = '';
            const mockAdapter = {
                name: 'mock-atomic-adapter',
                async claimWaitRecord(correlationKey: string) {
                    if (claimed) {
                        throw new DuplicateEventException(correlationKey);
                    }
                    claimed = true;
                    return {
                        stackId: storedStackId,
                        correlationKey,
                        status: 'WAITING',
                        continuationStepIndex: 2,
                        stepId: 'wait-step',
                    };
                },
                async saveWaitRecord() {},
            };

            const prevAdapter = defaultStorageManager.getAdapter();
            defaultStorageManager.useStorage(mockAdapter as any);

            try {
                const s1 = Step.create('step1', () => ({ val1: 42 }));
                const waitStep = waitForEvent('atomic.event', { correlationKey: 'corr-atomic-1' });
                let accessedSubField: any;
                let accessedAll: any;
                const s2 = Step.create('step2', (ctx: any) => {
                    accessedSubField = ctx.$steps('step1');
                    accessedAll = ctx.$steps();
                    return { val2: ctx.val1 + 10, fromStep: accessedSubField?.val1 };
                });

                const f = flow(s1, waitStep, s2);
                const suspended = await f.run({}, { durable: true, pojo: true });
                expect(suspended.status).to.equal('waiting');
                storedStackId = suspended.stackId;

                const resumed = await f.resume('corr-atomic-1', { extra: 'payload' });
                expect(resumed.val2).to.equal(52);
                expect(resumed.fromStep).to.equal(42);
                expect(accessedSubField).to.exist;
                expect(accessedAll).to.exist;

                try {
                    await f.resume('corr-atomic-1');
                    expect.fail('Should fail with DuplicateEventException');
                } catch (err: any) {
                    expect(err).to.be.instanceOf(DuplicateEventException);
                }
            } finally {
                defaultStorageManager.useStorage(prevAdapter as any);
            }
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
                timeoutMs: 15, // 15ms TTL
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
            const f = flow(
                waitStep,
                Step.create('ok', () => ({ ok: true })),
            ).version('2.1.0');

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
            const s1 = Step.create('init', () => ({ user_name: 'John Doe' }));
            const waitStep = waitForEvent('ev', { correlationKey: 'migrate-key' });
            const s2 = Step.create('finish', (ctx: any) => ({
                displayName: ctx.user?.name,
            }));

            // Version 1.0.0 ran and suspended
            const v1 = flow(s1, waitStep).version('1.0.0');
            await v1.run({}, { durable: true });

            // Version 2.0.0 expects { user: { name } } instead of flat { user_name }
            const v2 = flow(waitStep, s2).version('2.0.0');

            const res = await v2.resume(
                'migrate-key',
                {},
                {
                    pojo: true,
                    migrations: {
                        '1.0.0->2.0.0': (_fromVer: any, _toVer: any, oldState: any) => {
                            return {
                                user: { name: oldState.user_name },
                            };
                        },
                    },
                },
            );

            expect(res.displayName).to.equal('John Doe');
        });

        it('covers validateWorkflowVersion equality and function migrations', () => {
            const state = { a: 1 };
            expect(validateWorkflowVersion('1.0', '1.0', undefined, state)).to.equal(state);
            expect(validateWorkflowVersion(undefined, '1.0', undefined, state)).to.equal(state);
            const migrated = validateWorkflowVersion(
                '2.0',
                '1.0',
                (_from, _to, s) => ({ ...s, migrated: true }),
                state,
            );
            expect(migrated).to.deep.equal({ a: 1, migrated: true });
            expect(defaultDurableManager.size).to.be.a('number');
        });

        it('DurableManager enforces maxSize and evicts expired or oldest wait records', async () => {
            const mgr = new DurableManager({ maxSize: 2 });
            const now = Date.now();
            mgr.registerWait({
                correlationKey: 'w1',
                stackId: 'stk1',
                stepId: 'step1',
                continuationStepIndex: 1,
                status: 'waiting',
                registeredAt: now,
                expiresAt: now + 10,
            } as any);
            mgr.registerWait({
                correlationKey: 'w2',
                stackId: 'stk2',
                stepId: 'step2',
                continuationStepIndex: 1,
                status: 'waiting',
                registeredAt: now,
                expiresAt: now + 50000,
            } as any);
            expect(mgr.size).to.equal(2);

            await new Promise(r => setTimeout(r, 20));
            // w1 expired; registering w3 triggers cleanExpired and clears w1
            mgr.registerWait({
                correlationKey: 'w3',
                stackId: 'stk3',
                stepId: 'step3',
                continuationStepIndex: 1,
                status: 'waiting',
                registeredAt: now,
                expiresAt: now + 50000,
            } as any);
            expect(mgr.size).to.equal(2);
            expect(mgr.getWaiting('w1')).to.be.undefined;

            // Both w2 and w3 unexpired; registering w4 evicts oldest (w2)
            mgr.registerWait({
                correlationKey: 'w4',
                stackId: 'stk4',
                stepId: 'step4',
                continuationStepIndex: 1,
                status: 'waiting',
                registeredAt: now,
                expiresAt: now + 50000,
            } as any);
            expect(mgr.size).to.equal(2);
            expect(mgr.getWaiting('w2')).to.be.undefined;
            expect(mgr.getWaitingByStack('stk2')).to.be.undefined;

            // cleanExpired cleans expired entries
            const mgrClean = new DurableManager({ maxSize: 10 });
            mgrClean.registerWait({
                correlationKey: 'temp',
                stackId: 'temp-stk',
                stepId: 'step1',
                continuationStepIndex: 1,
                status: 'waiting',
                registeredAt: now,
                expiresAt: now + 10,
            } as any);
            await new Promise(r => setTimeout(r, 20));
            expect(mgrClean.cleanExpired()).to.equal(1);
        });

        it('resumeWorkflow supports flow containing only continuation step', async () => {
            const waitStep = waitForEvent('step.alone', { correlationKey: 'alone-key' });
            const origFlow = flow(waitStep);
            await origFlow.run({}, { durable: true });

            const contStep = Step.create('contOnly', () => ({ done: true }));
            const contFlow = flow(contStep);
            const res = await resumeWorkflow(contFlow, 'alone-key', {}, { pojo: true });
            expect(res.done).to.equal(true);
        });

        it('resumeWorkflow recovers waitRecord from storage adapter getWaitRecord and notifies saveWaitRecord', async () => {
            let savedRecord: any;
            const mockAdapter = {
                name: 'mock-durable',
                saveWaitRecord: async (rec: any) => {
                    savedRecord = rec;
                },
                getWaitRecord: async (key: string) => {
                    if (key === 'adapter-key') {
                        return {
                            stackId: 'adapter-stack',
                            correlationKey: 'adapter-key',
                            eventName: 'approval',
                            status: 'waiting',
                            continuationStepIndex: 1,
                            createdAt: Date.now(),
                        };
                    }
                    return undefined;
                },
                getCheckpoint: async (id: string) => {
                    return {
                        version: 2,
                        schemaVersion: '2.0.0',
                        stackId: id,
                        status: 'waiting',
                        revision: 1,
                        timestamp: Date.now(),
                        chains: [],
                        contexts: {},
                    } as any;
                },
            };
            defaultStorageManager.useStorage(mockAdapter as any);

            const contStep = Step.create('approvedStep', () => ({ approved: true }));
            const f = flow(contStep);

            const res = await resumeWorkflow(f, 'adapter-key', { notes: 'ok' }, { pojo: true });
            expect(res.approved).to.be.true;
            expect(savedRecord).to.be.an('object');
            expect(savedRecord?.status).to.equal('resumed');
        });

        it('resumeWorkflow recovers waitRecord from checkpoint metadata when in-memory manager is cleared', async () => {
            let savedWaitRecord: any;
            const mockAdapter = {
                name: 'mock-suspension',
                saveWaitRecord: async (rec: any) => {
                    savedWaitRecord = rec;
                },
            };
            defaultStorageManager.useStorage(mockAdapter as any);

            const waitStep = waitForEvent('invoice.paid', { correlationKey: 'inv-key' });
            const contStep = Step.create('receipt', () => ({ sent: true }));
            const invoiceFlow = flow(waitStep, contStep);

            const suspension = await invoiceFlow.run({}, { durable: true });
            expect(suspension.status).to.equal('waiting');
            expect(savedWaitRecord).to.be.an('object');
            expect(savedWaitRecord.correlationKey).to.equal('inv-key');

            // Clear in-memory manager to simulate restart
            defaultDurableManager.clear();
            expect(defaultDurableManager.getWaiting('inv-key')).to.be.undefined;

            // Resume by stackId
            const res = await resumeWorkflow(invoiceFlow, suspension.stackId, {}, { pojo: true });
            expect(res.sent).to.be.true;
        });
    });

    describe('DurableManager Isolated Suite', () => {
        it('initializes with default options and tracks size correctly', () => {
            const manager = new DurableManager();
            expect(manager.size).to.equal(0);
        });

        it('registers and retrieves waiting records by correlationKey and stackId', () => {
            const manager = new DurableManager();
            const record = {
                stackId: 'stack-isolated-1',
                workflowId: 'wf-1',
                correlationKey: 'corr-isolated-1',
                eventName: 'order.completed',
                status: 'waiting' as any,
                continuationStepIndex: 1,
                stepId: 'step-isolated-1',
                createdAt: Date.now(),
            };

            manager.registerWait(record);
            expect(manager.size).to.equal(1);
            expect(manager.getWaiting('corr-isolated-1')).to.deep.equal(record);
            expect(manager.getWaitingByStack('stack-isolated-1')).to.deep.equal(record);
            expect(manager.getWaitingByStack('missing-stack')).to.be.undefined;
            expect(manager.getWaiting('missing-corr')).to.be.undefined;
        });

        it('resumes waiting record and marks status as resumed', () => {
            const manager = new DurableManager();
            manager.registerWait({
                stackId: 'stack-resume-test',
                correlationKey: 'corr-resume-test',
                eventName: 'approval.given',
                status: 'waiting' as any,
                continuationStepIndex: 2,
                stepId: 'step-wait',
                createdAt: Date.now(),
            });

            const resumed = manager.resumeWait('corr-resume-test');
            expect(resumed.status).to.equal('resumed');
            expect(resumed.resumedAt).to.be.a('number');

            // Second attempt throws DuplicateEventException
            expect(() => manager.resumeWait('corr-resume-test')).to.throw(DuplicateEventException);
        });

        it('throws ExpiredWaitException when resuming an expired wait record', () => {
            const manager = new DurableManager();
            manager.registerWait({
                stackId: 'stack-expired-test',
                correlationKey: 'corr-expired-test',
                eventName: 'auth.timeout',
                status: 'waiting' as any,
                continuationStepIndex: 1,
                stepId: 'step-auth',
                createdAt: Date.now() - 10000,
                expiresAt: Date.now() - 2000,
            });

            expect(() => manager.resumeWait('corr-expired-test')).to.throw(ExpiredWaitException);
        });

        it('returns all waiting records via getAllWaiting()', () => {
            const manager = new DurableManager();
            manager.registerWait({
                stackId: 'stack-all-test',
                correlationKey: 'corr-all-test',
                status: 'waiting' as any,
                continuationStepIndex: 0,
                stepId: 'step-1',
                createdAt: Date.now(),
            });
            const all = manager.getAllWaiting();
            expect(all).to.be.an('array');
            expect(all).to.have.length(1);
            expect(all[0].correlationKey).to.equal('corr-all-test');
        });

        it('defaults status and createdAt when omitted and allows resuming expired record when allowExpired is true', () => {
            const manager = new DurableManager();
            manager.registerWait({
                stackId: 'stack-default-test',
                correlationKey: 'corr-default-test',
                eventName: 'timer',
                continuationStepIndex: 0,
                stepId: 'step-default',
                expiresAt: Date.now() - 5000,
            } as any);

            const rec = manager.getWaiting('corr-default-test');
            expect(rec?.status).to.equal('waiting');
            expect(rec?.createdAt).to.be.a('number');

            const resumed = manager.resumeWait('corr-default-test', true);
            expect(resumed.status).to.equal('resumed');
            expect(resumed.resumedAt).to.be.a('number');
        });

        it('clears all records and indexed stack mapping', () => {
            const manager = new DurableManager();
            manager.registerWait({
                stackId: 'stack-clear-test',
                correlationKey: 'corr-clear-test',
                eventName: 'event.test',
                status: 'waiting' as any,
                continuationStepIndex: 1,
                stepId: 'step-test',
                createdAt: Date.now(),
            });

            expect(manager.size).to.equal(1);
            manager.clear();
            expect(manager.size).to.equal(0);
            expect(manager.getWaiting('corr-clear-test')).to.be.undefined;
            expect(manager.getWaitingByStack('stack-clear-test')).to.be.undefined;
        });
    });
});
