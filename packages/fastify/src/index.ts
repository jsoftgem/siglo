import { requestCancellation, DisconnectRequestLike, DisconnectResponseLike } from './disconnect';
import { Flow, ExecutionOptions, getErrorMessage, getErrorName, isObject } from '@siglo/core';

export interface FastifyLikeRequest extends DisconnectRequestLike {
    body?: unknown;
    query?: Record<string, unknown>;
    headers?: Record<string, string | string[] | undefined>;
    raw?: DisconnectRequestLike;
}

export interface FastifyLikeReply extends DisconnectResponseLike {
    header?: (name: string, value: string) => unknown;
    status?: (code: number) => FastifyLikeReply;
    send?: (payload: unknown) => unknown;
    raw?: DisconnectResponseLike;
}

export interface SigloFastifyOptions<TReq = FastifyLikeRequest, TInput = unknown, TOutput = unknown> {
    input?: (req: TReq) => Promise<TInput> | TInput;
    output?: (result: TOutput, reply: FastifyLikeReply) => Promise<unknown> | unknown;
    timeout?: number;
    durable?: boolean | ((req: TReq) => boolean);
    namespace?: string | ((req: TReq) => string | undefined);
    onError?: (err: unknown, reply: FastifyLikeReply) => Promise<unknown> | unknown;
    correlationIdHeader?: string;
    allowHeaderNamespace?: boolean;
    exposeErrorDetails?: boolean;
}

function normalizeHeader(value: string | string[] | undefined): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0];
    }
    return undefined;
}

export function getErrorStatusCode(err: unknown): number {
    if (!err) {
        return 500;
    }
    const name = getErrorName(err) ?? '';
    const record = isObject(err) ? err : undefined;
    const causeName = (record && (getErrorName(record.cause) ?? getErrorName(record.error))) ?? '';

    if ((record && record.isTimeout === true) || name.includes('Timeout') || causeName.includes('Timeout')) {
        return 504;
    }
    if (
        name.includes('SpecFailed') ||
        name.includes('Validation') ||
        causeName.includes('SpecFailed') ||
        causeName.includes('Validation')
    ) {
        return 400;
    }
    if (
        name.includes('Idempotency') ||
        name.includes('Conflict') ||
        causeName.includes('Idempotency') ||
        causeName.includes('Conflict')
    ) {
        return 409;
    }
    const message = record && typeof record.message === 'string' ? record.message : undefined;
    if (
        (record && record.isCancellation === true) ||
        name.includes('Cancellation') ||
        name.includes('Abort') ||
        causeName.includes('Cancellation') ||
        causeName.includes('Abort') ||
        message?.includes('aborted')
    ) {
        return 499;
    }
    return record && typeof record.status === 'number' ? record.status : 500;
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
 * Creates a Fastify route handler for executing a rivulet workflow.
 */
export function sigloFastifyHandler<TInput = any, TOutput = any, TReq extends FastifyLikeRequest = FastifyLikeRequest>(
    workflow: Flow<TInput, TOutput>,
    options: SigloFastifyOptions<TReq, TInput, TOutput> = {},
) {
    return async (request: TReq, reply: FastifyLikeReply): Promise<any> => {
        const cancellation = requestCancellation(request.raw || request, reply.raw || reply, request.raw?.signal);
        try {
            // Correlation ID handling
            const corrHeader = (options.correlationIdHeader || 'x-correlation-id').toLowerCase();
            const correlationId =
                normalizeHeader(request.headers?.[corrHeader]) ?? normalizeHeader(request.headers?.['x-request-id']);
            if (correlationId && reply.header) {
                reply.header('X-Correlation-Id', correlationId);
            }

            let inputData: unknown = {};
            if (options.input) {
                inputData = await options.input(request);
            } else if (request.body !== undefined) {
                inputData = request.body;
            } else if (request.query) {
                inputData = request.query;
            }

            let namespace: string | undefined;
            if (typeof options.namespace === 'function') {
                namespace = options.namespace(request);
            } else if (options.namespace) {
                namespace = options.namespace;
            } else if (options.allowHeaderNamespace) {
                namespace = normalizeHeader(request.headers?.['x-namespace']);
            }

            const abortSignal = cancellation.signal;

            const execOptions: ExecutionOptions = {
                signal: abortSignal,
                timeout: options.timeout,
                namespace,
                durable: typeof options.durable === 'function' ? options.durable(request) : options.durable,
            };

            const rawResult: unknown = await workflow.run(inputData as TInput, execOptions);
            const resultObj = isObject(rawResult) ? rawResult : undefined;

            const stackId =
                typeof resultObj?.$stackId === 'function'
                    ? (resultObj.$stackId as () => unknown)()
                    : resultObj?.stackId || resultObj?.$stackId;
            if (typeof stackId === 'string' && stackId.length > 0 && reply.header) {
                reply.header('X-Workflow-Stack-Id', stackId);
            }

            const cleanResult = unwrapContext(rawResult);

            if (options.output) {
                return await options.output(cleanResult as TOutput, reply);
            }

            if (isObject(cleanResult) && cleanResult.status === 'waiting') {
                reply.status?.(202);
            }
            return cleanResult;
        } catch (err: unknown) {
            if (options.onError) {
                return await options.onError(err, reply);
            }
            const status = getErrorStatusCode(err);
            const exposeDetails = options.exposeErrorDetails ?? process.env.NODE_ENV !== 'production';
            let errorMessage = getErrorMessage(err) || 'Workflow execution error';
            if (status === 500 && !exposeDetails) {
                errorMessage = 'Internal workflow execution error';
            }
            const statusReply = reply.status?.(status) ?? reply;
            return statusReply.send?.({ error: errorMessage });
        } finally {
            cancellation.cleanup();
        }
    };
}

export type RivuletFastifyOptions<TReq = FastifyLikeRequest, TInput = unknown, TOutput = unknown> = SigloFastifyOptions<
    TReq,
    TInput,
    TOutput
>;
export const rivuletFastifyHandler = sigloFastifyHandler;
