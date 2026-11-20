import { DynamicDuration, DynamicOption } from '../../shared';

export interface WaitForEventOptions<TContext = any> {
    correlationKey: DynamicOption<string, TContext>;
    timeout?: DynamicDuration<TContext>;
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
    namespace?: string;
}

export type StateMigrationFn = (oldVersion: any, newVersion: any, state: any) => any;
