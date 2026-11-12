import { RandomSource } from './property-generators';

export interface CharterResult {
    charterName: string;
    passed: boolean;
    iterations: number;
    errors: string[];
    durationMs: number;
    invariantsChecked: number[];
    evidence?: unknown[];
}

/** Each generated case has its own seed, so a failure is reproducible without preceding cases. */
export async function exploreCases(
    charterName: string,
    iterations: number,
    seed: number,
    invariantsChecked: number[],
    run: (rng: RandomSource, iteration: number, record: (value: unknown) => void) => Promise<void>,
): Promise<CharterResult> {
    const started = Date.now();
    const errors: string[] = [];
    const evidence: unknown[] = [];
    const seeds = new RandomSource(seed);
    for (let iteration = 0; iteration < iterations; iteration++) {
        const caseSeed = seeds.nextInt(1, 0xffffffff);
        const trace: unknown[] = [];
        try {
            await run(new RandomSource(caseSeed), iteration, value => trace.push(value));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`Iteration ${iteration} (case seed ${caseSeed}): ${message}`);
            evidence.push({
                iteration,
                caseSeed,
                trace,
                error: message,
                stack: error instanceof Error ? error.stack : undefined,
            });
        }
    }
    return {
        charterName,
        passed: errors.length === 0,
        iterations,
        errors,
        durationMs: Date.now() - started,
        invariantsChecked,
        evidence,
    };
}
