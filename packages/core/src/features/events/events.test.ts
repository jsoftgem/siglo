import { expect } from 'chai';
import {
    Step,
    flow,
    WorkflowEventEmitter,
    defaultWorkflowEventEmitter,
    setDefaultMonitor,
    getDefaultMonitor,
    emitMonitoringEvent,
    redactValue,
    redactEvent,
    WorkflowExecutionEvent
} from '../../index';
import { defaultStorageManager } from '../storage';
import { createExecutionStack } from '../storage/index';

describe('Workflow Events & Monitoring Unit Tests', () => {
    afterEach(() => {
        defaultStorageManager.clear();
        setDefaultMonitor(undefined);
    });

    describe('WorkflowEventEmitter', () => {
        it('subscribes and emits specific events', () => {
            const emitter = new WorkflowEventEmitter();
            const events: any[] = [];

            emitter.on('flow:start', (ev) => {
                events.push(ev);
            });

            emitter.emit('flow:start', { stackId: 'stack-1', timestamp: 100 });
            expect(events).to.have.lengthOf(1);
            expect(events[0].stackId).to.equal('stack-1');
            expect(events[0].type).to.equal('flow:start');
        });

        it('supports wildcard listeners and fn-only on()', () => {
            const emitter = new WorkflowEventEmitter();
            const wildcardEvents: any[] = [];
            const fnEvents: any[] = [];

            const fnListener = (ev: any) => fnEvents.push(ev);
            emitter.on(fnListener);

            emitter.on('*', (ev) => {
                wildcardEvents.push(ev);
            });

            // without listener does nothing
            (emitter as any).on('*');
            (emitter as any).on('step:start');

            emitter.emit({ type: 'step:start', stackId: 's1', stepId: 'step-1', stepName: 'step1', timestamp: 100 });
            expect(wildcardEvents).to.have.lengthOf(1);
            expect(fnEvents).to.have.lengthOf(1);
        });

        it('supports once() for one-time listeners', () => {
            const emitter = new WorkflowEventEmitter();
            let count = 0;

            emitter.once('step:start', () => {
                count++;
            });

            emitter.emit('step:start', { stackId: 's1', stepId: 'st1', stepName: 'name', timestamp: 100 });
            emitter.emit('step:start', { stackId: 's1', stepId: 'st1', stepName: 'name', timestamp: 200 });

            expect(count).to.equal(1);
        });

        it('supports off() with functions, wildcard, and specific events', () => {
            const emitter = new WorkflowEventEmitter();
            const l1 = () => {};
            const l2 = () => {};

            emitter.on(l1);
            expect(emitter.listenerCount('*')).to.equal(1);
            emitter.off(l1);
            expect(emitter.listenerCount('*')).to.equal(0);

            emitter.on('*', l2);
            expect(emitter.listenerCount('*')).to.equal(1);
            emitter.off('*', l2);
            expect(emitter.listenerCount('*')).to.equal(0);

            emitter.on('*', l1);
            emitter.off('*');
            expect(emitter.listenerCount('*')).to.equal(0);

            emitter.on('step:complete', l1);
            expect(emitter.listenerCount('step:complete')).to.equal(1);
            emitter.off('step:complete', l1);
            expect(emitter.listenerCount('step:complete')).to.equal(0);

            emitter.on('step:complete', l1);
            emitter.off('step:complete');
            expect(emitter.listenerCount('step:complete')).to.equal(0);
        });

        it('handles removeAllListeners and listenerCount correctly', () => {
            const emitter = new WorkflowEventEmitter();
            emitter.on('flow:start', () => {});
            emitter.on('flow:complete', () => {});
            emitter.on('*', () => {});

            expect(emitter.listenerCount()).to.equal(3);
            expect(emitter.listenerCount('flow:start')).to.equal(2); // specific + wildcard

            emitter.removeAllListeners('flow:start');
            expect(emitter.listenerCount('flow:start')).to.equal(1);

            emitter.removeAllListeners('*');
            expect(emitter.listenerCount('*')).to.equal(0);

            emitter.on('flow:start', () => {});
            emitter.removeAllListeners();
            expect(emitter.listenerCount()).to.equal(0);
        });

        it('is resilient against listener errors', () => {
            const emitter = new WorkflowEventEmitter();
            emitter.on('flow:start', () => {
                throw new Error('Explosion in listener');
            });
            emitter.on('*', () => {
                throw new Error('Explosion in wildcard');
            });

            expect(() => {
                emitter.emit('flow:start', { stackId: 's1' });
            }).to.not.throw();
        });

        it('ignores invalid events and filters by namespace', () => {
            const emitter = new WorkflowEventEmitter('ns-a');
            const events: any[] = [];
            emitter.on('*', (ev) => events.push(ev));

            (emitter as any).emit(null);
            (emitter as any).emit({} as any);

            // Matching namespace
            emitter.emit({ type: 'flow:start', stackId: 's1', timestamp: 10, namespace: 'ns-a' });
            // Different namespace ignored
            emitter.emit({ type: 'flow:start', stackId: 's2', timestamp: 20, namespace: 'ns-b' });

            expect(events).to.have.lengthOf(1);
            expect(events[0].stackId).to.equal('s1');
        });

        it('filters namespace via filterNamespace()', () => {
            const emitter = new WorkflowEventEmitter();
            const scoped = emitter.filterNamespace('tenant-1');
            const scopedEvents: any[] = [];
            scoped.on('*', (ev) => scopedEvents.push(ev));

            emitter.emit({ type: 'flow:start', stackId: 's1', timestamp: 10, namespace: 'tenant-1' });
            emitter.emit({ type: 'flow:start', stackId: 's2', timestamp: 20, namespace: 'tenant-2' });
            emitter.emit({ type: 'flow:start', stackId: 's3', timestamp: 30 }); // undefined namespace matches

            expect(scopedEvents).to.have.lengthOf(2);
            expect(scopedEvents[0].stackId).to.equal('s1');
            expect(scopedEvents[1].stackId).to.equal('s3');
        });

        it('adapts to StorageAdapter via toStorageAdapter()', async () => {
            const emitter = new WorkflowEventEmitter();
            const events: any[] = [];
            emitter.on('*', (ev) => events.push(ev));

            const adapter = emitter.toStorageAdapter();
            expect(adapter.name).to.equal('workflow-event-emitter');

            adapter.onContextChange?.({
                stackId: 'stk-1',
                stepId: 'stp-1',
                field: 'foo',
                value: 'bar',
                timestamp: 100,
                namespace: 'ns-1'
            });

            adapter.onCacheEvent?.({
                type: 'hit',
                stackId: 'stk-1',
                stepId: 'stp-1',
                key: 'cache-key',
                timestamp: 101,
                namespace: 'ns-1'
            });

            adapter.onCacheEvent?.({
                type: 'miss',
                stackId: 'stk-1',
                stepId: 'stp-1',
                key: 'cache-key-2',
                timestamp: 102,
                namespace: 'ns-1'
            });

            await adapter.saveCheckpoint?.({
                stackId: 'stk-1',
                status: 'COMPLETED' as any,
                revision: 1
            });

            expect(events.map(e => e.type)).to.deep.equal([
                'context:change',
                'cache:hit',
                'cache:miss',
                'checkpoint:save'
            ]);
        });
    });

    describe('Global Monitor & emitMonitoringEvent Helpers', () => {
        it('manages default monitor and handles emitMonitoringEvent targets', () => {
            expect(getDefaultMonitor()).to.be.undefined;
            expect(defaultWorkflowEventEmitter).to.be.instanceOf(WorkflowEventEmitter);

            const global = new WorkflowEventEmitter();
            setDefaultMonitor(global);
            expect(getDefaultMonitor()).to.equal(global);

            const globalEvents: any[] = [];
            global.on('*', (ev) => globalEvents.push(ev));

            // local target is a function
            const localFnEvents: any[] = [];
            const localFn = (ev: any) => localFnEvents.push(ev);

            emitMonitoringEvent({ monitor: localFn }, { type: 'flow:start', stackId: 's1', timestamp: 10 });
            expect(localFnEvents).to.have.lengthOf(1);
            expect(globalEvents).to.have.lengthOf(1);

            // local and global are identical (does not emit twice)
            globalEvents.length = 0;
            emitMonitoringEvent({ monitor: global }, { type: 'flow:start', stackId: 's2', timestamp: 20 });
            expect(globalEvents).to.have.lengthOf(1);

            // handles faulty monitor throwing
            const faultyMonitor = {
                emit: () => {
                    throw new Error('Faulty emit');
                }
            };
            expect(() => {
                emitMonitoringEvent({ monitor: faultyMonitor }, { type: 'flow:start', stackId: 's3', timestamp: 30 });
            }).to.not.throw();

            // when neither local nor global is set
            setDefaultMonitor(undefined);
            expect(() => {
                emitMonitoringEvent({}, { type: 'flow:start', stackId: 's4', timestamp: 40 });
            }).to.not.throw();
        });
    });

    describe('Redaction Utilities', () => {
        it('redacts primitives, arrays, and objects', () => {
            expect(redactValue(null)).to.be.null;
            expect(redactValue(undefined)).to.be.undefined;
            expect(redactValue('hello')).to.equal('hello');
            expect(redactValue(123)).to.equal(123);

            const arr = ['safe', { password: 'secret-pass' }];
            const redactedArr = redactValue(arr);
            expect(redactedArr[0]).to.equal('safe');
            expect(redactedArr[1].password).to.equal('[REDACTED]');

            const obj = {
                username: 'alice',
                password: 'p1',
                token: 't1',
                secret: 's1',
                apikey: 'k1',
                authorization: 'Bearer 123',
                cookie: 'sess=1',
                creditcard: '4111',
                ssn: '000-00',
                privkey: 'key',
                privatekey: 'key2',
                nested: {
                    token: 'nested-token',
                    active: true
                }
            };
            const redactedObj = redactValue(obj);
            expect(redactedObj.username).to.equal('alice');
            expect(redactedObj.password).to.equal('[REDACTED]');
            expect(redactedObj.token).to.equal('[REDACTED]');
            expect(redactedObj.nested.token).to.equal('[REDACTED]');
            expect(redactedObj.nested.active).to.be.true;
        });

        it('supports custom redactKeys and redactHook', () => {
            const obj = {
                customSecret: 'topsecret',
                safeVal: 'ok'
            };
            const res = redactValue(obj, { redactKeys: ['customSecret'] });
            expect(res.customSecret).to.equal('[REDACTED]');
            expect(res.safeVal).to.equal('ok');

            const hooked = redactValue(obj, {
                redactHook: (key, val) => {
                    if (key === 'safeVal') return 'HOOKED';
                    return undefined;
                }
            });
            expect(hooked.safeVal).to.equal('HOOKED');
        });

        it('redacts context:change and step:complete events', () => {
            expect(redactEvent(null as any)).to.be.null;

            const safeEvent: WorkflowExecutionEvent = {
                type: 'flow:start',
                stackId: 's1',
                timestamp: 100
            };
            expect(redactEvent(safeEvent)).to.deep.equal(safeEvent);

            const sensitiveContextEvent: WorkflowExecutionEvent = {
                type: 'context:change',
                stackId: 's1',
                stepId: 'st1',
                field: 'password',
                value: 'secret123',
                timestamp: 100
            };
            const redactedContext = redactEvent(sensitiveContextEvent);
            expect((redactedContext as any).value).to.equal('[REDACTED]');

            // Context change with nested object
            const nestedContextEvent: WorkflowExecutionEvent = {
                type: 'context:change',
                stackId: 's1',
                stepId: 'st1',
                field: 'userProfile',
                value: { name: 'Bob', token: 'secretToken' },
                timestamp: 100
            };
            const redactedNestedContext = redactEvent(nestedContextEvent);
            expect((redactedNestedContext as any).value.token).to.equal('[REDACTED]');

            // Context change with redactHook
            const hookedContext = redactEvent(sensitiveContextEvent, {
                redactHook: (field, val) => `MASKED:${val}`
            });
            expect((hookedContext as any).value).to.equal('MASKED:secret123');

            // Context change with redactHook returning undefined
            const unhookedContext = redactEvent(sensitiveContextEvent, {
                redactHook: () => undefined
            });
            expect((unhookedContext as any).value).to.equal('[REDACTED]');

            const safeContextWithUnhook = redactEvent({
                type: 'context:change',
                stackId: 's1',
                stepId: 'st1',
                field: 'nonSensitiveField',
                value: { password: 'pass' },
                timestamp: 100
            }, {
                redactHook: () => undefined
            });
            expect((safeContextWithUnhook as any).value.password).to.equal('[REDACTED]');

            const stepCompleteEvent: WorkflowExecutionEvent = {
                type: 'step:complete',
                stackId: 's1',
                stepId: 'st1',
                stepName: 'fetchSecrets',
                outputSummary: { secret: 'abc', count: 5 },
                durationMs: 42,
                timestamp: 100
            };
            const redactedStep = redactEvent(stepCompleteEvent);
            expect((redactedStep as any).outputSummary.secret).to.equal('[REDACTED]');
            expect((redactedStep as any).outputSummary.count).to.equal(5);
        });
    });

    describe('Execution Lifecycle Monitoring Integration', () => {
        it('emits lifecycle events for successful workflow with flow().monitor()', async () => {
            const emitter = new WorkflowEventEmitter();
            const events: WorkflowExecutionEvent[] = [];
            emitter.on('*', (ev) => events.push(ev));

            const s1 = Step.create('step1', async () => ({ res1: 'ok' }));
            const s2 = Step.create('step2', async () => ({ res2: 'done' }));

            const f = flow(s1, s2).monitor(emitter);
            await f.run({ input: 'start' }, { namespace: 'test-ns' });

            const types = events.map(e => e.type);
            expect(types).to.include('flow:start');
            expect(types).to.include('step:start');
            expect(types).to.include('step:complete');
            expect(types).to.include('context:change');
            expect(types).to.include('flow:complete');

            const startEv: any = events.find(e => e.type === 'flow:start');
            expect(startEv.namespace).to.equal('test-ns');
            expect(startEv.ast).to.not.be.undefined;

            const completeEv: any = events.find(e => e.type === 'flow:complete');
            expect(completeEv.durationMs).to.be.a('number');
        });

        it('emits step:skipped when onbefore returns false', async () => {
            const emitter = new WorkflowEventEmitter();
            const events: WorkflowExecutionEvent[] = [];
            emitter.on('*', (ev) => events.push(ev));

            const skippedStep = Step.create('skippedStep', async () => ({ ok: true }))
                .onBefore(() => false);

            await Step.start([skippedStep], {}, { monitor: emitter });

            const skippedEv: any = events.find(e => e.type === 'step:skipped');
            expect(skippedEv).to.not.be.undefined;
            expect(skippedEv.stackId).to.be.a('string');
            expect(skippedEv.stackId.length).to.be.greaterThan(0);
        });

        it('emits step:retry, step:error, and flow:error on step failure', async () => {
            const emitter = new WorkflowEventEmitter();
            const events: WorkflowExecutionEvent[] = [];
            emitter.on('*', (ev) => events.push(ev));

            let attempts = 0;
            const failingStep = Step.create('failingStep', async () => {
                attempts++;
                throw new Error(`Attempt ${attempts} failed`);
            }).onFail({ maxAttempts: 2, delayMs: 10 });

            try {
                await Step.start([failingStep], {}, { monitor: emitter });
            } catch {
                // Expected failure
            }

            const types = events.map(e => e.type);
            expect(types).to.include('step:retry');
            expect(types).to.include('step:error');
            expect(types).to.include('flow:error');

            const flowStartEv = events.find(e => e.type === 'flow:start');
            const retryEv: any = events.find(e => e.type === 'step:retry');
            expect(retryEv.attempt).to.equal(1);
            expect(retryEv.maxAttempts).to.equal(2);
            expect(retryEv.stackId).to.equal(flowStartEv?.stackId);
            expect(retryEv.stepId).to.equal(failingStep.$stepId);

            const stepErrorEv: any = events.find(e => e.type === 'step:error');
            expect(stepErrorEv.stackId).to.equal(flowStartEv?.stackId);
            expect(stepErrorEv.stepId).to.equal(failingStep.$stepId);

            const errEv: any = events.find(e => e.type === 'flow:error');
            expect(errEv.error.message).to.include('Attempt');
        });

        it('emits step:retry with parent stackId and completes without creating phantom workflows', async () => {
            const emitter = new WorkflowEventEmitter();
            const events: WorkflowExecutionEvent[] = [];
            emitter.on('*', (ev) => events.push(ev));

            let attempts = 0;
            const retryingStep = Step.create('retryingStep', async () => {
                attempts++;
                if (attempts === 1) {
                    throw new Error('transient failure on attempt 1');
                }
                return { success: true };
            }).onFail({ maxRetries: 2, delay: 10 });

            const result = await flow(retryingStep).run({}, { monitor: emitter });
            expect(result.success).to.be.true;

            const flowStart = events.find(e => e.type === 'flow:start');
            const flowComplete = events.find(e => e.type === 'flow:complete');
            const retryEv: any = events.find(e => e.type === 'step:retry');

            expect(flowStart).to.not.be.undefined;
            expect(flowComplete).to.not.be.undefined;
            expect(retryEv).to.not.be.undefined;

            // stackId must match the workflow execution stackId across all events
            const allStackIds = new Set(events.map(e => e.stackId));
            expect(allStackIds.size).to.equal(1);
            expect(Array.from(allStackIds)[0]).to.equal(flowStart?.stackId);
            expect(retryEv.stackId).to.equal(flowStart?.stackId);
            expect(retryEv.stepId).to.equal(retryingStep.$stepId);
        });

        it('emits checkpoint:save and storage events', async () => {
            const emitter = new WorkflowEventEmitter();
            const events: WorkflowExecutionEvent[] = [];
            emitter.on('*', (ev) => events.push(ev));

            const stackId = createExecutionStack('checkpoint-ns', emitter);

            defaultStorageManager.checkpoint(stackId, { status: 'RUNNING' as any });

            defaultStorageManager.emitCacheEvent({
                type: 'hit',
                stackId,
                stepId: 'stp-1',
                key: 'k1',
                namespace: 'checkpoint-ns'
            });

            const types = events.map(e => e.type);
            expect(types).to.include('checkpoint:save');
            expect(types).to.include('cache:hit');
        });

        it('supports Step.setDefaultMonitor and Step.getDefaultMonitor', async () => {
            const emitter = new WorkflowEventEmitter();
            Step.setDefaultMonitor(emitter);
            expect(Step.getDefaultMonitor()).to.equal(emitter);

            const events: WorkflowExecutionEvent[] = [];
            emitter.on('*', (ev) => events.push(ev));

            const s = Step.create('simple', async () => 42);
            await Step.start([s]);

            expect(events.map(e => e.type)).to.include('flow:start');
            expect(events.map(e => e.type)).to.include('flow:complete');
        });
    });
});
