import { within } from '../engine/deadline';
import { FlowAstGenerator } from '../engine/ast-generator';
import { InvariantEvaluator } from '../engine/invariant-evaluator';
import { RandomSource } from '../engine/property-generators';

export type { CharterResult } from '../engine/charter';
import type { CharterResult } from '../engine/charter';
import assert from 'node:assert/strict';
import { step } from '../engine/step-helper';
import { map, race, allSettled } from '@siglo/core';
/**
 * Charter 1: Core Combinator & Parallelism Stress
 * Synthesizes arbitrary flow topologies with deeply nested combinators (parallel, race, map, when, branch)
 * and verifies that context isolation is preserved, bounded concurrency is respected, and outcomes are sound.
 */
export async function runCombinatorsCharter(iterations: number = 20, seed: number = 42): Promise<CharterResult> {
    const started = Date.now();
    const rng = new RandomSource(seed);
    const errors: string[] = [];
    const evidence: unknown[] = [];

    for (let i = 0; i < iterations; i++) {
        const iterSeed = rng.nextInt(1, 1000000);
        const fuzzer = new FlowAstGenerator(iterSeed);
        const depth = rng.nextInt(1, 4);

        // Sub-test A: AST Topology Generation & Execution
        const generated = fuzzer.generateFlow(`comb_iter_${i}`, depth, {
            errorProbability: 0.05,
            delayProbability: 0.3,
            timeoutProbability: 0.0,
        });

        const initialContext = {
            seed: iterSeed,
            iteration: i,
            canary: undefined,
            userPayload: rng.jsonPayload(2),
        };
        const initialSnapshot = JSON.parse(JSON.stringify(initialContext));
        const errorCount = errors.length;

        try {
            await generated.workflow.run(initialContext, { pojo: true });
            InvariantEvaluator.assertContextImmutability(initialSnapshot, initialContext);
        } catch (err: any) {
            if (err.name === 'InvariantViolation') {
                errors.push(`Iteration ${i} Invariant Violation: ${err.message}`);
            }
        }

        // Sub-test B: Bounded Concurrency Stress on `map`
        const mapItems = [10, 20, 30, 40, 50, 60];
        const maxConcurrency = rng.nextInt(1, 3);
        let activeWorkers = 0;
        let highWaterMark = 0;

        try {
            // Test map combinator semantics
            const delays = mapItems.map(() => rng.nextInt(1, 5));
            const mapRes = await map(
                mapItems,
                async (item: number, meta: { index: number }) => {
                    activeWorkers++;
                    highWaterMark = Math.max(highWaterMark, activeWorkers);
                    try {
                        await new Promise(r => setTimeout(r, delays[meta.index]));
                        return item * 2;
                    } finally {
                        activeWorkers--;
                    }
                },
                { concurrency: maxConcurrency },
            ).execute({}, { pojo: true });
            InvariantEvaluator.assertBoundedConcurrency(highWaterMark, maxConcurrency);
            assert.deepEqual(
                mapRes.items,
                mapItems.map(item => item * 2),
            );
            assert.equal(activeWorkers, 0);

            const isolated = await map(
                mapItems,
                async (item: number) => {
                    if (item === 30) throw new Error('poison');
                    return item;
                },
                { concurrency: maxConcurrency, stopOnError: false },
            ).execute({}, { pojo: true });
            assert.equal(isolated.items.length, mapItems.length);
            assert.equal(isolated.errors.length, 1);
            assert.equal(isolated.items[2].error.message, 'poison');
        } catch (err: any) {
            errors.push(`Iteration ${i} Map: ${err.message}`);
        }

        // Sub-test C: Race Combinator Soundness
        try {
            let loserAborted = false;
            let loserFinished!: () => void;
            const finished = new Promise<void>(resolve => {
                loserFinished = resolve;
            });
            const slow = async (_input: unknown, options: { signal: AbortSignal }) => {
                try {
                    await new Promise((_resolve, reject) => {
                        const abort = () => {
                            loserAborted = true;
                            reject(options.signal.reason);
                        };
                        if (options.signal.aborted) abort();
                        else options.signal.addEventListener('abort', abort, { once: true });
                    });
                } finally {
                    loserFinished();
                }
            };
            const fast = async () => ({ winner: 'fast' });
            const raceRes = await race([slow, fast]).execute({}, { pojo: true });
            await within(finished, 2000, 'Race loser did not settle after cancellation');
            assert.equal(raceRes.winner, 'fast');
            assert.equal(loserAborted, true);
            const settled = await allSettled([
                step('success', async () => ({ ok: true })),
                step('failure', async () => {
                    throw new Error('isolated');
                }),
            ]).execute({}, { pojo: true });
            assert.equal(settled.success.ok, true);
            assert.equal(settled.failure.error.message, 'isolated');
        } catch (err: any) {
            errors.push(`Iteration ${i} Race: ${err.message}`);
        }
        if (errors.length > errorCount)
            evidence.push({
                iteration: i,
                iterSeed,
                input: initialSnapshot,
                topology: generated.metadata,
                executionTrace: generated.executionContext.events,
            });
    }

    return {
        charterName: 'Charter 1: Core Combinator & Parallelism Stress',
        durationMs: Date.now() - started,
        invariantsChecked: [1, 4, 5, 6],
        passed: errors.length === 0,
        iterations,
        errors,
        evidence,
    };
}
