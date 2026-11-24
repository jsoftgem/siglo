import { graphql, Kind, parse, type GraphQLSchema } from 'graphql';
import { getErrorMessage, isPlainObject } from '@siglo/core';
import type { WorkflowQueryEngine } from '../engine';
import { createWorkflowGraphQLSchema } from '../graphql/schema';
import type { WorkflowGraphQLContext } from '../graphql/resolvers';
import { createWorkflowSSEStream, type NodeServerResponseLike, pipeWorkflowSSEToResponse } from '../graphql/transport';

export interface QueryExpressRequestLike {
    method?: string;
    query?: Record<string, unknown>;
    body?: unknown;
    headers?: Record<string, string | string[] | undefined>;
}

export interface QueryExpressResponseLike extends NodeServerResponseLike {
    statusCode?: number;
    status?(code: number): unknown;
    json?(body: unknown): unknown;
    end(chunk?: string): void;
}

export interface ExpressQueryOptions {
    engine: WorkflowQueryEngine;
    schema?: GraphQLSchema;
    namespace?: string | ((req: QueryExpressRequestLike) => Promise<string | undefined> | string | undefined);
    context?: (
        req: QueryExpressRequestLike,
        res: QueryExpressResponseLike,
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
        // syntax errors handled by executor/stream
    }
    return false;
}

/**
 * Creates an Express middleware for executing Siglo GraphQL queries, mutations,
 * and Server-Sent Events (SSE) subscriptions.
 */
export function createExpressQueryMiddleware(options: ExpressQueryOptions) {
    const { engine } = options;
    const schema = options.schema ?? createWorkflowGraphQLSchema(engine);

    return async (
        req: QueryExpressRequestLike,
        res: QueryExpressResponseLike,
        next?: (err?: unknown) => void,
    ): Promise<unknown> => {
        try {
            if (req.method === 'OPTIONS') {
                if (typeof res.status === 'function') {
                    res.status(204);
                } else {
                    res.statusCode = 204;
                }
                if (typeof res.setHeader === 'function') {
                    res.setHeader('Allow', 'GET, POST, OPTIONS');
                }
                return res.end?.();
            }

            const querySource = isPlainObject(req.query) ? req.query : {};
            const bodySource = isPlainObject(req.body) ? req.body : {};

            const rawQuery = bodySource.query ?? querySource.query;
            const query = typeof rawQuery === 'string' && rawQuery.length > 0 ? rawQuery : undefined;
            const variables = parseMaybeObjectJson(bodySource.variables ?? querySource.variables);
            const rawOp = bodySource.operationName ?? querySource.operationName;
            const operationName = typeof rawOp === 'string' && rawOp.length > 0 ? rawOp : undefined;

            if (!query) {
                if (typeof next === 'function') {
                    return next();
                }
                if (typeof res.status === 'function') {
                    res.status(400);
                } else {
                    res.statusCode = 400;
                }
                if (typeof res.setHeader === 'function') {
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                }
                if (typeof res.json === 'function') {
                    return res.json({ errors: [{ message: 'GraphQL query is required' }] });
                }
                return res.end?.(JSON.stringify({ errors: [{ message: 'GraphQL query is required' }] }));
            }

            let authenticatedNamespace: string | undefined;
            if (typeof options.namespace === 'function') {
                authenticatedNamespace = await options.namespace(req);
            } else if (typeof options.namespace === 'string') {
                authenticatedNamespace = options.namespace;
            } else if (options.allowHeaderNamespace && req.headers?.['x-namespace']) {
                const nsHeader = req.headers['x-namespace'];
                authenticatedNamespace = typeof nsHeader === 'string' ? nsHeader : undefined;
            }

            const userContext = options.context ? await options.context(req, res) : {};
            const contextValue: WorkflowGraphQLContext = {
                ...userContext,
                namespace: userContext.namespace ?? authenticatedNamespace,
                engine,
                subscriptionManager: engine.getSubscriptionManager(),
            };

            const acceptHeader = req.headers?.accept;
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
                return pipeWorkflowSSEToResponse(res, stream);
            }

            const result = await graphql({
                schema,
                source: query,
                variableValues: variables,
                contextValue,
                operationName,
            });

            const status = result.errors && !result.data ? 400 : 200;
            if (typeof res.status === 'function') {
                res.status(status);
            } else {
                res.statusCode = status;
            }
            if (typeof res.setHeader === 'function') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
            }

            if (typeof res.json === 'function') {
                return res.json(result);
            }
            return res.end(JSON.stringify(result));
        } catch (err: unknown) {
            if (typeof next === 'function') {
                return next(err);
            }
            if (typeof res.status === 'function') {
                res.status(500);
            } else {
                res.statusCode = 500;
            }
            if (typeof res.setHeader === 'function') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
            }
            const errMessage = getErrorMessage(err) || 'Internal error';
            if (typeof res.json === 'function') {
                return res.json({ errors: [{ message: errMessage }] });
            }
            return res.end?.(JSON.stringify({ errors: [{ message: errMessage }] }));
        }
    };
}
