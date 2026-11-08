import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { flow, waitForEvent, Step, WorkflowEventEmitter, defaultDurableManager, resumeWorkflow } from '@siglo/core';
import { MemoryWaitPoller } from '@siglo/scheduler';
import { applyWaitEvent } from './wait-state';
import { WorkflowExecutionStore } from './store';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StepDetailCard } from '../ui/src/components/workflows/Dag/StepDetailCard';

describe('durable wait inspection', () => {
    it('keeps explicit identities isolated and preserves deadlines across live resume updates', () => {
        const steps = {
            a: { stepId: 'a', stepName: 'waitForEvent:SAME', status: 'RUNNING' },
            b: { stepId: 'b', stepName: 'waitForEvent:SAME', status: 'SUSPENDED' },
        };
        const waiting = applyWaitEvent(steps, { type: 'flow:suspended', stepId: 'a', expiresAt: 1800000000000 });
        const expired = applyWaitEvent(waiting, {
            type: 'flow:resumed',
            stepId: 'a',
            resumeReason: 'timer-expired',
            timestamp: 10,
        }) as any;
        assert.equal(expired.a.waitState, 'expired');
        assert.equal(expired.a.waitExpiresAt, 1800000000000);
        assert.equal(expired.a.endTime, 10);
        assert.equal(expired.b, steps.b);
        assert.equal(steps.a.status, 'RUNNING');
        assert.equal(
            (applyWaitEvent(waiting, { type: 'flow:resumed', stepId: 'missing' }) as any).a.waitState,
            'waiting',
        );
        for (const value of [-1, Infinity, 'private', 8640000000000001]) {
            assert.equal(
                (applyWaitEvent(steps, { type: 'flow:suspended', stepId: 'a', expiresAt: value }) as any).a
                    .waitExpiresAt,
                undefined,
            );
        }
        const html = renderToStaticMarkup(createElement(StepDetailCard, { step: expired.a, onClose() {} }));
        assert.match(html, /Wait state: .*expired/);
        assert.ok(html.includes(new Date(1800000000000).toISOString()));
    });

    for (const timer of [false, true]) {
        it(`records ${timer ? 'scheduled expiry' : 'event resume'} from the durable runtime`, async () => {
            const store = new WorkflowExecutionStore();
            const events: any[] = [];
            const monitor = new WorkflowEventEmitter().on('*', event => {
                events.push(event);
                store.addEvent(event);
            });
            const key = `wait-inspection-${timer}-${Date.now()}`;
            let effects = 0;
            const workflow = flow(
                waitForEvent('APPROVED', { correlationKey: key, timeout: '2h' }),
                Step.create('effect', () => {
                    effects++;
                    return {};
                }),
            );
            await workflow.run({}, { durable: true, monitor });
            const suspended = events.find(event => event.type === 'flow:suspended');
            assert.ok(suspended?.stepId);
            const waiting = store.getRun(suspended.stackId)!.steps[suspended.stepId];
            assert.equal(waiting.waitState, 'waiting');
            assert.equal(waiting.waitExpiresAt, suspended.expiresAt);
            if (timer) {
                // Make this record due without replacing the process clock or sleeping.
                defaultDurableManager.getWaiting(key)!.expiresAt = Date.now() - 1;
                await new MemoryWaitPoller({ flowLookup: () => workflow }).pollOnce();
            } else {
                await resumeWorkflow(workflow, key, { event: { type: 'APPROVED' } }, { monitor });
            }
            const resumed = events.find(event => event.type === 'flow:resumed');
            assert.equal(resumed?.resumeReason, timer ? 'timer-expired' : 'event');
            const completed = store.getRun(suspended.stackId)!.steps[suspended.stepId];
            assert.equal(completed.waitState, timer ? 'expired' : 'resumed');
            assert.equal(completed.waitExpiresAt, suspended.expiresAt);
            assert.equal(effects, 1);
        });
    }
});
