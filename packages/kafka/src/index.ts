import { Flow, ExecutionOptions, IdempotencyStore } from '@siglo/core';

export interface SigloKafkaMessage {
    key?: Buffer | string | null;
    value?: Buffer | string | null;
    partition: number;
    topic: string;
    offset: string;
    headers?: Record<string, Buffer | string | undefined>;
}

export interface SigloKafkaOptions<TInput = any, TOutput = any> {
    input?: (message: SigloKafkaMessage) => Promise<TInput> | TInput;
    output?: (result: any, message: SigloKafkaMessage) => Promise<TOutput> | TOutput;
    idempotencyStore?: IdempotencyStore;
    idempotencyTtlMs?: number;
    timeout?: number;
    namespace?: string | ((message: SigloKafkaMessage) => string | undefined);
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
 * Creates a Kafka message consumer handler for executing a rivulet workflow.
 */
export function createKafkaMessageHandler<TInput = any, TOutput = any>(
    workflow: Flow<TInput, TOutput>,
    options: SigloKafkaOptions<TInput, TOutput> = {}
) {
    return async (payload: { topic: string; partition: number; message: SigloKafkaMessage }): Promise<any> => {
        const { message, topic, partition } = payload;
        const msgKey = message.key ? String(message.key) : `${topic}:${partition}:${message.offset}`;
        const idempKey = `kafka:${topic}:${msgKey}`;

        if (options.idempotencyStore) {
            const status = await options.idempotencyStore.claim(idempKey, options.idempotencyTtlMs);
            if (status === 'completed') {
                return (options.idempotencyStore as any).getResult?.(idempKey) ?? { deduplicated: true };
            }
            if (status === 'in-progress') {
                throw new Error(`Kafka message ${idempKey} is already being processed concurrently`);
            }
        }

        try {
            let parsedValue: any = {};
            if (options.input) {
                parsedValue = await options.input(message);
            } else if (message.value) {
                const str = Buffer.isBuffer(message.value)
                    ? message.value.toString('utf-8')
                    : (typeof message.value === 'string' ? message.value : String(message.value));
                try {
                    parsedValue = JSON.parse(str);
                } catch {
                    parsedValue = { raw: str };
                }
            }

            let namespace: string | undefined;
            if (typeof options.namespace === 'function') {
                namespace = options.namespace(message);
            } else if (options.namespace) {
                namespace = options.namespace;
            } else if (message.headers?.['x-namespace']) {
                namespace = String(message.headers['x-namespace']);
            }

            const execOptions: ExecutionOptions = {
                timeout: options.timeout,
                namespace,
            };

            const rawResult: any = await workflow.run(parsedValue, execOptions);
            const cleanResult = unwrapContext(rawResult);

            if (options.idempotencyStore) {
                await options.idempotencyStore.complete(idempKey, cleanResult);
            }

            if (options.output) {
                return await options.output(cleanResult, message);
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


export type RivuletKafkaMessage = SigloKafkaMessage;
export type RivuletKafkaOptions<TInput = any, TOutput = any> = SigloKafkaOptions<TInput, TOutput>;
