import {
    defaultStorageManager,
    resumeWorkflow,
    defaultWorkflowEventEmitter,
    type WorkflowEventEmitter,
} from '@siglo/core';
import { rawCheckpoints, rawOutputs } from './graphql/backing';
import { decodeCursor, encodeCursor, sortOrder } from './cursor';
import { createWorkflowSubscriptionManager, type WorkflowSubscriptionManager } from './graphql/subscriptions';
import type {
    CompensationRecord,
    QueryCheckpoint,
    StepExecution,
    WaitRecord,
    WorkflowEdge,
    WorkflowExecution,
    WorkflowPage,
    WorkflowQuery,
    WorkflowQueryOptions,
    WorkflowSelection,
} from './types';

function requireNamespace(namespace: string | undefined): asserts namespace is string {
    if (typeof namespace !== 'string' || !namespace.trim()) throw new Error('A workflow namespace is required');
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

export class WorkflowQueryEngine {
    private readonly fields: Set<string>;
    private readonly storage: NonNullable<WorkflowQueryOptions['storage']>;
    private readonly subscriptionManager: WorkflowSubscriptionManager;
    private readonly emitter?: WorkflowEventEmitter;

    private readonly resolveWorkflow: WorkflowQueryOptions['resolveWorkflow'];

    constructor(options: WorkflowQueryOptions) {
        if (!options.storage) throw new Error('A workflow storage adapter is required');
        this.resolveWorkflow = options.resolveWorkflow;
        this.storage = options.storage;
        this.fields = new Set(['apiKey', 'password', 'token', 'secret', ...(options.redactFields ?? [])]);
        this.emitter = options.emitter;
        this.subscriptionManager =
            options.subscriptionManager ??
            createWorkflowSubscriptionManager({
                engine: this,
                emitter: options.emitter ?? defaultWorkflowEventEmitter,
            });
    }

    getRedactFields(): ReadonlySet<string> {
        return this.fields;
    }

    getSubscriptionManager(): WorkflowSubscriptionManager {
        return this.subscriptionManager;
    }

    getEmitter(): WorkflowEventEmitter | undefined {
        return this.emitter;
    }

    private project(
        record: QueryCheckpoint,
        namespace: string,
        select: WorkflowSelection,
        redact: boolean,
    ): WorkflowExecution {
        const fields = redact ? this.fields : new Set<string>();
        const wait = record.metadata?.waitRecord as any;
        const waitRecord: WaitRecord | undefined = wait
            ? {
                  correlationKey: wait.correlationKey,
                  eventName: wait.eventName,
                  expiresAt: wait.expiresAt ? new Date(wait.expiresAt) : undefined,
                  lockedBy: wait.lockedBy,
                  status: wait.status,
              }
            : undefined;

        const compensations: CompensationRecord[] = Array.isArray(record.metadata?.compensations)
            ? (record.metadata.compensations as any[]).map(c => ({
                  stepId: String(c.stepId ?? ''),
                  stepName: String(c.stepName ?? c.handlerName ?? c.stepId ?? ''),
                  status: String(c.status ?? 'registered'),
              }))
            : [];

        const hasContextRequested = !!(select.includeContext || select.contextPath !== undefined);
        const rawError =
            record.metadata?.error && typeof record.metadata.error === 'object'
                ? (record.metadata.error as Record<string, unknown>)
                : undefined;
        const failedStepId =
            record.status === 'failed'
                ? ((typeof record.metadata?.failedStep === 'string' ? record.metadata.failedStep : undefined) ??
                  (typeof rawError?.stepName === 'string' ? rawError.stepName : undefined) ??
                  (typeof rawError?.stepId === 'string' ? rawError.stepId : undefined))
                : undefined;

        const chainIds = [...(record.chains ?? [])];
        if (failedStepId && !chainIds.includes(failedStepId)) {
            chainIds.push(failedStepId);
        }

        const steps: StepExecution[] = chainIds.map(id => {
            const stepOutput =
                hasContextRequested && record.contexts && Object.hasOwn(record.contexts, id)
                    ? record.contexts[id]
                    : undefined;
            const isFailedStep = Boolean(record.status === 'failed' && failedStepId && failedStepId === id);
            const step: StepExecution = {
                stepId: id,
                name: id,
                status: isFailedStep ? 'FAILED' : 'COMPLETED',
                output: stepOutput ? (redact ? redactObject(stepOutput, fields) : stepOutput) : undefined,
                ...(isFailedStep && rawError ? { error: redact ? redactObject(rawError, fields) : rawError } : {}),
            };
            if (stepOutput) rawOutputs.set(step, stepOutput);
            return step;
        });

        const result: WorkflowExecution = {
            stackId: record.stackId,
            namespace,
            workflowId: record.workflowId,
            status: record.status ?? 'running',
            revision: record.revision,
            createdAt: new Date(record.createdAt ?? record.timestamp),
            updatedAt: new Date(record.timestamp),
            expiresAt: record.expiresAt === undefined ? undefined : new Date(record.expiresAt),
            metadata: record.metadata && redactObject(record.metadata, fields),
            steps,
            waitRecord,
            compensations,
        };
        rawCheckpoints.set(result, record);

        if (hasContextRequested) {
            const contexts = record.contexts;
            if (!contexts) throw new Error('Storage omitted requested workflow context');
            const merged = Object.fromEntries(
                record.chains.flatMap(id => Object.entries(Object.hasOwn(contexts, id) ? contexts[id] : {})),
            );
            let context: unknown = redactObject(merged, fields);
            for (const key of select.contextPath ? select.contextPath.split('.') : []) {
                if (!context || typeof context !== 'object' || !Object.hasOwn(context, key)) {
                    context = undefined;
                    break;
                }
                context = (context as Record<string, unknown>)[key];
            }
            result.context = context;
        }
        return result;
    }

    async findById(stackId: string, options: WorkflowSelection & { namespace: string; redact?: boolean }) {
        const namespace = options?.namespace;
        requireNamespace(namespace);
        if (!this.storage.getCheckpoint) throw new Error('Storage does not support checkpoint lookup');
        const record = await this.storage.getCheckpoint(stackId);
        if (record?.namespace !== namespace || record.stackId !== stackId) return undefined;
        return this.project(record, namespace, { includeContext: true, ...options }, options.redact ?? true);
    }

    async findMany({ filter, sort, pagination, select = {} }: WorkflowQuery): Promise<WorkflowPage> {
        requireNamespace(filter?.namespace);
        const namespace = filter.namespace;
        const order = sortOrder(sort);
        const limit = pagination?.limit ?? 20;
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid workflow page limit');
        if (pagination?.cursor !== undefined) decodeCursor(pagination.cursor, order);
        if (!this.storage.queryWorkflows) throw new Error('Storage does not support workflow listing');
        const page = await this.storage.queryWorkflows({
            filter,
            sort: order,
            pagination: { ...pagination, limit },
            includeContext: !!select.includeContext || select.contextPath !== undefined,
        });
        const items = page.checkpoints.map(record => {
            if (record.namespace !== namespace)
                throw new Error('Storage returned a workflow outside the requested namespace');
            return this.project(record, namespace, select, true);
        });
        const last = page.checkpoints.at(-1);
        const edges: WorkflowEdge[] = items.map((node, i) => {
            const cursor = encodeCursor(page.checkpoints[i], order);
            node.cursor = cursor;
            return { cursor, node };
        });
        return {
            items,
            edges,
            totalCount: page.totalCount,
            pageInfo: {
                hasNextPage: page.hasNextPage,
                hasPreviousPage: pagination?.cursor !== undefined,
                startCursor: edges.length ? edges[0].cursor : undefined,
                endCursor: last ? encodeCursor(last, order) : undefined,
            },
        };
    }

    async cancelWorkflow(stackId: string, options: { reason?: string; namespace: string }): Promise<boolean> {
        requireNamespace(options?.namespace);
        const existing = await this.storage.getCheckpoint?.(stackId);
        if (!existing || existing.namespace !== options.namespace) return false;
        if (typeof this.storage.cancelWorkflow === 'function') {
            await this.storage.cancelWorkflow(stackId);
            return true;
        }
        if (this.storage.getCheckpoint && this.storage.saveCheckpoint) {
            existing.status = 'cancelled';
            existing.revision = (existing.revision ?? 0) + 1;
            existing.timestamp = Date.now();
            if (existing.metadata?.waitRecord) {
                (existing.metadata.waitRecord as any).status = 'CANCELLED';
            }
            await this.storage.saveCheckpoint(existing);
            return true;
        }
        return false;
    }

    async resumeWorkflow(correlationKey: string, payload?: unknown, namespace?: string): Promise<boolean> {
        requireNamespace(namespace);
        if (!this.resolveWorkflow || defaultStorageManager.getAdapter() !== this.storage) {
            throw new Error('Resume requires a workflow resolver and the active durable storage adapter');
        }
        const wait = await this.storage.getWaitRecord?.(correlationKey);
        if (!wait || wait.correlationKey !== correlationKey || wait.namespace !== namespace) return false;
        const checkpoint = await this.storage.getCheckpoint?.(wait.stackId);
        if (!checkpoint || checkpoint.namespace !== namespace || checkpoint.status !== 'waiting') return false;
        const workflow = this.resolveWorkflow(checkpoint);
        if (!workflow) throw new Error('No runtime workflow definition for this checkpoint');
        await resumeWorkflow(workflow, correlationKey, payload, { namespace });
        return true;
    }
}

export function createWorkflowQueryEngine(options: WorkflowQueryOptions) {
    return new WorkflowQueryEngine(options);
}
