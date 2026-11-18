import { graphql, Kind, parse, type GraphQLSchema } from 'graphql';
import type { WorkflowQueryEngine } from '../engine';
import { createWorkflowGraphQLSchema } from '../graphql/schema';
import type { WorkflowGraphQLContext } from '../graphql/resolvers';
import { createWorkflowSSEStream, pipeWorkflowSSEToResponse } from '../graphql/transport';

export interface ExpressQueryOptions {
    engine: WorkflowQueryEngine;
    schema?: GraphQLSchema;
    namespace?: string | ((req: any) => Promise<string | undefined> | string | undefined);
    context?: (req: any, res: any) => Promise<WorkflowGraphQLContext> | WorkflowGraphQLContext;
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

    return async (req: any, res: any, next?: (err?: any) => void): Promise<any> => {
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

            const querySource = req.query || {};
            const bodySource = req.body || {};

            const query = (bodySource.query || querySource.query) as string | undefined;
            const variables = parseMaybeJson(bodySource.variables ?? querySource.variables) as
                Record<string, unknown> | undefined;
            const operationName = (bodySource.operationName || querySource.operationName) as string | undefined;

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
                authenticatedNamespace = req.headers['x-namespace'];
            }

            const userContext = options.context ? await options.context(req, res) : {};
            const contextValue: WorkflowGraphQLContext = {
                ...userContext,
                namespace: userContext.namespace ?? authenticatedNamespace,
                engine,
                subscriptionManager: engine.getSubscriptionManager(),
            };

            const accept = req.headers?.accept || '';
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
        } catch (err: any) {
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
            if (typeof res.json === 'function') {
                return res.json({ errors: [{ message: err.message || 'Internal error' }] });
            }
            return res.end?.(JSON.stringify({ errors: [{ message: err.message || 'Internal error' }] }));
        }
    };
}
