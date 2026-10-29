import { Flow, ExecutionOptions } from 'siglo';

export interface SigloExpressOptions<TReq = any, TInput = any, TOutput = any> {
    input?: (req: TReq) => Promise<TInput> | TInput;
    output?: (result: TOutput, res: any) => Promise<any> | any;
    timeout?: number;
    namespace?: string | ((req: TReq) => string | undefined);
    onError?: (err: any, req: TReq, res: any, next: (err?: any) => void) => Promise<any> | any;
    correlationIdHeader?: string;
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
        const val = typeof obj[key] === 'function' ? obj[key]() : obj[key];
        clean[key] = val;
    }
    return clean;
}

/**
 * Creates an Express middleware handler for executing a rivulet workflow.
 */
export function sigloExpressMiddleware<TInput = any, TOutput = any, TReq = any>(
    workflow: Flow<TInput, TOutput>,
    options: SigloExpressOptions<TReq, TInput, TOutput> = {}
) {
    return async (req: any, res: any, next: (err?: any) => void): Promise<any> => {
        try {
            // Correlation ID handling
            const corrHeader = (options.correlationIdHeader || 'x-correlation-id').toLowerCase();
            const correlationId = req.headers?.[corrHeader] || req.headers?.['x-request-id'];
            if (correlationId && res.setHeader) {
                res.setHeader('X-Correlation-Id', correlationId);
            }

            let inputData: any = {};
            if (options.input) {
                inputData = await options.input(req);
            } else if (req.body) {
                inputData = req.body;
            } else if (req.query) {
                inputData = req.query;
            }

            let namespace: string | undefined;
            if (typeof options.namespace === 'function') {
                namespace = options.namespace(req);
            } else if (options.namespace) {
                namespace = options.namespace;
            } else if (req.headers?.['x-namespace']) {
                namespace = req.headers['x-namespace'];
            }

            const abortSignal = req.signal || req.raw?.signal;

            const execOptions: ExecutionOptions = {
                signal: abortSignal,
                timeout: options.timeout,
                namespace,
            };

            const rawResult: any = await workflow.run(inputData, execOptions);

            const stackId = typeof rawResult?.$stackId === 'function'
                ? rawResult.$stackId()
                : (rawResult?.stackId || rawResult?.$stackId);
            if (stackId && res.setHeader) {
                res.setHeader('X-Workflow-Stack-Id', stackId);
            }

            const cleanResult = unwrapContext(rawResult);

            if (options.output) {
                return await options.output(cleanResult, res);
            }

            if (res.json) {
                return res.json(cleanResult);
            }

            return next();
        } catch (err: any) {
            if (options.onError) {
                return await options.onError(err, req, res, next);
            }
            if (res.status && res.json) {
                const status = getErrorStatusCode(err);
                return res.status(status).json({ error: err.message || 'Workflow execution error' });
            }
            return next(err);
        }
    };
}


export type RivuletExpressOptions<TReq = any, TInput = any, TOutput = any> = SigloExpressOptions<TReq, TInput, TOutput>;
export const rivuletExpressMiddleware = sigloExpressMiddleware;
