export interface WaitForEventOptions {
    correlationKey: string | ((ctx: any) => string);
    timeout?: number | string;
    timeoutMs?: number;
}

export interface WaitingWorkflowRecord {
    stackId: string;
    workflowId?: string;
    correlationKey: string;
    eventName: string;
    status: 'waiting' | 'resumed' | 'expired' | 'failed';
    continuationStepIndex: number;
    stepId: string;
    expiresAt?: number;
    createdAt: number;
    resumedAt?: number;
    version?: string | number;
}

export type StateMigrationFn = (oldVersion: any, newVersion: any, state: any) => any;
