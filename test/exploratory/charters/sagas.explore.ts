import { InvariantEvaluator } from '../engine/invariant-evaluator';
import { RandomSource } from '../engine/property-generators';
import { flow } from '@siglo/core';
import { step } from '../engine/step-helper';
import { CharterResult } from './combinators.explore';

export async function runSagasCharter(iterations: number = 25, seed: number = 2002): Promise<CharterResult> {
    const startTime = Date.now();
    const rng = new RandomSource(seed);
    const errors: string[] = [];
    const invariantsChecked = [2];

    for (let i = 0; i < iterations; i++) {
        const stepCount = rng.nextInt(3, 7);
        const failAtStep = rng.nextInt(1, stepCount); // 1-indexed step that will fail
        const injectCompensationError = rng.nextBoolean(0.2); // 20% chance compensation itself fails

        const completedSteps: string[] = [];
        const compensatedSteps: string[] = [];
        const stepsList: any[] = [];

        for (let s = 1; s <= stepCount; s++) {
            const stepName = `step_${s}`;
            let st = step(stepName, async () => {
                if (s === failAtStep) {
                    throw new Error(`Deliberate failure at ${stepName}`);
                }
                completedSteps.push(stepName);
                return { [`${stepName}_done`]: true };
            }).compensate(async () => {
                compensatedSteps.push(stepName);
                if (injectCompensationError && s === 1) {
                    throw new Error(`Injected failure inside compensation for ${stepName}`);
                }
            });

            stepsList.push(st);
        }

        const testFlow = flow(...stepsList);

        try {
            await testFlow.run({}, { pojo: true });
            errors.push(`Iteration ${i}: Expected saga failure at step_${failAtStep}, but flow succeeded!`);
        } catch (err: any) {
            // Verify Oracle 2: Saga LIFO ordering
            try {
                InvariantEvaluator.assertSagaLIFO(completedSteps, compensatedSteps, `step_${failAtStep}`);
            } catch (invErr: any) {
                errors.push(`Iteration ${i} Invariant Violation: ${invErr.message}`);
            }
        }
    }

    return {
        charterName: 'Charter 2: Saga Rollbacks & Cascading Failure Chaos',
        iterations,
        passed: errors.length === 0,
        durationMs: Date.now() - startTime,
        invariantsChecked,
        errors,
    };
}
