import { DynamicDuration, DynamicOption } from '../../shared';

export interface WaitForEventOptions<TContext = any> {
    correlationKey: DynamicOption<string, TContext>;
    timeout?: DynamicDuration<TContext>;
    timeoutMs?: number;
}

export interface WaitForEventResult {
    eventName: string;
    correlationKey: string;
    waited: boolean;
}

export interface WaitTimerResult {
    waitedMs: number;
}

export interface WorkflowSuspensionResult {
    status: 'waiting';
    stackId: string;
    eventName?: string;
    correlationKey?: string;
    expiresAt?: number;
    continuationNodeId?: string;
    continuationStepIndex?: number;
}

export type WaitRecordStatus =
    'waiting' | 'resumed' | 'expired' | 'failed' | 'WAITING' | 'RESUMING' | 'RESUMED' | 'CANCELLED';

export interface WaitingWorkflowRecord {
    stackId: string;
    workflowId?: string;
    correlationKey: string;
    eventName: string;
    status: WaitRecordStatus;
    continuationStepIndex: number;
    stepId: string;
    expiresAt?: number;
    createdAt: number;
    resumedAt?: number;
    version?: string | number;
    namespace?: string;
    resumePayload?: any;
}

export type StateMigrationFn = (oldVersion: any, newVersion: any, state: any) => any;

export function isWorkflowSuspended(value: unknown): value is WorkflowSuspensionResult {
    return value !== null && typeof value === 'object' && (value as WorkflowSuspensionResult).status === 'waiting';
}
