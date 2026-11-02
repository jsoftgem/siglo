import { Flow, ExecutionOptions, IdempotencyStore } from 'siglo';

export interface SigloSqsRecord {
    messageId: string;
    receiptHandle: string;
    body: string;
    attributes?: Record<string, string>;
    messageAttributes?: Record<string, any>;
}

export interface SigloSqsEvent {
    Records: SigloSqsRecord[];
}

export interface SigloSqsOptions<TInput = any, TOutput = any> {
    input?: (record: SigloSqsRecord) => Promise<TInput> | TInput;
    output?: (result: any, record: SigloSqsRecord) => Promise<TOutput> | TOutput;
    idempotencyStore?: IdempotencyStore;
    idempotencyTtlMs?: number;
    timeout?: number;
    namespace?: string | ((record: SigloSqsRecord) => string | undefined);
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

export interface SqsBatchResponse {
    batchItemFailures: Array<{ itemIdentifier: string }>;
    processedCount: number;
}

/**
 * Creates an AWS Lambda compatible SQS batch message handler for rivulet workflows.
 */
export function createSqsBatchHandler<TInput = any, TOutput = any>(
    workflow: Flow<TInput, TOutput>,
    options: SigloSqsOptions<TInput, TOutput> = {}
) {
    return async (event: SigloSqsEvent): Promise<SqsBatchResponse> => {
        const batchItemFailures: Array<{ itemIdentifier: string }> = [];
        let processedCount = 0;

        for (const record of event.Records || []) {
            const idempKey = `sqs:${record.messageId}`;

            if (options.idempotencyStore) {
                const status = await options.idempotencyStore.claim(idempKey, options.idempotencyTtlMs);
                if (status === 'completed') {
                    processedCount++;
                    continue;
                }
            }

            try {
                let parsedInput: any = {};
                if (options.input) {
                    parsedInput = await options.input(record);
                } else if (record.body) {
                    try {
                        parsedInput = JSON.parse(record.body);
                    } catch {
                        parsedInput = { body: record.body };
                    }
                }

                let namespace: string | undefined;
                if (typeof options.namespace === 'function') {
                    namespace = options.namespace(record);
                } else if (options.namespace) {
                    namespace = options.namespace;
                } else if (record.messageAttributes?.namespace?.stringValue) {
                    namespace = record.messageAttributes.namespace.stringValue;
                }

                const execOptions: ExecutionOptions = {
                    timeout: options.timeout,
                    namespace,
                };

                const rawResult: any = await workflow.run(parsedInput, execOptions);
                const cleanResult = unwrapContext(rawResult);

                if (options.idempotencyStore) {
                    await options.idempotencyStore.complete(idempKey, cleanResult);
                }

                processedCount++;
            } catch (err: any) {
                if (options.idempotencyStore) {
                    await options.idempotencyStore.fail(idempKey, err);
                }
                batchItemFailures.push({ itemIdentifier: record.messageId });
            }
        }

        return { batchItemFailures, processedCount };
    };
}


export type RivuletSqsRecord = SigloSqsRecord;
export type RivuletSqsEvent = SigloSqsEvent;
export type RivuletSqsOptions<TInput = any, TOutput = any> = SigloSqsOptions<TInput, TOutput>;
