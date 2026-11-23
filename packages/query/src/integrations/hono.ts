import { graphql, Kind, parse, type GraphQLSchema } from 'graphql';
import { getErrorMessage, isPlainObject } from '@siglo/core';
import type { WorkflowQueryEngine } from '../engine';
import { createWorkflowGraphQLSchema } from '../graphql/schema';
import type { WorkflowGraphQLContext } from '../graphql/resolvers';
import { createWorkflowSSEResponse, createWorkflowSSEStream } from '../graphql/transport';

export interface QueryHonoContextLike {
    req: {
        method?: string;
        query(name: string): string | undefined;
        header?(name: string): string | undefined;
        json(): Promise<unknown>;
    };
    json(data: unknown, status?: number): Response | Promise<Response>;
}

export interface HonoQueryOptions {
    engine: WorkflowQueryEngine;
    schema?: GraphQLSchema;
    namespace?: string | ((c: QueryHonoContextLike) => Promise<string | undefined> | string | undefined);
    context?: (c: QueryHonoContextLike) => Promise<WorkflowGraphQLContext> | WorkflowGraphQLContext;
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
 * Creates a Hono route handler / middleware for executing Siglo GraphQL queries,
 * mutations, and Server-Sent Events (SSE) subscriptions over Web Standard Request/Response.
 */
export function createHonoQueryHandler(options: HonoQueryOptions) {
    const { engine } = options;
    const schema = options.schema ?? createWorkflowGraphQLSchema(engine);

    return async (c: QueryHonoContextLike, next?: () => Promise<void>): Promise<Response | void> => {
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
                variables = parseMaybeObjectJson(c.req.query('variables'));
                operationName = c.req.query('operationName');
            } else {
                let rawBody: unknown = {};
                try {
                    rawBody = await c.req.json();
                } catch {
                    rawBody = {};
                }
                const body = isPlainObject(rawBody) ? rawBody : {};
                const rawQuery = body.query ?? c.req.query?.('query');
                query = typeof rawQuery === 'string' && rawQuery.length > 0 ? rawQuery : undefined;
                variables = parseMaybeObjectJson(body.variables ?? c.req.query?.('variables'));
                const rawOp = body.operationName ?? c.req.query?.('operationName');
                operationName = typeof rawOp === 'string' && rawOp.length > 0 ? rawOp : undefined;
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
        } catch (err: unknown) {
            if (typeof next === 'function') {
                return next();
            }
            return c.json({ errors: [{ message: getErrorMessage(err) || 'Internal error' }] }, 500);
        }
    };
}

export const honoQueryMiddleware = createHonoQueryHandler;
