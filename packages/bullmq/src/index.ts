import { Flow, ExecutionOptions, IdempotencyStore, isObject } from '@siglo/core';

export interface BullMQLikeJob {
    id?: string | number;
    data?: unknown;
    [key: string]: unknown;
}

export interface SigloBullMQOptions<TJob = BullMQLikeJob, TInput = any, TOutput = any> {
    input?: (job: TJob) => Promise<TInput> | TInput;
    output?: (result: unknown, job: TJob) => Promise<TOutput> | TOutput;
    idempotencyStore?: IdempotencyStore;
    idempotencyTtlMs?: number;
    timeout?: number;
    namespace?: string | ((job: TJob) => string | undefined);
}

function unwrapContext(obj: unknown): unknown {
    if (!obj || typeof obj !== 'object') {
        return obj;
    }
    const source = obj as Record<string, unknown>;
    const clean: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
        if (key.startsWith('$')) {
            continue;
        }
        const rawVal = source[key];
        let val = rawVal;
        if (typeof rawVal === 'function') {
            const fn = rawVal as (() => unknown) & { val?: unknown };
            val = fn.val !== undefined ? fn.val : fn.length === 0 ? fn() : fn;
        }
        clean[key] = val;
    }
    return clean;
}

/**
 * Creates a BullMQ worker processor function that runs a siglo workflow.
 */
export function createBullMQProcessor<TInput = any, TOutput = any, TJob extends BullMQLikeJob = BullMQLikeJob>(
    workflow: Flow<TInput, TOutput>,
    options: SigloBullMQOptions<TJob, TInput, TOutput> = {},
) {
    return async (job: TJob): Promise<any> => {
        const jobId = job.id !== undefined && job.id !== null && job.id !== '' ? String(job.id) : String(Date.now());
        const idempKey = `bullmq:job:${jobId}`;

        // Idempotency check if store is provided
        if (options.idempotencyStore) {
            const status = await options.idempotencyStore.claim(idempKey, options.idempotencyTtlMs);
            if (status === 'completed') {
                const store = options.idempotencyStore as IdempotencyStore & {
                    getResult?: (key: string) => Promise<unknown>;
                };
                const cached = store.getResult
                    ? await store.getResult(idempKey)
                    : store.get
                      ? await store.get(idempKey)
                      : undefined;
                return cached ?? { alreadyProcessed: true };
            }
            if (status === 'in-progress') {
                throw new Error(`Job ${jobId} is already in-progress concurrently`);
            }
        }

        try {
            const inputData = options.input ? await options.input(job) : job.data !== undefined ? job.data : {};

            let namespace: string | undefined;
            if (typeof options.namespace === 'function') {
                namespace = options.namespace(job);
            } else if (options.namespace !== undefined) {
                namespace = options.namespace;
            } else if (isObject(job.data) && typeof job.data.namespace === 'string') {
                namespace = job.data.namespace;
            }

            const execOptions: ExecutionOptions = {
                timeout: options.timeout,
                namespace,
            };

            const rawResult: unknown = await workflow.run(inputData as TInput, execOptions);
            const cleanResult = unwrapContext(rawResult);

            if (options.idempotencyStore) {
                await options.idempotencyStore.complete(idempKey, cleanResult);
            }

            if (options.output) {
                return await options.output(cleanResult, job);
            }

            return cleanResult;
        } catch (err: unknown) {
            if (options.idempotencyStore) {
                await options.idempotencyStore.fail(idempKey, err);
            }
            throw err;
        }
    };
}

export type RivuletBullMQOptions<TJob = BullMQLikeJob, TInput = any, TOutput = any> = SigloBullMQOptions<
    TJob,
    TInput,
    TOutput
>;
