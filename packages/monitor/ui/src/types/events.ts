import { WorkflowStatus, StepStatus } from './workflow';

export type SigloEventType =
    | 'branch:selected'
    | 'step:inspection'
    | 'ai:complete'
    | 'notification:dispatched'
    | 'approval:requested'
    | 'flow:start'
    | 'flow:complete'
    | 'flow:error'
    | 'flow:suspended'
    | 'flow:resumed'
    | 'step:start'
    | 'step:complete'
    | 'step:retry'
    | 'step:error'
    | 'step:skipped'
    | 'context:change'
    | 'cache:hit'
    | 'cache:miss'
    | 'checkpoint:save';

export interface MonitoringEvent {
    type: SigloEventType | string;
    stackId?: string;
    flowName?: string;
    stepId?: string;
    stepName?: string;
    namespace?: string;
    status?: WorkflowStatus | StepStatus;
    durationMs?: number;
    attempt?: number;
    error?: string;
    field?: string;
    value?: any;
    waitingForEvent?: string;
    timestamp?: number;
    [key: string]: any;
}
