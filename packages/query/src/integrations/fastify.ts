import { graphql, Kind, parse, type GraphQLSchema } from 'graphql';
import type { WorkflowQueryEngine } from '../engine';
import { createWorkflowGraphQLSchema } from '../graphql/schema';
import type { WorkflowGraphQLContext } from '../graphql/resolvers';
import { createWorkflowSSEStream, pipeWorkflowSSEToResponse } from '../graphql/transport';

export interface FastifyQueryOptions {
    engine: WorkflowQueryEngine;
    schema?: GraphQLSchema;
    path?: string;
    namespace?: string | ((req: any) => Promise<string | undefined> | string | undefined);
    context?: (req: any, reply: any) => Promise<WorkflowGraphQLContext> | WorkflowGraphQLContext;
    keepAliveIntervalMs?: number;
    allowHeaderNamespace?: boolean;
}

function parseMaybeJson(val: unknown): unknown {
    if (typeof val === 'string') {
        try {
            return JSON.parse(val);
        } catch {
            return val;
        }
    }
    return val;
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
export function fastifyQueryPlugin(fastify: any, options: FastifyQueryOptions, done: (err?: any) => void) {
    const { engine } = options;
    const schema = options.schema ?? createWorkflowGraphQLSchema(engine);
    const routePath = options.path ?? '/graphql';

    const handler = async (request: any, reply: any) => {
        try {
            const querySource = request.query || {};
            const bodySource = request.body || {};

            const query = (bodySource.query || querySource.query) as string | undefined;
            const variables = parseMaybeJson(bodySource.variables ?? querySource.variables) as
                Record<string, unknown> | undefined;
            const operationName = (bodySource.operationName || querySource.operationName) as string | undefined;

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
                authenticatedNamespace = request.headers['x-namespace'];
            }

            const userContext = options.context ? await options.context(request, reply) : {};
            const contextValue: WorkflowGraphQLContext = {
                ...userContext,
                namespace: userContext.namespace ?? authenticatedNamespace,
                engine,
                subscriptionManager: engine.getSubscriptionManager(),
            };

            const accept = request.headers?.accept || '';
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
        } catch (err: any) {
            return reply
                .status(500)
                .type('application/json; charset=utf-8')
                .send({
                    errors: [{ message: err.message || 'Internal error' }],
                });
        }
    };

    fastify.get(routePath, handler);
    fastify.post(routePath, handler);
    done();
}
