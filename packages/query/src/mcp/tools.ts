import { graphql, Kind, parse, visit, type GraphQLSchema } from 'graphql';
import type { WorkflowQueryEngine } from '../engine';
import { createWorkflowGraphQLSchema } from '../graphql/schema';
import type { WorkflowExecution, WorkflowStatus } from '../types';

export interface McpTenantScopeOptions {
    /**
     * Bound tenant namespace. When configured, requests are locked to this tenant
     * and conflicting `namespace` arguments are rejected.
     */
    namespace?: string;
    /**
     * Default namespace used when `namespace` is not locked and the caller omits `namespace`.
     * Defaults to `'default'`.
     */
    defaultNamespace?: string;
}

export function resolveMcpNamespace(requested?: string, options?: McpTenantScopeOptions): string {
    const trimmedRequested = typeof requested === 'string' && requested.trim() ? requested.trim() : undefined;
    const boundNamespace =
        typeof options?.namespace === 'string' && options.namespace.trim() ? options.namespace.trim() : undefined;

    if (boundNamespace) {
        if (trimmedRequested && trimmedRequested !== boundNamespace) {
            throw new Error('Workflow namespace does not match the MCP server tenant scope');
        }
        return boundNamespace;
    }

    const fallback =
        typeof options?.defaultNamespace === 'string' && options.defaultNamespace.trim()
            ? options.defaultNamespace.trim()
            : 'default';

    return trimmedRequested ?? fallback;
}

const VALID_STATUSES = new Set(['running', 'waiting', 'completed', 'failed', 'cancelled']);

function parseWorkflowStatus(status?: unknown): WorkflowStatus | undefined {
    if (status === undefined || status === null || status === '') return undefined;
    if (typeof status !== 'string') {
        throw new Error('Invalid workflow status filter');
    }
    const normalized = status.toLowerCase();
    if (!VALID_STATUSES.has(normalized)) {
        throw new Error(`Unsupported workflow status '${status}'`);
    }
    return normalized as WorkflowStatus;
}

function parseIsoDate(value: unknown, fieldName: string): Date | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') {
        throw new Error(`Invalid ISO 8601 timestamp for ${fieldName}`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid ISO 8601 timestamp for ${fieldName}: '${value}'`);
    }
    return date;
}

export function formatWorkflowSummary(item: WorkflowExecution) {
    return {
        stackId: item.stackId,
        workflowId: item.workflowId ?? null,
        namespace: item.namespace,
        status: (item.status ?? 'running').toUpperCase(),
        revision: item.revision,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
        ...(item.expiresAt ? { expiresAt: item.expiresAt.toISOString() } : {}),
        ...(item.metadata ? { metadata: item.metadata } : {}),
        ...(item.waitRecord
            ? {
                  waitRecord: {
                      correlationKey: item.waitRecord.correlationKey,
                      eventName: item.waitRecord.eventName ?? null,
                      expiresAt: item.waitRecord.expiresAt?.toISOString() ?? null,
                      lockedBy: item.waitRecord.lockedBy ?? null,
                      status: item.waitRecord.status ?? null,
                  },
              }
            : {}),
    };
}

export function formatWorkflowDetail(item: WorkflowExecution, includeSteps = true) {
    const errorDiagnostics =
        item.metadata && typeof item.metadata.error === 'object' && item.metadata.error !== null
            ? item.metadata.error
            : undefined;

    return {
        ...formatWorkflowSummary(item),
        context: item.context ?? null,
        ...(errorDiagnostics ? { error: errorDiagnostics } : {}),
        ...(includeSteps ? { steps: item.steps ?? [] } : {}),
        compensations: item.compensations ?? [],
    };
}

function assertGraphQLRedactionGuardrails(query: string, variables?: Record<string, unknown>) {
    const doc = parse(query);

    for (const def of doc.definitions) {
        if (def.kind === Kind.OPERATION_DEFINITION && def.operation === 'subscription') {
            throw new Error('Subscription operations are not supported in execute_workflow_query');
        }
    }

    visit(doc, {
        Field(node) {
            if (node.name.value !== 'context' && node.name.value !== 'output') return;
            for (const arg of node.arguments ?? []) {
                if (arg.name.value !== 'redact') continue;
                if (arg.value.kind === Kind.BOOLEAN && arg.value.value === false) {
                    throw new Error('Unredacted field access (redact: false) is not permitted over MCP');
                }
                if (arg.value.kind === Kind.VARIABLE) {
                    const varName = arg.value.name.value;
                    if (variables && variables[varName] === false) {
                        throw new Error('Unredacted field access (redact: false) is not permitted over MCP');
                    }
                }
            }
        },
    });
}

export const WORKFLOW_MCP_TOOLS = [
    {
        name: 'search_workflows',
        description: 'Search workflow executions by status, workflow type, date range, or metadata.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                workflowId: { type: 'string', description: "e.g. 'order-checkout'" },
                status: {
                    type: 'string',
                    enum: ['RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED'],
                },
                namespace: { type: 'string', description: 'Tenant partition' },
                createdAfter: { type: 'string', description: 'ISO 8601 timestamp' },
                createdBefore: { type: 'string', description: 'ISO 8601 timestamp' },
                metadataFilter: {
                    type: 'object',
                    description: 'Key-value match, e.g. { "orderId": "ord_101" }',
                },
                limit: { type: 'number', default: 10 },
            },
        },
    },
    {
        name: 'inspect_workflow',
        description:
            'Retrieve detailed execution state, step lifecycle history, and focused context for a single workflow.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                stackId: { type: 'string', description: 'The execution stack UUID' },
                namespace: { type: 'string', description: 'Tenant partition' },
                contextPath: {
                    type: 'string',
                    description: "Optional dot-path to extract specific context (e.g. 'payment.status')",
                },
                includeSteps: { type: 'boolean', default: true },
            },
            required: ['stackId'],
        },
    },
    {
        name: 'execute_workflow_query',
        description:
            'Allows the LLM to execute an arbitrary GraphQL query against the Siglo schema for complex filtering or aggregations.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                query: { type: 'string', description: 'Valid GraphQL query string' },
                variables: { type: 'object', description: 'Optional GraphQL variables map' },
                namespace: { type: 'string', description: 'Tenant partition' },
            },
            required: ['query'],
        },
    },
    {
        name: 'resume_workflow',
        description: 'Resume a suspended workflow waiting for an external approval or event.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                correlationKey: { type: 'string', description: 'Correlation key of the wait record' },
                payload: { type: 'object', description: 'Data payload to merge upon resumption' },
                namespace: { type: 'string', description: 'Tenant partition' },
            },
            required: ['correlationKey'],
        },
    },
];

export interface McpToolExecutionContext extends McpTenantScopeOptions {
    engine: WorkflowQueryEngine;
    schema?: GraphQLSchema;
}

export async function executeMcpTool(
    name: string,
    rawArgs: Record<string, unknown> | undefined,
    ctx: McpToolExecutionContext,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const args = rawArgs ?? {};
    const { engine } = ctx;

    try {
        switch (name) {
            case 'search_workflows': {
                const namespace = resolveMcpNamespace(args.namespace as string | undefined, ctx);
                const status = parseWorkflowStatus(args.status);
                const createdAfter = parseIsoDate(args.createdAfter, 'createdAfter');
                const createdBefore = parseIsoDate(args.createdBefore, 'createdBefore');
                const limit = typeof args.limit === 'number' ? args.limit : 10;
                const metadata =
                    args.metadataFilter &&
                    typeof args.metadataFilter === 'object' &&
                    !Array.isArray(args.metadataFilter)
                        ? (args.metadataFilter as Record<string, unknown>)
                        : undefined;

                const page = await engine.findMany({
                    filter: {
                        namespace,
                        workflowId: typeof args.workflowId === 'string' ? args.workflowId : undefined,
                        status,
                        createdAfter,
                        createdBefore,
                        metadata,
                    },
                    pagination: { limit },
                    select: { includeContext: false },
                });

                const payload = {
                    workflows: page.items.map(formatWorkflowSummary),
                    totalCount: page.totalCount,
                    pageInfo: page.pageInfo,
                };

                return {
                    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
                };
            }

            case 'inspect_workflow': {
                const stackId = typeof args.stackId === 'string' ? args.stackId.trim() : '';
                if (!stackId) {
                    throw new Error('stackId is required for inspect_workflow');
                }
                const namespace = resolveMcpNamespace(args.namespace as string | undefined, ctx);
                const contextPath =
                    typeof args.contextPath === 'string' && args.contextPath.trim()
                        ? args.contextPath.trim()
                        : undefined;
                const includeSteps = args.includeSteps !== false;

                const execution = await engine.findById(stackId, {
                    namespace,
                    includeContext: true,
                    contextPath,
                    redact: true,
                });

                if (!execution) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: `Workflow '${stackId}' was not found in namespace '${namespace}'`,
                                }),
                            },
                        ],
                    };
                }

                const detail = formatWorkflowDetail(execution, includeSteps);
                return {
                    content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }],
                };
            }

            case 'execute_workflow_query': {
                const query = typeof args.query === 'string' ? args.query.trim() : '';
                if (!query) {
                    throw new Error('query is required for execute_workflow_query');
                }
                const namespace = resolveMcpNamespace(args.namespace as string | undefined, ctx);
                const variables =
                    args.variables && typeof args.variables === 'object' && !Array.isArray(args.variables)
                        ? (args.variables as Record<string, unknown>)
                        : undefined;

                assertGraphQLRedactionGuardrails(query, variables);

                const schema = ctx.schema ?? createWorkflowGraphQLSchema(engine);
                const result = await graphql({
                    schema,
                    source: query,
                    variableValues: variables,
                    contextValue: {
                        namespace,
                        engine,
                        subscriptionManager: engine.getSubscriptionManager(),
                    },
                });

                const hasFatalError = Boolean(result.errors && result.errors.length > 0 && !result.data);
                return {
                    ...(hasFatalError ? { isError: true } : {}),
                    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                };
            }

            case 'resume_workflow': {
                const correlationKey = typeof args.correlationKey === 'string' ? args.correlationKey.trim() : '';
                if (!correlationKey) {
                    throw new Error('correlationKey is required for resume_workflow');
                }
                const namespace = resolveMcpNamespace(args.namespace as string | undefined, ctx);
                const resumed = await engine.resumeWorkflow(correlationKey, args.payload, namespace);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ resumed, correlationKey, namespace }, null, 2),
                        },
                    ],
                };
            }

            default:
                return {
                    isError: true,
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ error: `Unknown MCP tool: '${name}'` }),
                        },
                    ],
                };
        }
    } catch (err: any) {
        return {
            isError: true,
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({ error: err?.message || 'MCP tool execution failed' }),
                },
            ],
        };
    }
}
