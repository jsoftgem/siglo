import { InvariantEvaluator } from '../engine/invariant-evaluator';
import { RandomSource } from '../engine/property-generators';
import { ChaosStorageProxy } from '../engine/chaos-proxy';
import {
    flow,
    waitForEvent,
    resumeWorkflow,
    defaultDurableManager,
    defaultStorageManager,
    DuplicateEventException,
    useStorage
} from 'rivulet';
import { step } from '../engine/step-helper';
import { InMemoryStorageFake } from '@rivulet/testing';
import { CharterResult } from './combinators.explore';

export async function runDurableOccCharter(
    iterations: number = 20,
    seed: number = 3003
): Promise<CharterResult> {
    const startTime = Date.now();
    const rng = new RandomSource(seed);
    const errors: string[] = [];
    const invariantsChecked = [3];

    for (let i = 0; i < iterations; i++) {
        defaultDurableManager.clear();
        const fakeStorage = new InMemoryStorageFake();
        const chaosProxy = new ChaosStorageProxy(fakeStorage, {
            conflictRate: 0.1,
            maxLatencyMs: 5
        });
        useStorage(chaosProxy);

        const correlationKey = `corr_${i}_${rng.string(6)}`;
        const stackId = `stack_${i}_${rng.string(6)}`;

        const s1 = step('initStep').onStart(async (ctx: any) => ({ step1Done: true }));
        const waitStep = waitForEvent('user_approval', {
            correlationKey: (ctx: any) => correlationKey
        });
        const s2 = step('postWaitStep').onStart(async (ctx: any) => ({
            approved: ctx.approved ?? false,
            completedAt: Date.now()
        }));

        const testFlow = flow(s1, waitStep, s2);

        // 1. Manually register wait state to simulate durable suspension
        defaultDurableManager.registerWait({
            correlationKey,
            eventName: 'user_approval',
            stepId: 'waitForEvent:user_approval',
            stackId,
            continuationStepIndex: 2,
            version: '1.0.0',
            status: 'WAITING' as any,
            createdAt: Date.now()
        });

        await defaultStorageManager.saveCheckpoint({
            id: stackId,
            stackId,
            contexts: { initStep: { step1Done: true } },
            workflowVersion: '1.0.0',
            status: 'WAITING',
            currentStepId: 'waitForEvent:user_approval',
            completedSteps: ['initStep'],
            timestamp: Date.now()
        } as any);

        // 2. Fire concurrent stampede of resume calls
        const concurrency = rng.nextInt(5, 12);
        const resumePromises: Promise<any>[] = [];

        for (let c = 0; c < concurrency; c++) {
            resumePromises.push(
                resumeWorkflow(testFlow, correlationKey, { approved: true, workerId: c }, { pojo: true })
            );
        }

        const outcomes = await Promise.allSettled(resumePromises);

        try {
            // Verify Oracle 3: Optimistic Concurrency & Checkpoint Idempotency
            const fulfilled = outcomes.filter(o => o.status === 'fulfilled');
            const duplicateErrors = outcomes.filter(
                o => o.status === 'rejected' && (o.reason instanceof DuplicateEventException || o.reason?.name === 'DuplicateEventException')
            );

            if (fulfilled.length !== 1 && duplicateErrors.length !== concurrency - 1) {
                const chaosConflicts = outcomes.filter(
                    o => o.status === 'rejected' && o.reason?.message?.includes('OCC Conflict')
                );
                if (fulfilled.length + duplicateErrors.length + chaosConflicts.length !== concurrency) {
                    errors.push(
                        `Iteration ${i}: Inconsistent resume outcomes! Fulfilled: ${fulfilled.length}, DuplicateEventExceptions: ${duplicateErrors.length}, Total: ${concurrency}`
                    );
                }
            }

            InvariantEvaluator.assertOptimisticConcurrency(outcomes);
        } catch (err: any) {
            errors.push(`Iteration ${i} Invariant Violation: ${err.message}`);
        }
    }

    return {
        charterName: 'Charter 3: Durable Waits & Checkpoint Resumption Under OCC Contention',
        iterations,
        passed: errors.length === 0,
        durationMs: Date.now() - startTime,
        invariantsChecked,
        errors
    };
}
