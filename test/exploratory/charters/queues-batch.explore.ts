import assert from 'node:assert/strict';
import { assertExactIds } from '../engine/assertions';
import { createBullMQProcessor } from '@siglo/bullmq';
import { createKafkaBatchHandler } from '@siglo/kafka';
import { InMemoryIdempotencyStore } from '@siglo/core';
import { flow } from '@siglo/core';
import { step } from '../engine/step-helper';
import { createSqsBatchHandler, SigloSqsRecord } from '@siglo/sqs';
import { InvariantEvaluator } from '../engine/invariant-evaluator';
import { RandomSource } from '../engine/property-generators';
import { CharterResult } from './combinators.explore';

export async function runQueuesBatchCharter(iterations: number = 20, seed: number = 5005): Promise<CharterResult> {
    const startTime = Date.now();
    const rng = new RandomSource(seed);
    const errors: string[] = [];
    const invariantsChecked = [3, 7];

    for (let i = 0; i < iterations; i++) {
        const batchSize = rng.nextInt(5, 20);
        const failProbability = 0.3;

        const allMessageIds: string[] = [];
        const expectedFailedIds: string[] = [];
        const records: SigloSqsRecord[] = [];

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
                    payload: rng.string(8),
                }),
            });
        }

        const batchWorkflow = flow(
            step('processItem', async (ctx: any) => {
                const body = typeof ctx.body === 'string' ? JSON.parse(ctx.body) : ctx.body;
                if (body?.shouldFail) {
                    throw new Error(`Poison message: ${body.id}`);
                }
                return { processed: true, id: body?.id };
            }),
        );

        const handler = createSqsBatchHandler(batchWorkflow, {
            input: record => ({ body: record.body }),
        });

        const response = await handler({ Records: records });

        const nackedIds = response.batchItemFailures.map(f => f.itemIdentifier);
        const nackedSet = new Set(nackedIds);
        const ackedIds = allMessageIds.filter(id => !nackedSet.has(id));

        try {
            // Verify Oracle 7: Batch Partitioning
            InvariantEvaluator.assertBatchPartition(allMessageIds, ackedIds, nackedIds);

            assertExactIds(nackedIds, expectedFailedIds);

            const offsets: string[] = [];
            const deadLetters: string[] = [];
            const kafka = createKafkaBatchHandler(batchWorkflow, {
                input: message => ({ body: String(message.value) }),
                deadLetter: async ({ message }) => {
                    deadLetters.push(message.offset);
                },
            });
            await kafka({
                batch: {
                    topic: 'exploratory',
                    partition: 0,
                    messages: records.map((r, index) => ({ offset: String(index), value: Buffer.from(r.body!) })),
                },
                isRunning: () => true,
                isStale: () => false,
                heartbeat: async () => {},
                resolveOffset: offset => {
                    offsets.push(offset);
                },
                commitOffsetsIfNecessary: async () => {},
            });
            assert.deepEqual(
                offsets,
                records.map((_r, index) => String(index)),
            );
            assert.deepEqual(
                deadLetters,
                records.flatMap((r, index) => (expectedFailedIds.includes(r.messageId) ? [String(index)] : [])),
            );

            let effects = 0;
            const processor = createBullMQProcessor(
                flow(
                    step('jobEffect', async (ctx: any) => {
                        if (ctx.shouldFail) throw new Error('poison');
                        effects++;
                        return { done: true };
                    }),
                ),
                { idempotencyStore: new InMemoryIdempotencyStore() },
            );
            const jobs = records.map(r => ({ id: r.messageId, data: JSON.parse(r.body!) }));
            const jobOutcomes = await Promise.allSettled(jobs.map(job => processor(job)));
            assert.deepEqual(
                jobs
                    .filter((_job, index) => jobOutcomes[index].status === 'rejected')
                    .map(job => job.id)
                    .sort(),
                [...expectedFailedIds].sort(),
            );
            const successful = jobs.filter(job => !job.data.shouldFail);
            await Promise.all(successful.map(job => processor(job)));
            assert.equal(effects, successful.length);
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
        errors,
    };
}
