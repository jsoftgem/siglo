import { flow } from 'fluid-func';
import { step } from '../engine/step-helper';
import { createSqsBatchHandler, FluidSqsRecord } from '@fluid-func/sqs';
import { InvariantEvaluator } from '../engine/invariant-evaluator';
import { RandomSource } from '../engine/property-generators';
import { CharterResult } from './combinators.explore';

export async function runQueuesBatchCharter(
    iterations: number = 20,
    seed: number = 5005
): Promise<CharterResult> {
    const startTime = Date.now();
    const rng = new RandomSource(seed);
    const errors: string[] = [];
    const invariantsChecked = [7];

    for (let i = 0; i < iterations; i++) {
        const batchSize = rng.nextInt(5, 20);
        const failProbability = 0.3;

        const allMessageIds: string[] = [];
        const expectedFailedIds: string[] = [];
        const records: FluidSqsRecord[] = [];

        for (let m = 0; m < batchSize; m++) {
            const messageId = `msg_${i}_${m}_${rng.string(4)}`;
            const shouldFail = rng.nextBoolean(failProbability);
            allMessageIds.push(messageId);

            if (shouldFail) {
                expectedFailedIds.push(messageId);
            }

            records.push({
                messageId,
                receiptHandle: `rcpt_${messageId}`,
                body: JSON.stringify({
                    id: messageId,
                    shouldFail,
                    payload: rng.string(8)
                })
            });
        }

        const batchWorkflow = flow(
            step('processItem').onStart(async (ctx: any) => {
                const body = typeof ctx.body === 'string' ? JSON.parse(ctx.body) : ctx.body;
                if (body?.shouldFail) {
                    throw new Error(`Poison message: ${body.id}`);
                }
                return { processed: true, id: body?.id };
            })
        );

        const handler = createSqsBatchHandler(batchWorkflow, {
            input: record => ({ body: record.body })
        });

        const response = await handler({ Records: records });

        const nackedIds = response.batchItemFailures.map(f => f.itemIdentifier);
        const nackedSet = new Set(nackedIds);
        const ackedIds = allMessageIds.filter(id => !nackedSet.has(id));

        try {
            // Verify Oracle 7: Batch Partitioning
            InvariantEvaluator.assertBatchPartition(allMessageIds, ackedIds, nackedIds);

            // Verify that reported failures match expected poison messages
            if (nackedIds.length !== expectedFailedIds.length) {
                errors.push(
                    `Iteration ${i}: Failure count mismatch! Expected ${expectedFailedIds.length}, got ${nackedIds.length}`
                );
            }
        } catch (invErr: any) {
            errors.push(`Iteration ${i} Invariant Violation: ${invErr.message}`);
        }
    }

    return {
        charterName: 'Charter 5: Streaming & Message Queue Batch Processing',
        iterations,
        passed: errors.length === 0,
        durationMs: Date.now() - startTime,
        invariantsChecked,
        errors
    };
}
