import { requestCancellation, DisconnectRequestLike, DisconnectResponseLike } from './disconnect';
import { Flow, ExecutionOptions, getErrorMessage, getErrorName, isObject } from '@siglo/core';

export interface ExpressLikeRequest extends DisconnectRequestLike {
    body?: unknown;
    query?: Record<string, unknown>;
    headers?: Record<string, string | string[] | undefined>;
    signal?: AbortSignal;
    raw?: { signal?: AbortSignal };
}

export interface ExpressLikeResponse extends DisconnectResponseLike {
    status?: (code: number) => ExpressLikeResponse;
    json?: (body: unknown) => unknown;
    setHeader?: (name: string, value: string) => unknown;
}

export interface SigloExpressOptions<TReq = ExpressLikeRequest, TInput = unknown, TOutput = unknown> {
    input?: (req: TReq) => Promise<TInput> | TInput;
    output?: (result: TOutput, res: ExpressLikeResponse) => Promise<unknown> | unknown;
    timeout?: number;
    durable?: boolean | ((req: TReq) => boolean);
    namespace?: string | ((req: TReq) => string | undefined);
    onError?: (
        err: unknown,
        req: TReq,
        res: ExpressLikeResponse,
        next: (err?: unknown) => void,
    ) => Promise<unknown> | unknown;
    correlationIdHeader?: string;
    allowHeaderNamespace?: boolean;
    /** Whether to allow external clients to activate durable persistence via headers/query (default: false) */
    allowClientDurableToggle?: boolean;
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

    if (name.includes('Suspended') || causeName.includes('Suspended')) {
        return 202;
    }
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
 * Creates an Express middleware handler for executing a rivulet workflow.
 */
export function sigloExpressMiddleware<
    TInput = any,
    TOutput = any,
    TReq extends ExpressLikeRequest = ExpressLikeRequest,
>(workflow: Flow<TInput, TOutput>, options: SigloExpressOptions<TReq, TInput, TOutput> = {}) {
    return async (req: TReq, res: ExpressLikeResponse, next: (err?: unknown) => void): Promise<any> => {
        const cancellation = requestCancellation(req, res, req.signal || req.raw?.signal);
        try {
            // Correlation ID handling
            const corrHeader = (options.correlationIdHeader || 'x-correlation-id').toLowerCase();
            const correlationId =
                normalizeHeader(req.headers?.[corrHeader]) ?? normalizeHeader(req.headers?.['x-request-id']);
            if (correlationId && res.setHeader) {
                res.setHeader('X-Correlation-Id', correlationId);
            }

            let inputData: unknown = {};
            if (options.input) {
                inputData = await options.input(req);
            } else if (req.body !== undefined) {
                inputData = req.body;
            } else if (req.query) {
                inputData = req.query;
            }

            let namespace: string | undefined;
            if (typeof options.namespace === 'function') {
                namespace = options.namespace(req);
            } else if (options.namespace) {
                namespace = options.namespace;
            } else if (options.allowHeaderNamespace) {
                namespace = normalizeHeader(req.headers?.['x-namespace']);
            }

            let durable: boolean | undefined;
            if (typeof options.durable === 'function') {
                durable = options.durable(req);
            } else if (options.durable !== undefined) {
                durable = options.durable;
            } else if (
                options.allowClientDurableToggle &&
                (normalizeHeader(req.headers?.['x-durable']) === 'true' ||
                    req.query?.durable === 'true' ||
                    (isObject(req.body) && req.body.durable === true))
            ) {
                durable = true;
            }

            const abortSignal = cancellation.signal;

            const execOptions: ExecutionOptions = {
                signal: abortSignal,
                timeout: options.timeout,
                namespace,
                durable,
            };

            const rawResult: unknown = await workflow.run(inputData as TInput, execOptions);
            const resultObj = isObject(rawResult) ? rawResult : undefined;

            const stackId =
                typeof resultObj?.$stackId === 'function'
                    ? (resultObj.$stackId as () => unknown)()
                    : resultObj?.stackId || resultObj?.$stackId;
            if (typeof stackId === 'string' && stackId.length > 0 && res.setHeader) {
                res.setHeader('X-Workflow-Stack-Id', stackId);
            }

            const cleanResult = unwrapContext(rawResult);

            if (options.output) {
                return await options.output(cleanResult as TOutput, res);
            }

            if (res.json) {
                if (isObject(cleanResult) && cleanResult.status === 'waiting' && res.status) {
                    res.status(202);
                }
                return res.json(cleanResult);
            }

            return next();
        } catch (err: unknown) {
            if (options.onError) {
                return await options.onError(err, req, res, next);
            }
            if (res.status && res.json) {
                const status = getErrorStatusCode(err);
                const exposeDetails = options.exposeErrorDetails ?? process.env.NODE_ENV !== 'production';
                let errorMessage = getErrorMessage(err) || 'Workflow execution error';
                if (status === 500 && !exposeDetails) {
                    errorMessage = 'Internal workflow execution error';
                }
                const target = res.status(status);
                return target.json ? target.json({ error: errorMessage }) : res.json({ error: errorMessage });
            }
            return next(err);
        } finally {
            cancellation.cleanup();
        }
    };
}

export type RivuletExpressOptions<TReq = ExpressLikeRequest, TInput = unknown, TOutput = unknown> = SigloExpressOptions<
    TReq,
    TInput,
    TOutput
>;
export const rivuletExpressMiddleware = sigloExpressMiddleware;
