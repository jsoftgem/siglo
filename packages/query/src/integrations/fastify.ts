import { graphql, Kind, parse, type GraphQLSchema } from 'graphql';
import { getErrorMessage, isPlainObject } from '@siglo/core';
import type { WorkflowQueryEngine } from '../engine';
import { createWorkflowGraphQLSchema } from '../graphql/schema';
import type { WorkflowGraphQLContext } from '../graphql/resolvers';
import { createWorkflowSSEStream, type NodeServerResponseLike, pipeWorkflowSSEToResponse } from '../graphql/transport';

export interface QueryFastifyRequestLike {
    query?: Record<string, unknown>;
    body?: unknown;
    headers?: Record<string, string | string[] | undefined>;
}

export interface QueryFastifyReplyLike {
    raw: NodeServerResponseLike;
    status(code: number): QueryFastifyReplyLike;
    type(contentType: string): QueryFastifyReplyLike;
    send(payload: unknown): unknown;
}

export interface QueryFastifyInstanceLike {
    get(path: string, handler: (request: QueryFastifyRequestLike, reply: QueryFastifyReplyLike) => unknown): unknown;
    post(path: string, handler: (request: QueryFastifyRequestLike, reply: QueryFastifyReplyLike) => unknown): unknown;
}

export interface FastifyQueryOptions {
    engine: WorkflowQueryEngine;
    schema?: GraphQLSchema;
    path?: string;
    namespace?: string | ((req: QueryFastifyRequestLike) => Promise<string | undefined> | string | undefined);
    context?: (
        req: QueryFastifyRequestLike,
        reply: QueryFastifyReplyLike,
    ) => Promise<WorkflowGraphQLContext> | WorkflowGraphQLContext;
    keepAliveIntervalMs?: number;
    allowHeaderNamespace?: boolean;
}

function parseMaybeObjectJson(val: unknown): Record<string, unknown> | undefined {
    if (typeof val === 'string') {
        try {
            const parsed: unknown = JSON.parse(val);
            return isPlainObject(parsed) ? parsed : undefined;
        } catch {
            return undefined;
        }
    }
    return isPlainObject(val) ? val : undefined;
}

function isSubscriptionOperation(query: string, operationName?: string): boolean {
    try {
        const doc = parse(query);
        for (const def of doc.definitions) {
            if (def.kind === Kind.OPERATION_DEFINITION && def.operation === 'subscription') {
                if (!operationName || def.name?.value === operationName) {
                    return true;
                }
            }
        }
    } catch {
        // syntax error handled by executor/stream
    }
    return false;
}

/**
 * Fastify plugin mounting the Siglo GraphQL query, mutation, and SSE subscription endpoint.
 */
export function fastifyQueryPlugin(
    fastify: QueryFastifyInstanceLike,
    options: FastifyQueryOptions,
    done: (err?: Error) => void,
): void {
    const { engine } = options;
    const schema = options.schema ?? createWorkflowGraphQLSchema(engine);
    const routePath = options.path ?? '/graphql';

    const handler = async (request: QueryFastifyRequestLike, reply: QueryFastifyReplyLike) => {
        try {
            const querySource = isPlainObject(request.query) ? request.query : {};
            const bodySource = isPlainObject(request.body) ? request.body : {};

            const rawQuery = bodySource.query ?? querySource.query;
            const query = typeof rawQuery === 'string' && rawQuery.length > 0 ? rawQuery : undefined;
            const variables = parseMaybeObjectJson(bodySource.variables ?? querySource.variables);
            const rawOp = bodySource.operationName ?? querySource.operationName;
            const operationName = typeof rawOp === 'string' && rawOp.length > 0 ? rawOp : undefined;

            if (!query) {
                return reply
                    .status(400)
                    .type('application/json; charset=utf-8')
                    .send({
                        errors: [{ message: 'GraphQL query is required' }],
                    });
            }

            let authenticatedNamespace: string | undefined;
            if (typeof options.namespace === 'function') {
                authenticatedNamespace = await options.namespace(request);
            } else if (typeof options.namespace === 'string') {
                authenticatedNamespace = options.namespace;
            } else if (options.allowHeaderNamespace && request.headers?.['x-namespace']) {
                const nsHeader = request.headers['x-namespace'];
                authenticatedNamespace = typeof nsHeader === 'string' ? nsHeader : undefined;
            }

            const userContext = options.context ? await options.context(request, reply) : {};
            const contextValue: WorkflowGraphQLContext = {
                ...userContext,
                namespace: userContext.namespace ?? authenticatedNamespace,
                engine,
                subscriptionManager: engine.getSubscriptionManager(),
            };

            const acceptHeader = request.headers?.accept;
            const accept = typeof acceptHeader === 'string' ? acceptHeader : '';
            const wantsSSE = accept.includes('text/event-stream') || isSubscriptionOperation(query, operationName);

            if (wantsSSE) {
                const stream = createWorkflowSSEStream({
                    schema,
                    query,
                    variables,
                    context: contextValue,
                    operationName,
                    keepAliveIntervalMs: options.keepAliveIntervalMs,
                });
                const rawRes = reply.raw;
                return pipeWorkflowSSEToResponse(rawRes, stream);
            }

            const result = await graphql({
                schema,
                source: query,
                variableValues: variables,
                contextValue,
                operationName,
            });

            const status = result.errors && !result.data ? 400 : 200;
            return reply.status(status).type('application/json; charset=utf-8').send(result);
        } catch (err: unknown) {
            return reply
                .status(500)
                .type('application/json; charset=utf-8')
                .send({
                    errors: [{ message: getErrorMessage(err) || 'Internal error' }],
                });
        }
    };

    fastify.get(routePath, handler);
    fastify.post(routePath, handler);
    done();
}
