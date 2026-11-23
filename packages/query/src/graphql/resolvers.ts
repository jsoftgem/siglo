import { rawCheckpoints, rawOutputs } from './backing';
import { isPlainObject } from '@siglo/core';
import type { GraphQLResolveInfo } from 'graphql';
import type { WorkflowQueryEngine } from '../engine';
import { getWorkflowSelectionFlags } from './projection';
import type { WorkflowSubscriptionManager } from './subscriptions';
import type {
    StepExecution,
    WorkflowExecution,
    WorkflowFilterInput,
    WorkflowSortInput,
    WorkflowStatus,
} from '../types';

const VALID_WORKFLOW_STATUSES = new Set<WorkflowStatus>(['running', 'completed', 'failed', 'waiting', 'cancelled']);

function parseFilterStatus(status?: string): WorkflowStatus | undefined {
    if (!status) return undefined;
    const normalized = status.toLowerCase();
    if (VALID_WORKFLOW_STATUSES.has(normalized as WorkflowStatus)) return normalized as WorkflowStatus;
    throw new Error(`Invalid workflow status: ${status}`);
}

export interface WorkflowGraphQLContext {
    namespace?: string;
    engine?: WorkflowQueryEngine;
    subscriptionManager?: WorkflowSubscriptionManager;
    [key: string]: unknown;
}

function mapSortField(field?: string): 'createdAt' | 'updatedAt' | 'status' | 'revision' | undefined {
    switch (field) {
        case 'CREATED_AT':
            return 'createdAt';
        case 'UPDATED_AT':
            return 'updatedAt';
        case 'STATUS':
            return 'status';
        case 'REVISION':
            return 'revision';
        default:
            return undefined;
    }
}

function mapSortDirection(dir?: string): 'asc' | 'desc' | undefined {
    if (dir === 'ASC') return 'asc';
    if (dir === 'DESC') return 'desc';
    return undefined;
}

function redactObject(value: Record<string, unknown>, fields: ReadonlySet<string>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, fields.has(key) ? '[REDACTED]' : redactValue(item, fields)]),
    );
}

function redactValue(value: unknown, fields: ReadonlySet<string>): unknown {
    if (Array.isArray(value)) return value.map(item => redactValue(item, fields));
    if (value && typeof value === 'object') return redactObject(value as Record<string, unknown>, fields);
    return value;
}

export function queryNamespace(requested?: string, authenticated?: string): string {
    if (authenticated !== undefined && requested !== undefined && requested !== authenticated) {
        throw new Error('Workflow namespace does not match the request context');
    }
    const namespace = authenticated;
    if (typeof namespace !== 'string' || !namespace.trim()) throw new Error('A workflow namespace is required');
    return namespace;
}

export function createResolvers(
    engine: WorkflowQueryEngine,
    options?: { subscriptionManager?: WorkflowSubscriptionManager },
) {
    return {
        Query: {
            async workflow(
                _parent: unknown,
                args: { stackId: string; namespace?: string },
                context: WorkflowGraphQLContext | undefined,
                info: GraphQLResolveInfo,
            ) {
                const namespace = queryNamespace(args.namespace, context?.namespace);
                const flags = getWorkflowSelectionFlags(info);
                const execution = await engine.findById(args.stackId, {
                    namespace,
                    includeContext: flags.includeContext,
                    contextPath: flags.contextPath,
                    redact: true,
                });
                return execution ?? null;
            },

            async workflows(
                _parent: unknown,
                args: {
                    filter?: {
                        workflowId?: string;
                        namespace?: string;
                        status?: string;
                        createdAfter?: Date;
                        createdBefore?: Date;
                        correlationKey?: string;
                        metadata?: Record<string, unknown>;
                    };
                    sort?: { field?: string; direction?: string };
                    pagination?: { limit?: number; cursor?: string };
                },
                context: WorkflowGraphQLContext | undefined,
                info: GraphQLResolveInfo,
            ) {
                const namespace = queryNamespace(args.filter?.namespace, context?.namespace);
                const flags = getWorkflowSelectionFlags(info);
                const filter: WorkflowFilterInput = {
                    ...args.filter,
                    namespace,
                    status: parseFilterStatus(args.filter?.status),
                };
                const sort: WorkflowSortInput | undefined = args.sort
                    ? {
                          field: mapSortField(args.sort.field),
                          direction: mapSortDirection(args.sort.direction),
                      }
                    : undefined;

                const page = await engine.findMany({
                    filter,
                    sort,
                    pagination: args.pagination,
                    select: {
                        includeContext: flags.includeContext,
                        contextPath: flags.contextPath,
                    },
                });

                return {
                    edges: (page.edges ?? []).map(edge => ({
                        cursor: edge.cursor,
                        node: edge.node,
                    })),
                    pageInfo: page.pageInfo,
                    totalCount: page.totalCount,
                };
            },
        },

        Mutation: {
            async resumeWorkflow(
                _parent: unknown,
                args: { correlationKey: string; payload?: unknown; namespace?: string },
                context: WorkflowGraphQLContext | undefined,
            ) {
                const namespace = queryNamespace(args.namespace, context?.namespace);
                return engine.resumeWorkflow(args.correlationKey, args.payload, namespace);
            },

            async cancelWorkflow(
                _parent: unknown,
                args: { stackId: string; reason?: string },
                context: WorkflowGraphQLContext | undefined,
            ) {
                const namespace = queryNamespace(undefined, context?.namespace);
                return engine.cancelWorkflow(args.stackId, { reason: args.reason, namespace });
            },
        },

        Subscription: {
            workflowUpdated: {
                subscribe(
                    _parent: unknown,
                    args: { stackId: string; namespace?: string },
                    context: WorkflowGraphQLContext | undefined,
                ) {
                    const namespace = queryNamespace(args.namespace, context?.namespace);
                    const manager =
                        context?.subscriptionManager ?? options?.subscriptionManager ?? engine.getSubscriptionManager();
                    return manager.subscribeWorkflowUpdated(args.stackId, namespace);
                },
                resolve(payload: unknown) {
                    return isPlainObject(payload) && 'workflowUpdated' in payload ? payload.workflowUpdated : payload;
                },
            },

            workflowCompleted: {
                subscribe(_parent: unknown, args: { namespace?: string }, context: WorkflowGraphQLContext | undefined) {
                    const namespace = queryNamespace(args.namespace, context?.namespace);
                    const manager =
                        context?.subscriptionManager ?? options?.subscriptionManager ?? engine.getSubscriptionManager();
                    return manager.subscribeWorkflowCompleted(namespace);
                },
                resolve(payload: unknown) {
                    return isPlainObject(payload) && 'workflowCompleted' in payload
                        ? payload.workflowCompleted
                        : payload;
                },
            },
        },

        WorkflowExecution: {
            status(node: WorkflowExecution) {
                return (node.status ?? 'running').toUpperCase();
            },
            context(node: WorkflowExecution, args: { path?: string; redact?: boolean }) {
                const rawRecord = rawCheckpoints.get(node);
                const redact = args.redact !== false;
                const fields = engine.getRedactFields();

                if (rawRecord?.contexts) {
                    const merged = Object.fromEntries(
                        rawRecord.chains.flatMap(id =>
                            Object.entries(Object.hasOwn(rawRecord.contexts!, id) ? rawRecord.contexts![id] : {}),
                        ),
                    );
                    let target: unknown = redact ? redactObject(merged, fields) : merged;
                    if (args.path) {
                        for (const key of args.path.split('.')) {
                            if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) {
                                return null;
                            }
                            target = (target as Record<string, unknown>)[key];
                        }
                    }
                    return target;
                }

                let target = node.context;
                if (args.path && target && typeof target === 'object') {
                    for (const key of args.path.split('.')) {
                        if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) {
                            return null;
                        }
                        target = (target as Record<string, unknown>)[key];
                    }
                }
                return target ?? null;
            },
            steps(node: WorkflowExecution) {
                return node.steps ?? [];
            },
            waitRecord(node: WorkflowExecution) {
                return node.waitRecord ?? null;
            },
            compensations(node: WorkflowExecution) {
                return node.compensations ?? [];
            },
        },

        StepExecution: {
            output(step: StepExecution, args: { redact?: boolean }) {
                if (args.redact === false && rawOutputs.has(step)) {
                    return rawOutputs.get(step);
                }
                return step.output ?? null;
            },
        },
    };
}
