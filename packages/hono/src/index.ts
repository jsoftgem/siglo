import { Flow, ExecutionOptions } from '@siglo/core';

export interface SigloHonoMiddlewareOptions<TReq = any, TInput = any, TOutput = any> {
    input?: (c: TReq) => Promise<TInput> | TInput;
    output?: (result: TOutput, c: TReq) => Promise<any> | any;
    timeout?: number;
    namespace?: string | ((c: TReq) => string | undefined);
    onError?: (err: any, c: TReq) => Promise<any> | any;
    correlationIdHeader?: string;
    allowHeaderNamespace?: boolean;
    exposeErrorDetails?: boolean;
}

export function getErrorStatusCode(err: any): number {
    if (!err) {
        return 500;
    }
    const name = err.name || '';
    const causeName = err.cause?.name || (err.error?.name) || '';

    if (err.isTimeout || name.includes('Timeout') || causeName.includes('Timeout')) {
        return 504;
    }
    if (name.includes('SpecFailed') || name.includes('Validation') || causeName.includes('SpecFailed') || causeName.includes('Validation')) {
        return 400;
    }
    if (name.includes('Idempotency') || name.includes('Conflict') || causeName.includes('Idempotency') || causeName.includes('Conflict')) {
        return 409;
    }
    if (err.isCancellation || name.includes('Cancellation') || name.includes('Abort') || causeName.includes('Cancellation') || causeName.includes('Abort') || err.message?.includes('aborted')) {
        return 499;
    }
    return typeof err.status === 'number' ? err.status : 500;
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
 * Creates a Hono-compatible middleware / route handler for executing a rivulet workflow.
 */
export function sigloMiddleware<TInput = any, TOutput = any, TReq = any>(
    workflow: Flow<TInput, TOutput>,
    options: SigloHonoMiddlewareOptions<TReq, TInput, TOutput> = {}
) {
    return async (c: any, next?: () => Promise<void>): Promise<any> => {
        try {
            // Correlation ID handling
            const corrHeader = options.correlationIdHeader || 'x-correlation-id';
            const correlationId = c.req?.header?.(corrHeader) || c.req?.header?.('x-request-id');
            if (correlationId && c.header) {
                c.header('X-Correlation-Id', correlationId);
            }

            // Extract input
            let inputData: any = {};
            if (options.input) {
                inputData = await options.input(c);
            } else if (c.req) {
                if (typeof c.req.json === 'function' && c.req.header('content-type')?.includes('application/json')) {
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
                namespace = c.req.header('x-namespace');
            }

            // Extract abort signal
            const abortSignal = c.req?.raw?.signal;

            const execOptions: ExecutionOptions = {
                signal: abortSignal,
                timeout: options.timeout,
                namespace,
            };

            const rawResult: any = await workflow.run(inputData, execOptions);

            const stackId = typeof rawResult?.$stackId === 'function'
                ? rawResult.$stackId()
                : (rawResult?.stackId || rawResult?.$stackId);
            if (stackId && c.header) {
                c.header('X-Workflow-Stack-Id', stackId);
            }

            const cleanResult = unwrapContext(rawResult);

            if (options.output) {
                return await options.output(cleanResult, c);
            }

            if (c.json) {
                return c.json(cleanResult);
            }

            if (next) {
                await next();
            }
            return cleanResult;
        } catch (err: any) {
            if (options.onError) {
                return await options.onError(err, c);
            }
            if (c.json) {
                const status = getErrorStatusCode(err);
                const exposeDetails = options.exposeErrorDetails ?? (process.env.NODE_ENV !== 'production');
                let errorMessage = err.message || 'Workflow execution error';
                if (status === 500 && !exposeDetails) {
                    errorMessage = 'Internal workflow execution error';
                }
                return c.json({ error: errorMessage }, status);
            }
            throw err;
        }
    };
}


export type RivuletHonoMiddlewareOptions<TReq = any, TInput = any, TOutput = any> = SigloHonoMiddlewareOptions<TReq, TInput, TOutput>;
export const rivuletMiddleware = sigloMiddleware;
