import { Flow, ExecutionOptions } from '@siglo/core';

export interface SigloFastifyOptions<TReq = any, TInput = any, TOutput = any> {
    input?: (req: TReq) => Promise<TInput> | TInput;
    output?: (result: TOutput, reply: any) => Promise<any> | any;
    timeout?: number;
    namespace?: string | ((req: TReq) => string | undefined);
    onError?: (err: any, reply: any) => Promise<any> | any;
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
 * Creates a Fastify route handler for executing a rivulet workflow.
 */
export function sigloFastifyHandler<TInput = any, TOutput = any, TReq = any>(
    workflow: Flow<TInput, TOutput>,
    options: SigloFastifyOptions<TReq, TInput, TOutput> = {}
) {
    return async (request: any, reply: any): Promise<any> => {
        try {
            // Correlation ID handling
            const corrHeader = (options.correlationIdHeader || 'x-correlation-id').toLowerCase();
            const correlationId = request.headers?.[corrHeader] || request.headers?.['x-request-id'];
            if (correlationId && reply.header) {
                reply.header('X-Correlation-Id', correlationId);
            }

            let inputData: any = {};
            if (options.input) {
                inputData = await options.input(request);
            } else if (request.body) {
                inputData = request.body;
            } else if (request.query) {
                inputData = request.query;
            }

            let namespace: string | undefined;
            if (typeof options.namespace === 'function') {
                namespace = options.namespace(request);
            } else if (options.namespace) {
                namespace = options.namespace;
            } else if (options.allowHeaderNamespace && request.headers?.['x-namespace']) {
                namespace = request.headers['x-namespace'];
            }

            const abortSignal = request.raw?.signal;

            const execOptions: ExecutionOptions = {
                signal: abortSignal,
                timeout: options.timeout,
                namespace,
            };

            const rawResult: any = await workflow.run(inputData, execOptions);

            const stackId = typeof rawResult?.$stackId === 'function'
                ? rawResult.$stackId()
                : (rawResult?.stackId || rawResult?.$stackId);
            if (stackId && reply.header) {
                reply.header('X-Workflow-Stack-Id', stackId);
            }

            const cleanResult = unwrapContext(rawResult);

            if (options.output) {
                return await options.output(cleanResult, reply);
            }

            return cleanResult;
        } catch (err: any) {
            if (options.onError) {
                return await options.onError(err, reply);
            }
            const status = getErrorStatusCode(err);
            const exposeDetails = options.exposeErrorDetails ?? (process.env.NODE_ENV !== 'production');
            let errorMessage = err.message || 'Workflow execution error';
            if (status === 500 && !exposeDetails) {
                errorMessage = 'Internal workflow execution error';
            }
            return reply.status(status).send({ error: errorMessage });
        }
    };
}


export type RivuletFastifyOptions<TReq = any, TInput = any, TOutput = any> = SigloFastifyOptions<TReq, TInput, TOutput>;
export const rivuletFastifyHandler = sigloFastifyHandler;
