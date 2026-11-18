import { graphql, Kind, parse, type GraphQLSchema } from 'graphql';
import type { WorkflowQueryEngine } from '../engine';
import { createWorkflowGraphQLSchema } from '../graphql/schema';
import type { WorkflowGraphQLContext } from '../graphql/resolvers';
import { createWorkflowSSEResponse, createWorkflowSSEStream } from '../graphql/transport';

export interface HonoQueryOptions {
    engine: WorkflowQueryEngine;
    schema?: GraphQLSchema;
    namespace?: string | ((c: any) => Promise<string | undefined> | string | undefined);
    context?: (c: any) => Promise<WorkflowGraphQLContext> | WorkflowGraphQLContext;
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
 * Creates a Hono route handler / middleware for executing Siglo GraphQL queries,
 * mutations, and Server-Sent Events (SSE) subscriptions over Web Standard Request/Response.
 */
export function createHonoQueryHandler(options: HonoQueryOptions) {
    const { engine } = options;
    const schema = options.schema ?? createWorkflowGraphQLSchema(engine);

    return async (c: any, next?: () => Promise<void>): Promise<any> => {
        try {
            const method = c.req?.method || 'POST';
            if (method === 'OPTIONS') {
                return new Response(null, {
                    status: 204,
                    headers: { Allow: 'GET, POST, OPTIONS' },
                });
            }

            let query: string | undefined;
            let variables: Record<string, unknown> | undefined;
            let operationName: string | undefined;

            if (method === 'GET') {
                query = c.req.query('query');
                variables = parseMaybeJson(c.req.query('variables')) as Record<string, unknown> | undefined;
                operationName = c.req.query('operationName');
            } else {
                let body: any = {};
                try {
                    body = await c.req.json();
                } catch {
                    body = {};
                }
                query = body.query ?? c.req.query?.('query');
                variables = parseMaybeJson(body.variables ?? c.req.query?.('variables')) as
                    Record<string, unknown> | undefined;
                operationName = body.operationName ?? c.req.query?.('operationName');
            }

            if (!query) {
                if (typeof next === 'function') {
                    return next();
                }
                return c.json({ errors: [{ message: 'GraphQL query is required' }] }, 400);
            }

            let authenticatedNamespace: string | undefined;
            if (typeof options.namespace === 'function') {
                authenticatedNamespace = await options.namespace(c);
            } else if (typeof options.namespace === 'string') {
                authenticatedNamespace = options.namespace;
            } else if (options.allowHeaderNamespace && c.req?.header) {
                authenticatedNamespace = c.req.header('x-namespace');
            }

            const userContext = options.context ? await options.context(c) : {};
            const contextValue: WorkflowGraphQLContext = {
                ...userContext,
                namespace: userContext.namespace ?? authenticatedNamespace,
                engine,
                subscriptionManager: engine.getSubscriptionManager(),
            };

            const accept = c.req?.header?.('accept') || '';
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
                return createWorkflowSSEResponse(stream);
            }

            const result = await graphql({
                schema,
                source: query,
                variableValues: variables,
                contextValue,
                operationName,
            });

            const status = result.errors && !result.data ? 400 : 200;
            return c.json(result, status);
        } catch (err: any) {
            if (typeof next === 'function') {
                return next();
            }
            return c.json({ errors: [{ message: err.message || 'Internal error' }] }, 500);
        }
    };
}

export const honoQueryMiddleware = createHonoQueryHandler;
