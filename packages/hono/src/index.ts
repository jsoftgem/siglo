import { Flow, ExecutionOptions, getErrorMessage, getErrorName, isObject } from '@siglo/core';

export interface HonoLikeRequest {
    header?: (name: string) => string | undefined;
    json?: () => Promise<unknown>;
    query?: () => Record<string, unknown>;
    raw?: { signal?: AbortSignal };
}

export interface HonoLikeContext {
    req?: HonoLikeRequest;
    header?: (name: string, value: string) => unknown;
    json?: (data: unknown, status?: number) => unknown;
}

export interface SigloHonoMiddlewareOptions<TReq = HonoLikeContext, TInput = unknown, TOutput = unknown> {
    input?: (c: TReq) => Promise<TInput> | TInput;
    output?: (result: TOutput, c: TReq) => Promise<unknown> | unknown;
    timeout?: number;
    durable?: boolean | ((c: TReq) => boolean);
    namespace?: string | ((c: TReq) => string | undefined);
    onError?: (err: unknown, c: TReq) => Promise<unknown> | unknown;
    correlationIdHeader?: string;
    allowHeaderNamespace?: boolean;
    exposeErrorDetails?: boolean;
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
 * Creates a Hono-compatible middleware / route handler for executing a rivulet workflow.
 */
export function sigloMiddleware<TInput = any, TOutput = any, TReq extends HonoLikeContext = HonoLikeContext>(
    workflow: Flow<TInput, TOutput>,
    options: SigloHonoMiddlewareOptions<TReq, TInput, TOutput> = {},
) {
    return async (c: TReq, next?: () => Promise<void>): Promise<any> => {
        try {
            // Correlation ID handling
            const corrHeader = options.correlationIdHeader || 'x-correlation-id';
            const correlationId = c.req?.header?.(corrHeader) || c.req?.header?.('x-request-id');
            if (correlationId && c.header) {
                c.header('X-Correlation-Id', correlationId);
            }

            // Extract input
            let inputData: unknown = {};
            if (options.input) {
                inputData = await options.input(c);
            } else if (c.req) {
                if (typeof c.req.json === 'function' && c.req.header?.('content-type')?.includes('application/json')) {
                    try {
                        inputData = await c.req.json();
                    } catch {
                        inputData = {};
                    }
                } else if (c.req.query) {
                    inputData = c.req.query();
                }
            }

            // Extract namespace
            let namespace: string | undefined;
            if (typeof options.namespace === 'function') {
                namespace = options.namespace(c);
            } else if (options.namespace) {
                namespace = options.namespace;
            } else if (options.allowHeaderNamespace && c.req?.header) {
                const headerNs = c.req.header('x-namespace');
                namespace = typeof headerNs === 'string' ? headerNs : undefined;
            }

            // Extract abort signal
            const abortSignal = c.req?.raw?.signal;

            const execOptions: ExecutionOptions = {
                signal: abortSignal,
                timeout: options.timeout,
                namespace,
                durable: typeof options.durable === 'function' ? options.durable(c) : options.durable,
            };

            const rawResult: unknown = await workflow.run(inputData as TInput, execOptions);
            const resultObj = isObject(rawResult) ? rawResult : undefined;

            const stackId =
                typeof resultObj?.$stackId === 'function'
                    ? (resultObj.$stackId as () => unknown)()
                    : resultObj?.stackId || resultObj?.$stackId;
            if (typeof stackId === 'string' && stackId.length > 0 && c.header) {
                c.header('X-Workflow-Stack-Id', stackId);
            }

            const cleanResult = unwrapContext(rawResult);

            if (options.output) {
                return await options.output(cleanResult as TOutput, c);
            }

            if (c.json) {
                if (isObject(cleanResult) && cleanResult.status === 'waiting') {
                    return c.json(cleanResult, 202);
                }
                return c.json(cleanResult);
            }

            if (next) {
                await next();
            }
            return cleanResult;
        } catch (err: unknown) {
            if (options.onError) {
                return await options.onError(err, c);
            }
            if (c.json) {
                const status = getErrorStatusCode(err);
                const exposeDetails = options.exposeErrorDetails ?? process.env.NODE_ENV !== 'production';
                let errorMessage = getErrorMessage(err) || 'Workflow execution error';
                if (status === 500 && !exposeDetails) {
                    errorMessage = 'Internal workflow execution error';
                }
                return c.json({ error: errorMessage }, status);
            }
            throw err;
        }
    };
}

export type RivuletHonoMiddlewareOptions<
    TReq = HonoLikeContext,
    TInput = unknown,
    TOutput = unknown,
> = SigloHonoMiddlewareOptions<TReq, TInput, TOutput>;
export const rivuletMiddleware = sigloMiddleware;
