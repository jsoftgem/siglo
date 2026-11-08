import { Flow, ExecutionOptions, IdempotencyStore, FlowTimeoutException, StepTimeoutException } from '@siglo/core';

/** A Kafka record enriched with its topic and partition for adapter callbacks. */
export interface SigloKafkaMessage {
    key?: Buffer | string | null;
    value?: Buffer | string | null;
    partition: number;
    topic: string;
    offset: string;
    timestamp?: string;
    headers?: Record<string, Buffer | string | (Buffer | string)[] | undefined>;
}

export type SigloKafkaRecord = Omit<SigloKafkaMessage, 'topic' | 'partition'> &
    Partial<Pick<SigloKafkaMessage, 'topic' | 'partition'>>;

export interface SigloKafkaPayload {
    topic: string;
    partition: number;
    message: SigloKafkaRecord;
    heartbeat?: () => Promise<void>;
    isRunning?: () => boolean;
    isStale?: () => boolean;
}

export interface SigloKafkaBatchPayload {
    batch: { topic: string; partition: number; messages: SigloKafkaRecord[] };
    resolveOffset: (offset: string) => void;
    heartbeat: () => Promise<void>;
    commitOffsetsIfNecessary: () => Promise<void>;
    isRunning: () => boolean;
    isStale: () => boolean;
}

export interface KafkaDeadLetter {
    message: SigloKafkaMessage;
    /** Stable across deliveries; use as a deduplication key at the destination. */
    recordId: string;
    error: unknown;
    attempts: number;
}

export interface SigloKafkaOptions<TInput = any, TOutput = any> {
    input?: (message: SigloKafkaMessage) => Promise<TInput> | TInput;
    validate?: (input: TInput, message: SigloKafkaMessage) => Promise<void> | void;
    output?: (result: any, message: SigloKafkaMessage) => Promise<TOutput> | TOutput;
    /** Required when using an idempotency store; use the KafkaJS consumer group ID. */
    groupId?: string;
    idempotencyStore?: IdempotencyStore;
    /** Default: 24 hours. Processing is cancelled at 80% of this budget. */
    idempotencyTtlMs?: number;
    /** Business identity within the group and tenant scope. */
    idempotencyKey?: (message: SigloKafkaMessage) => string;
    timeout?: number;
    namespace?: string | ((message: SigloKafkaMessage) => string | undefined);
    heartbeatIntervalMs?: number;
    signal?: AbortSignal;
    /** Default: error. Use raw for the previous { raw: string } behavior. */
    invalidJson?: 'error' | 'raw';
    /** Default: skip. process passes tombstones through input (or {} by default). */
    tombstone?: 'skip' | 'error' | 'process';
    retry?: {
        /** Includes the initial attempt. Default: 1. Applies to workflow errors only. */
        maxAttempts: number;
        delayMs?: number;
        shouldRetry?: (error: unknown, message: SigloKafkaMessage) => boolean;
    };
    /** Awaited before a failed record is considered handled. Failure rejects processing. */
    deadLetter?: (failure: KafkaDeadLetter) => Promise<void>;
}

export interface SigloKafkaBatchOptions<TInput = any, TOutput = any> extends SigloKafkaOptions<TInput, TOutput> {
    commitOffsets?: boolean;
}

export class KafkaInvalidMessageError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'KafkaInvalidMessageError';
    }
}

export class KafkaProcessingCancelledError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'KafkaProcessingCancelledError';
    }
}

/** Stable record identity for downstream deduplication, independent of consumer group. */
export function getKafkaRecordId(message: Pick<SigloKafkaMessage, 'topic' | 'partition' | 'offset'>): string {
    return `kafka:${message.topic}:${message.partition}:${message.offset}`;
}

type Outcome = { $sigloKafka: 1; kind: 'processed' | 'skipped' | 'dead-lettered'; value: any };

function unwrapContext(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj;
    const clean: Record<string, any> = {};
    for (const key of Object.keys(obj)) {
        if (key.startsWith('$')) continue;
        const val =
            typeof obj[key] === 'function'
                ? obj[key].val !== undefined
                    ? obj[key].val
                    : obj[key].length === 0
                      ? obj[key]()
                      : obj[key]
                : obj[key];
        if (key === 'signal' && val instanceof AbortSignal) continue;
        clean[key] = val;
    }
    return clean;
}

function duration(name: string, value: number, allowZero = false): void {
    if (!Number.isFinite(value) || value < (allowZero ? 0 : 1) || value > 2147483647) {
        throw new RangeError(`${name} must be between ${allowZero ? 0 : 1} and 2147483647`);
    }
}

function isTimeout(error: unknown): boolean {
    return error instanceof FlowTimeoutException || error instanceof StepTimeoutException;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** Cancellation also fences adapter work after callbacks that ignore the signal settle. */
async function guarded<T>(
    run: (signal: AbortSignal) => Promise<T>,
    payload: SigloKafkaPayload,
    options: SigloKafkaOptions,
    controller: AbortController,
    deadline: number | undefined,
): Promise<T> {
    const abort = (message: string, cause?: unknown) => {
        if (!controller.signal.aborted) controller.abort(new KafkaProcessingCancelledError(message, { cause }));
    };
    const checkState = () => {
        try {
            if (options.signal?.aborted) abort('Kafka processing cancelled', options.signal.reason);
            if (payload.isRunning?.() === false || payload.isStale?.() === true)
                abort('Kafka consumer stopped or batch became stale');
            if (deadline !== undefined && Date.now() >= deadline) abort('Kafka processing deadline exceeded');
        } catch (error) {
            abort('Kafka consumer state check failed', error);
        }
    };
    const onAbort = () => abort('Kafka processing cancelled', options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let rejectCancellation: (error: unknown) => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
    });
    const onCancelled = () => rejectCancellation(controller.signal.reason);
    controller.signal.addEventListener('abort', onCancelled, { once: true });
    let pending: Promise<void> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const stateTimer = setInterval(checkState, 50);
    const deadlineTimer =
        deadline === undefined ? undefined : setTimeout(checkState, Math.max(1, Math.ceil(deadline - Date.now())));
    const heartbeat = () => {
        if (pending || controller.signal.aborted || !payload.heartbeat) return;
        pending = Promise.resolve()
            .then(() => payload.heartbeat!())
            .catch(error => {
                abort(`Kafka heartbeat failed: ${String(error)}`, error);
            })
            .finally(() => {
                pending = undefined;
            });
    };
    try {
        checkState();
        const operation = async () => {
            controller.signal.throwIfAborted();
            if (payload.heartbeat && (options.heartbeatIntervalMs ?? 5000) > 0) {
                heartbeat();
                await pending;
                controller.signal.throwIfAborted();
                heartbeatTimer = setInterval(heartbeat, options.heartbeatIntervalMs ?? 5000);
            }
            const result = await run(controller.signal);
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            await pending;
            checkState();
            controller.signal.throwIfAborted();
            return result;
        };
        return await Promise.race([operation(), cancelled]);
    } finally {
        clearInterval(stateTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        options.signal?.removeEventListener('abort', onAbort);
        controller.signal.removeEventListener('abort', onCancelled);
    }
}

/** Creates a handler that can be passed directly to KafkaJS eachMessage. */
export function createKafkaMessageHandler<TInput = any, TOutput = any>(
    workflow: Flow<TInput, TOutput>,
    options: SigloKafkaOptions<TInput, TOutput> = {},
) {
    duration('heartbeatIntervalMs', options.heartbeatIntervalMs ?? 5000, true);
    if (options.timeout !== undefined) duration('timeout', options.timeout);
    const ttl = options.idempotencyTtlMs ?? 86400000;
    duration('idempotencyTtlMs', ttl);
    if (options.idempotencyStore && !options.groupId?.trim()) {
        throw new Error('groupId is required when using an idempotencyStore');
    }
    if (options.idempotencyStore && options.timeout !== undefined && options.timeout >= ttl * 0.8) {
        throw new RangeError('timeout must be less than 80% of idempotencyTtlMs');
    }
    if (!['error', 'raw'].includes(options.invalidJson ?? 'error')) throw new Error('Invalid invalidJson policy');
    if (!['skip', 'error', 'process'].includes(options.tombstone ?? 'skip'))
        throw new Error('Invalid tombstone policy');
    const maxAttempts = options.retry?.maxAttempts ?? 1;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
        throw new RangeError('retry.maxAttempts must be a positive integer');
    duration('retry.delayMs', options.retry?.delayMs ?? 0, true);

    return async (payload: SigloKafkaPayload): Promise<any> => {
        const message: SigloKafkaMessage = { ...payload.message, topic: payload.topic, partition: payload.partition };
        const recordId = getKafkaRecordId(message);
        const store = options.idempotencyStore;
        let namespace: string | undefined;
        if (typeof options.namespace === 'function') namespace = options.namespace(message);
        else if (options.namespace !== undefined) namespace = options.namespace;
        else if (message.headers?.['x-namespace']) namespace = String(message.headers['x-namespace']);
        // JSON encoding preserves scope boundaries even when IDs contain delimiters.
        const idempKey = `kafka:${JSON.stringify([options.groupId, namespace ?? null, options.idempotencyKey?.(message) ?? recordId])}`;
        const controller = new AbortController();
        let completionAttempted = false;
        const mapOutcome = (outcome: Outcome) =>
            outcome.kind === 'processed' && options.output ? options.output(outcome.value, message) : outcome.value;
        if (options.signal?.aborted || payload.isRunning?.() === false || payload.isStale?.() === true) {
            throw new KafkaProcessingCancelledError('Kafka processing cancelled before claim');
        }
        const startedAt = Date.now();
        if (store) {
            const status = await store.claim(idempKey, ttl);
            if (status === 'completed') {
                return guarded(
                    async signal => {
                        const result: any = store.get ? await store.get(idempKey) : undefined;
                        signal.throwIfAborted();
                        return result?.$sigloKafka === 1
                            ? mapOutcome(result)
                            : mapOutcome({
                                  $sigloKafka: 1,
                                  kind: 'processed',
                                  value: result === undefined ? { deduplicated: true } : result,
                              });
                    },
                    payload,
                    options,
                    controller,
                    options.timeout === undefined ? undefined : startedAt + options.timeout,
                );
            }
            if (status === 'in-progress')
                throw new Error(`Kafka message ${idempKey} is already being processed concurrently`);
        }
        const budget = Math.min(options.timeout ?? Infinity, store ? ttl * 0.8 : Infinity);
        const deadline = Number.isFinite(budget) ? startedAt + budget : undefined;
        let attempts = 0;
        try {
            return await guarded(
                async signal => {
                    const checkActive = () => {
                        if (deadline !== undefined && Date.now() >= deadline && !signal.aborted) {
                            controller.abort(new KafkaProcessingCancelledError('Kafka processing deadline exceeded'));
                        }
                        signal.throwIfAborted();
                    };
                    const finish = async (kind: Outcome['kind'], value: any) => {
                        checkActive();
                        const outcome: Outcome = { $sigloKafka: 1, kind, value };
                        if (store) {
                            completionAttempted = true;
                            await store.complete(idempKey, outcome);
                        }
                        checkActive();
                        return mapOutcome(outcome);
                    };
                    let outcome: Outcome;
                    try {
                        if (message.value == null && options.tombstone !== 'process') {
                            if (options.tombstone === 'error')
                                throw new KafkaInvalidMessageError('Kafka tombstone is not accepted');
                            return finish('skipped', { skipped: true, recordId });
                        }
                        let input: any = {};
                        if (options.input) input = await options.input(message);
                        else if (message.value != null) {
                            const text = String(message.value);
                            try {
                                input = JSON.parse(text);
                            } catch (cause) {
                                if (options.invalidJson === 'raw') input = { raw: text };
                                else
                                    throw new KafkaInvalidMessageError('Kafka message contains invalid JSON', {
                                        cause,
                                    });
                            }
                        }
                        checkActive();
                        if (options.validate) {
                            try {
                                await options.validate(input, message);
                            } catch (cause) {
                                throw new KafkaInvalidMessageError('Kafka workflow input validation failed', { cause });
                            }
                        }
                        for (;;) {
                            checkActive();
                            attempts++;
                            try {
                                const execOptions: ExecutionOptions = { namespace, signal, timeout: options.timeout };
                                const result = await workflow.run(input, execOptions);
                                checkActive();
                                outcome = { $sigloKafka: 1, kind: 'processed', value: unwrapContext(result) };
                                break;
                            } catch (error) {
                                checkActive();
                                if (isTimeout(error))
                                    throw new KafkaProcessingCancelledError('Kafka workflow timed out', {
                                        cause: error,
                                    });
                                if (
                                    error instanceof KafkaInvalidMessageError ||
                                    attempts >= maxAttempts ||
                                    options.retry?.shouldRetry?.(error, message) === false
                                )
                                    throw error;
                                await delay(options.retry?.delayMs ?? 0, signal);
                            }
                        }
                    } catch (error) {
                        checkActive();
                        if (error instanceof KafkaProcessingCancelledError || !options.deadLetter) throw error;
                        await options.deadLetter({ message, recordId, error, attempts });
                        checkActive();
                        outcome = {
                            $sigloKafka: 1,
                            kind: 'dead-lettered',
                            value: { deadLettered: true, recordId, attempts },
                        };
                    }
                    return finish(outcome.kind, outcome.value);
                },
                payload,
                options,
                controller,
                deadline,
            );
        } catch (error) {
            // Cancellation/timeouts may leave uncancelled external work in flight. Retain
            // the claim until expiry instead of making an immediate duplicate possible.
            if (
                store &&
                !completionAttempted &&
                !controller.signal.aborted &&
                !(error instanceof KafkaProcessingCancelledError)
            ) {
                try {
                    await store.fail(idempKey, error);
                } catch (cleanupError) {
                    throw new AggregateError([error, cleanupError], 'Kafka processing and claim cleanup failed');
                }
            }
            throw error;
        }
    };
}

/** Processes partition batches sequentially; use eachBatchAutoResolve: false. */
export function createKafkaBatchHandler<TInput = any, TOutput = any>(
    workflow: Flow<TInput, TOutput>,
    options: SigloKafkaBatchOptions<TInput, TOutput> = {},
) {
    const handleMessage = createKafkaMessageHandler(workflow, options);
    return async (payload: SigloKafkaBatchPayload): Promise<void> => {
        for (const message of payload.batch.messages) {
            if (!payload.isRunning() || payload.isStale()) return;
            try {
                await handleMessage({
                    topic: payload.batch.topic,
                    partition: payload.batch.partition,
                    message,
                    heartbeat: () => payload.heartbeat(),
                    isRunning: () => payload.isRunning(),
                    isStale: () => payload.isStale(),
                });
            } catch (error) {
                if (error instanceof KafkaProcessingCancelledError && (!payload.isRunning() || payload.isStale()))
                    return;
                throw error;
            }
            if (!payload.isRunning() || payload.isStale()) return;
            await payload.heartbeat();
            if (!payload.isRunning() || payload.isStale()) return;
            payload.resolveOffset(message.offset);
            if (options.commitOffsets !== false) await payload.commitOffsetsIfNecessary();
        }
    };
}

export type RivuletKafkaMessage = SigloKafkaMessage;
export type RivuletKafkaOptions<TInput = any, TOutput = any> = SigloKafkaOptions<TInput, TOutput>;
