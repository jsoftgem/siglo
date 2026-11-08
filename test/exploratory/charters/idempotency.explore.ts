import { InMemoryIdempotencyStore } from '@siglo/core';
import { flow } from '@siglo/core';
import { step } from '../engine/step-helper';
import { RandomSource } from '../engine/property-generators';
import { CharterResult } from './combinators.explore';

export async function runIdempotencyCharter(iterations: number = 20, seed: number = 4004): Promise<CharterResult> {
    const startTime = Date.now();
    const rng = new RandomSource(seed);
    const errors: string[] = [];
    const invariantsChecked = [3];

    for (let i = 0; i < iterations; i++) {
        const store = new InMemoryIdempotencyStore();
        let actualExecutionCount = 0;
        const key = `order_${i}_${rng.string(5)}`;
        const ttlMs = 50;

        const paymentStep = step('processPayment', async (ctx: any) => {
            actualExecutionCount++;
            const delay = rng.nextInt(5, 15);
            await new Promise(r => setTimeout(r, delay));
            return { paymentRef: `ref_${key}`, charged: true };
        }).idempotent(key, { store, ttlMs });

        const paymentFlow = flow(paymentStep);

        // 1. Launch a stampede of concurrent calls with the identical idempotency key
        const stampedeSize = rng.nextInt(5, 12);
        const promises: Promise<any>[] = [];

        for (let j = 0; j < stampedeSize; j++) {
            promises.push(paymentFlow.run({ idempotencyKey: key, callerId: j }, { pojo: true }));
        }

        const results = await Promise.allSettled(promises);
        if (results.length !== stampedeSize) {
            errors.push(`Iteration ${i}: Stampede promises length mismatch.`);
        }

        // 2. Validate that execution body ran AT MOST once for the duration of the claim
        if (actualExecutionCount > 1) {
            errors.push(
                `Iteration ${i}: Idempotency breach! Step body executed ${actualExecutionCount} times concurrently for key ${key}.`,
            );
        }

        // 3. Test TTL expiration
        await new Promise(r => setTimeout(r, ttlMs + 15));
        try {
            await paymentFlow.run({ idempotencyKey: key }, { pojo: true });
            if (actualExecutionCount !== 2) {
                errors.push(
                    `Iteration ${i}: TTL expiration failure! Expected actualExecutionCount to be 2 after TTL expiry, but got ${actualExecutionCount}.`,
                );
            }
        } catch (ttlErr: any) {
            errors.push(`Iteration ${i}: Post-TTL execution threw unexpectedly: ${ttlErr.message}`);
        }
    }

    return {
        charterName: 'Charter 4: Idempotency Key Collisions & TTL Expiry',
        iterations,
        passed: errors.length === 0,
        durationMs: Date.now() - startTime,
        invariantsChecked,
        errors,
    };
}
