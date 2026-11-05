import { Flow, ExecutionOptions, IdempotencyStore } from '@siglo/core';

export interface SigloBullMQOptions<TJob = any, TInput = any, TOutput = any> {
    input?: (job: TJob) => Promise<TInput> | TInput;
    output?: (result: any, job: TJob) => Promise<TOutput> | TOutput;
    idempotencyStore?: IdempotencyStore;
    idempotencyTtlMs?: number;
    timeout?: number;
    namespace?: string | ((job: TJob) => string | undefined);
}

function unwrapContext(obj: any): any {
    if (!obj || typeof obj !== 'object') {
        return obj;
    }
    const clean: Record<string, any> = {};
    for (const key of Object.keys(obj)) {
        if (key.startsWith('$')) {
            continue;
        }
        const val = typeof obj[key] === 'function' ? (obj[key].val !== undefined ? obj[key].val : (obj[key].length === 0 ? obj[key]() : obj[key])) : obj[key];
        clean[key] = val;
    }
    return clean;
}

/**
 * Creates a BullMQ worker processor function that runs a siglo workflow.
 */
export function createBullMQProcessor<TInput = any, TOutput = any, TJob = any>(
    workflow: Flow<TInput, TOutput>,
    options: SigloBullMQOptions<TJob, TInput, TOutput> = {}
) {
    return async (job: any): Promise<any> => {
        const jobId = job.id || String(Date.now());
        const idempKey = `bullmq:job:${jobId}`;

        // Idempotency check if store is provided
        if (options.idempotencyStore) {
            const status = await options.idempotencyStore.claim(idempKey, options.idempotencyTtlMs);
            if (status === 'completed') {
                return (options.idempotencyStore as any).getResult?.(idempKey) ?? { alreadyProcessed: true };
            }
            if (status === 'in-progress') {
                throw new Error(`Job ${jobId} is already in-progress concurrently`);
            }
        }

        try {
            const inputData = options.input ? await options.input(job) : (job.data || {});

            let namespace: string | undefined;
            if (typeof options.namespace === 'function') {
                namespace = options.namespace(job);
            } else if (options.namespace) {
                namespace = options.namespace;
            } else if (job.data?.namespace) {
                namespace = job.data.namespace;
            }

            const execOptions: ExecutionOptions = {
                timeout: options.timeout,
                namespace,
            };

            const rawResult: any = await workflow.run(inputData, execOptions);
            const cleanResult = unwrapContext(rawResult);

            if (options.idempotencyStore) {
                await options.idempotencyStore.complete(idempKey, cleanResult);
            }

            if (options.output) {
                return await options.output(cleanResult, job);
            }

            return cleanResult;
        } catch (err: any) {
            if (options.idempotencyStore) {
                await options.idempotencyStore.fail(idempKey, err);
            }
            throw err;
        }
    };
}


export type RivuletBullMQOptions<TJob = any, TInput = any, TOutput = any> = SigloBullMQOptions<TJob, TInput, TOutput>;
