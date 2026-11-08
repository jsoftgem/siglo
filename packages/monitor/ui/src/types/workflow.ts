import type { EcosystemInspection } from '@siglo/core';
export type WorkflowStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SUSPENDED' | 'SKIPPED';
export type StepStatus =
    'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'WAITING' | 'SUSPENDED' | 'RETRYING' | 'PENDING';

export interface StepRun {
    selectedRoute?: string;
    stepId: string;
    stepName?: string;
    status: StepStatus;
    attempts?: number;
    waitState?: 'waiting' | 'resumed' | 'expired';
    waitExpiresAt?: number;
    outputSummary?: unknown;
    inspections?: { attempt: number; timestamp: number; data: EcosystemInspection }[];
    startTime?: number;
    durationMs?: number;
    error?: string | { message?: string; code?: string; stack?: string } | any;
}

export interface ContextDiff {
    field: string;
    value: any;
    timestamp: number;
}

export interface WorkflowRun {
    stackId: string;
    flowName?: string;
    namespace?: string;
    status: WorkflowStatus;
    startTime: number;
    durationMs?: number;
    waitingForEvent?: string | null;
    steps: Record<string, StepRun>;
    context: Record<string, any>;
    contextDiffs?: ContextDiff[];
    ast?: any;
}
