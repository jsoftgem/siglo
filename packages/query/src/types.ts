import type { Flow, SerializedExecutionStack, StorageAdapter, WorkflowEventEmitter } from '@siglo/core';
import type { WorkflowSubscriptionManager } from './graphql/subscriptions';

export type WorkflowStatus = NonNullable<SerializedExecutionStack['status']>;

export interface StepExecution {
    stepId: string;
    name: string;
    status: string;
    output?: unknown;
    error?: Record<string, unknown>;
}

export interface WaitRecord {
    correlationKey: string;
    eventName?: string;
    expiresAt?: Date;
    lockedBy?: string;
    status?: string;
}

export interface CompensationRecord {
    stepId: string;
    stepName: string;
    status: string;
}

export interface WorkflowFilterInput {
    namespace: string;
    workflowId?: string;
    status?: WorkflowStatus;
    createdAfter?: Date;
    createdBefore?: Date;
    correlationKey?: string;
    metadata?: Record<string, unknown>;
}

export interface WorkflowSortInput {
    field?: 'createdAt' | 'updatedAt' | 'status' | 'revision';
    direction?: 'asc' | 'desc';
}

export interface PaginationInput {
    limit?: number;
    cursor?: string;
}

export interface WorkflowSelection {
    includeContext?: boolean;
    contextPath?: string;
}

export interface WorkflowQuery {
    filter: WorkflowFilterInput;
    sort?: WorkflowSortInput;
    pagination?: PaginationInput;
    select?: WorkflowSelection;
}

export type QueryCheckpoint = Omit<SerializedExecutionStack, 'contexts'> & {
    contexts?: SerializedExecutionStack['contexts'];
    createdAt?: number;
};

export interface QueryableStorageAdapter extends StorageAdapter {
    queryWorkflows?(options: Omit<WorkflowQuery, 'select'> & { includeContext: boolean }): Promise<{
        checkpoints: QueryCheckpoint[];
        totalCount: number;
        hasNextPage: boolean;
        endCursor?: string;
    }>;
}

export interface WorkflowQueryOptions {
    storage: QueryableStorageAdapter | undefined;
    resolveWorkflow?: (checkpoint: QueryCheckpoint) => Flow<any, any> | undefined;
    redactFields?: readonly string[];
    emitter?: WorkflowEventEmitter;
    subscriptionManager?: WorkflowSubscriptionManager;
}

export interface WorkflowGraphQLSchemaOptions {
    subscriptionManager?: WorkflowSubscriptionManager;
    emitter?: WorkflowEventEmitter;
}

export interface WorkflowExecution {
    namespace: string;
    stackId: string;
    workflowId?: string;
    status: WorkflowStatus;
    createdAt: Date;
    updatedAt: Date;
    expiresAt?: Date;
    revision: number;
    metadata?: Record<string, unknown>;
    context?: unknown;
    steps?: StepExecution[];
    waitRecord?: WaitRecord;
    compensations?: CompensationRecord[];
    cursor?: string;
}

export interface PageInfo {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor?: string;
    endCursor?: string;
}

export interface WorkflowEdge {
    cursor: string;
    node: WorkflowExecution;
}

export interface WorkflowConnection {
    edges: WorkflowEdge[];
    pageInfo: PageInfo;
    totalCount: number;
}

export interface WorkflowPage {
    items: WorkflowExecution[];
    edges?: WorkflowEdge[];
    totalCount: number;
    pageInfo: PageInfo;
}
