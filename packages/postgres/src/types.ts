import type { WaitRecordStatus, WaitingWorkflowRecord } from '@siglo/core';

export interface PostgresQueryResult<T = any> {
    rows: T[];
    rowCount: number | null;
}

export interface PostgresClientInterface {
    query<T = any>(queryText: string, values?: any[]): Promise<PostgresQueryResult<T>>;
}

export interface PostgresStorageAdapterOptions {
    client: PostgresClientInterface;
    checkpointsTable?: string;
    eventsTable?: string;
    waitRecordsTable?: string;
    recordContextChanges?: boolean;
}

export interface PostgresIdempotencyOptions {
    client: PostgresClientInterface;
    tableName?: string;
    defaultTtlMs?: number;
}

export interface PostgresWaitRecordInput {
    stackId: string;
    workflowId?: string;
    correlationKey: string;
    namespace?: string;
    eventName?: string;
    status?: WaitRecordStatus | string;
    continuationStepIndex?: number;
    stepId?: string;
    version?: string | number;
    data?: unknown;
    resumePayload?: unknown;
    resumedBy?: string;
    resumedAt?: number | string;
    expiresAt?: number;
    createdAt?: number;
}

export interface PostgresWaitRecord extends WaitingWorkflowRecord {
    data?: unknown;
    resumedBy?: string;
}
