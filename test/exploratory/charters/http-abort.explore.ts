import { flow, CancellationException } from '@siglo/core';
import { step } from '../engine/step-helper';
import { InvariantEvaluator } from '../engine/invariant-evaluator';
import { RandomSource } from '../engine/property-generators';
import { CharterResult } from './combinators.explore';

export async function runHttpAbortCharter(
    iterations: number = 20,
    seed: number = 6006
): Promise<CharterResult> {
    const startTime = Date.now();
    const rng = new RandomSource(seed);
    const errors: string[] = [];
    const invariantsChecked = [4, 10];

    for (let i = 0; i < iterations; i++) {
        const executedSteps: string[] = [];
        const controller = new AbortController();

        const s1 = step('step_pre_abort', async () => {
            executedSteps.push('step_pre_abort');
            return { s1: true };
        });

        const s2 = step('step_during_abort', async () => {
            executedSteps.push('step_during_abort');
            // Delay to allow abort to fire mid-flight
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, 60);
                if (controller.signal.aborted) {
                    clearTimeout(timer);
                    reject(new CancellationException('Aborted'));
                } else {
                    controller.signal.addEventListener(
                        'abort',
                        () => {
                            clearTimeout(timer);
                            reject(new CancellationException('Aborted'));
                        },
                        { once: true }
                    );
                }
            });
            return { s2: true };
        });

        const s3 = step('step_post_abort_1', async () => {
            executedSteps.push('step_post_abort_1');
            return { s3: true };
        });

        const s4 = step('step_post_abort_2', async () => {
            executedSteps.push('step_post_abort_2');
            return { s4: true };
        });

        const testFlow = flow(s1, s2, s3, s4);

        // Schedule abort after step 1 finishes and step 2 starts
        const abortDelay = rng.nextInt(5, 20);
        const abortTimer = setTimeout(() => {
            controller.abort(new CancellationException('Client connection closed by peer'));
        }, abortDelay);

        try {
            await testFlow.execute({}, { signal: controller.signal, pojo: true });
            clearTimeout(abortTimer);
            errors.push(`Iteration ${i}: Expected workflow to be cancelled, but it completed successfully!`);
        } catch (err: any) {
            clearTimeout(abortTimer);
            try {
                // Verify Oracle 4: Cooperative cancellation halts downstream steps
                InvariantEvaluator.assertCancellationPromptness(
                    'step_during_abort',
                    executedSteps,
                    ['step_post_abort_1', 'step_post_abort_2']
                );
            } catch (invErr: any) {
                errors.push(`Iteration ${i} Invariant Violation: ${invErr.message}`);
            }
        }
    }

    return {
        charterName: 'Charter 6: Web / Edge Adapter Disconnects & Abort Propagation',
        iterations,
        passed: errors.length === 0,
        durationMs: Date.now() - startTime,
        invariantsChecked,
        errors
    };
}
