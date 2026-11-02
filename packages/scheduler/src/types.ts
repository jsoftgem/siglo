import { IncomingMessage, ServerResponse } from 'http';

export interface WaitRecord {
    correlationKey: string;
    stackId: string;
    namespace?: string;
    eventName?: string;
    status: 'WAITING' | 'RESUMING' | 'RESUMED' | 'FAILED' | 'EXPIRED';
    expiresAt?: Date | string | number | null;
    continuationStepIndex?: number;
    version?: string;
    data?: any;
    lockedAt?: Date;
    lockedBy?: string;
    resumedAt?: Date;
    resumedBy?: string;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface PollerReport {
    claimed: number;
    resumed: number;
    failed: number;
}

export interface PostgresPollerOptions {
    /** PostgreSQL Client or Pool instance */
    client: {
        query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;
    };
    /** Table name for wait records (default: 'siglo_wait_records') */
    waitRecordsTable?: string;
    /** Poll interval in milliseconds (default: 1000) */
    pollIntervalMs?: number;
    /** Max batch size of due records to claim per poll iteration (default: 50) */
    batchSize?: number;
    /** Unique identifier for this poller instance/worker (default: auto-generated) */
    workerId?: string;
    /** Lock timeout in milliseconds after which abandoned RESUMING records can be reclaimed (default: 60000) */
    lockTimeoutMs?: number;
    /** Resolver function to look up the workflow definition by workflowId or stackId */
    flowLookup?: (workflowId?: string, stackId?: string) => any;
    /** Optional callback invoked when a workflow is successfully resumed */
    onResumed?: (record: WaitRecord, result: any) => void | Promise<void>;
    /** Optional callback invoked when resumption fails */
    onFailed?: (record: WaitRecord, error: any) => void | Promise<void>;
}

export interface MemoryPollerOptions {
    /** Poll interval in milliseconds (default: 1000) */
    pollIntervalMs?: number;
    /** Resolver function to look up the workflow definition by workflowId or stackId */
    flowLookup?: (workflowId?: string, stackId?: string) => any;
    /** Optional callback invoked when a workflow is successfully resumed */
    onResumed?: (record: WaitRecord, result: any) => void | Promise<void>;
    /** Optional callback invoked when resumption fails */
    onFailed?: (record: WaitRecord, error: any) => void | Promise<void>;
}

export interface CloudSchedulerWebhookOptions {
    /** Shared secret token or API key expected in Authorization or X-Siglo-Token header */
    secretToken?: string;
    /** Resolver function to look up workflow definition */
    flowLookup: (workflowId?: string, stackId?: string) => any;
    /** Optional callback invoked upon successful resumption */
    onResumed?: (stackId: string, result: any) => void | Promise<void>;
}

export type WebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
