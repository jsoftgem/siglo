import {
    type ExecutionResult,
    type FormattedExecutionResult,
    type GraphQLSchema,
    parse,
    type Source,
    subscribe,
    validate,
} from 'graphql';
import { queryNamespace, type WorkflowGraphQLContext } from './resolvers';

export interface SSEEvent {
    event?: string;
    data: unknown;
    id?: string;
}

export function formatSSEEvent(event: SSEEvent): string {
    let result = '';
    if (event.id !== undefined) {
        result += `id: ${event.id}\n`;
    }
    if (event.event !== undefined) {
        result += `event: ${event.event}\n`;
    }
    const dataStr = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
    result += `data: ${dataStr}\n\n`;
    return result;
}

export interface WorkflowSSEStreamOptions {
    schema: GraphQLSchema;
    query: string | Source;
    variables?: Record<string, unknown>;
    context?: WorkflowGraphQLContext;
    operationName?: string;
    keepAliveIntervalMs?: number;
}

export async function* createWorkflowSSEStream(options: WorkflowSSEStreamOptions): AsyncIterable<string> {
    const { schema, query, variables, context, operationName, keepAliveIntervalMs } = options;

    let document;
    try {
        document = typeof query === 'string' ? parse(query) : parse(query);
    } catch (err: any) {
        yield formatSSEEvent({
            event: 'error',
            data: { errors: [{ message: err.message || 'Syntax Error' }] },
        });
        yield formatSSEEvent({ event: 'complete', data: null });
        return;
    }

    const validationErrors = validate(schema, document);
    if (validationErrors.length > 0) {
        yield formatSSEEvent({
            event: 'error',
            data: {
                errors: validationErrors.map(e => ({
                    message: e.message,
                    locations: e.locations,
                })),
            },
        });
        yield formatSSEEvent({ event: 'complete', data: null });
        return;
    }

    let subResult;
    try {
        subResult = await subscribe({
            schema,
            document,
            variableValues: variables,
            contextValue: context,
            operationName,
        });
    } catch (err: any) {
        yield formatSSEEvent({
            event: 'error',
            data: { errors: [{ message: err.message || 'Subscription failed' }] },
        });
        yield formatSSEEvent({ event: 'complete', data: null });
        return;
    }

    // Single result returned (e.g. error before stream start)
    if (Symbol.asyncIterator in subResult === false) {
        yield formatSSEEvent({
            event: (subResult as ExecutionResult).errors ? 'error' : 'next',
            data: subResult,
        });
        yield formatSSEEvent({ event: 'complete', data: null });
        return;
    }

    const iterator = subResult as AsyncIterableIterator<ExecutionResult>;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let ready: Promise<IteratorResult<ExecutionResult>> | undefined;
    let wake: (() => void) | undefined;
    let settled = false;
    try {
        for (;;) {
            if (!ready) {
                settled = false;
                ready = iterator.next();
                const notify = () => {
                    settled = true;
                    wake?.();
                };
                ready.then(notify, notify);
            }
            if (!settled && keepAliveIntervalMs && keepAliveIntervalMs > 0) {
                await new Promise<void>(resolve => {
                    wake = resolve;
                    timer = setTimeout(resolve, keepAliveIntervalMs);
                });
                clearTimeout(timer);
                wake = undefined;
                if (!settled) {
                    yield ': keepalive\n\n';
                    continue;
                }
            }
            const result = await ready;
            if (result.done) break;
            ready = undefined;
            yield formatSSEEvent({ event: 'next', data: result.value as FormattedExecutionResult });
        }
        yield formatSSEEvent({ event: 'complete', data: null });
    } finally {
        clearTimeout(timer);
        await iterator.return?.();
    }
}

export function createWorkflowSSEResponse(stream: AsyncIterable<string>, init?: ResponseInit): Response {
    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for await (const chunk of stream) {
                    controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
            } catch (err) {
                controller.error(err);
            }
        },
    });

    const headers = new Headers(init?.headers);
    headers.set('Content-Type', 'text/event-stream; charset=utf-8');
    headers.set('Cache-Control', 'no-cache, no-transform');
    headers.set('Connection', 'keep-alive');

    return new Response(readable, {
        ...init,
        status: init?.status ?? 200,
        headers,
    });
}

export interface NodeServerResponseLike {
    writeHead?(statusCode: number, headers?: Record<string, string>): void;
    setHeader?(name: string, value: string): void;
    write(chunk: string | Uint8Array): boolean;
    end(): void;
    on(event: 'close' | 'finish', listener: () => void): this;
    flushHeaders?(): void;
    flush?(): void;
}

export function pipeWorkflowSSEToResponse(res: NodeServerResponseLike, stream: AsyncIterable<string>): () => void {
    if (res.writeHead) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
        });
    } else if (res.setHeader) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
    }

    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    let closed = false;
    let abortStream: (() => void) | undefined;

    res.on('close', () => {
        closed = true;
        abortStream?.();
    });

    (async () => {
        const iterator = stream[Symbol.asyncIterator]();
        abortStream = () => {
            if (typeof iterator.return === 'function') {
                void iterator.return();
            }
        };

        try {
            while (!closed) {
                const { value, done } = await iterator.next();
                if (done || closed) break;
                res.write(value);
                if (typeof res.flush === 'function') {
                    res.flush();
                }
            }
        } catch {
            // client connection aborted
        } finally {
            if (!closed) {
                res.end();
            }
        }
    })();

    return () => {
        closed = true;
        abortStream?.();
    };
}

export interface WorkflowWSHandlerOptions {
    schema: GraphQLSchema;
    context?: (ctx: any) => Promise<WorkflowGraphQLContext> | WorkflowGraphQLContext;
}

/**
 * Creates a graphql-ws server handler if graphql-ws is available in the environment.
 */
export function createWorkflowWSHandler(options: WorkflowWSHandlerOptions, wsServer?: any) {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { useServer } = require('graphql-ws/use/ws');
        const { schema, context } = options;

        const authenticated = new WeakMap<object, WorkflowGraphQLContext>();
        const serverOptions = {
            schema,
            onConnect: async (ctx: any) => {
                const baseContext = context ? await context(ctx) : {};
                try {
                    queryNamespace(ctx.connectionParams?.namespace, baseContext.namespace);
                } catch {
                    return false;
                }
                authenticated.set(ctx, baseContext);
                return true;
            },
            context: (ctx: object) => authenticated.get(ctx),
        };

        if (wsServer) {
            return useServer(serverOptions, wsServer);
        }

        return (server: any) => useServer(serverOptions, server);
    } catch {
        throw new Error(
            'graphql-ws is required to create a WebSocket handler. Please install graphql-ws as a dependency.',
        );
    }
}
