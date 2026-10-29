import { FlowAstGenerator } from '../engine/ast-generator';
import { InvariantEvaluator } from '../engine/invariant-evaluator';
import { RandomSource } from '../engine/property-generators';
import { flow, map, race, parallel, allSettled } from 'siglo';
import { step } from '../engine/step-helper';

export interface CharterResult {
    charterName: string;
    iterations: number;
    passed: boolean;
    durationMs: number;
    invariantsChecked: number[];
    errors: string[];
}

export async function runCombinatorsCharter(
    iterations: number = 25,
    seed: number = 1001
): Promise<CharterResult> {
    const startTime = Date.now();
    const rng = new RandomSource(seed);
    const errors: string[] = [];
    const invariantsChecked = [1, 5, 6];

    for (let i = 0; i < iterations; i++) {
        const iterSeed = rng.nextInt(1, 100000);
        const fuzzer = new FlowAstGenerator(iterSeed);
        const depth = rng.nextInt(2, 3);

        // Sub-test A: AST Topology Generation & Execution
        const generated = fuzzer.generateFlow(`comb_iter_${i}`, depth, {
            errorProbability: 0.05,
            delayProbability: 0.3,
            timeoutProbability: 0.0
        });

        const initialContext = {
            seed: iterSeed,
            iteration: i,
            canary: undefined,
            userPayload: rng.jsonPayload(2)
        };

        try {
            const result = await generated.workflow.execute(initialContext, { pojo: true });
            InvariantEvaluator.assertContextImmutability(initialContext, result);
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

        const workerStep = step(`worker_step_${i}`, async (ctx: any) => {
                const sleepMs = rng.nextInt(2, 8);
                await new Promise(r => setTimeout(r, sleepMs));
                return { processed: true };
            })
            .onBefore(async () => {
                activeWorkers++;
                if (activeWorkers > highWaterMark) {
                    highWaterMark = activeWorkers;
                }
                return true;
            })
            .onAfter(async () => {
                activeWorkers--;
            })
            .onFail(async () => {
                activeWorkers--;
            });

        const mapFlow = flow(map(mapItems, workerStep, { concurrency: maxConcurrency }));

        try {
            const mapRes = await mapFlow.execute({}, { pojo: true });
            InvariantEvaluator.assertBoundedConcurrency(highWaterMark, maxConcurrency);
            InvariantEvaluator.assertCombinatorSoundness('map', mapRes, {
                branchCount: mapItems.length
            });
        } catch (err: any) {
            if (err.name === 'InvariantViolation') {
                errors.push(`Iteration ${i} Map Concurrency Violation: ${err.message}`);
            }
        }

        // Sub-test C: Race settlement and non-blocking loser cleanup
        let raceCompletedCount = 0;
        const fastStep = step(`fast_${i}`, async () => {
            raceCompletedCount++;
            return { winner: 'fast' };
        });
        const slowStep = step(`slow_${i}`, async () => {
            await new Promise(r => setTimeout(r, 20));
            raceCompletedCount++;
            return { winner: 'slow' };
        });

        const raceFlow = flow(race([fastStep, slowStep]));
        const raceRes = await raceFlow.execute({}, { pojo: true });
        InvariantEvaluator.assertCombinatorSoundness('race', raceRes, {
            winnerExpected: 'fast'
        });
    }

    return {
        charterName: 'Charter 1: Core Combinator & Parallelism Stress',
        iterations,
        passed: errors.length === 0,
        durationMs: Date.now() - startTime,
        invariantsChecked,
        errors
    };
}
