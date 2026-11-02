import { WorkflowNode } from '../graph';

export type WorkflowExecutionEventType =
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

export interface FlowStartEvent {
    type: 'flow:start';
    stackId: string;
    flowName?: string;
    version?: string;
    ast?: WorkflowNode;
    timestamp: number;
    namespace?: string;
}

export interface FlowCompleteEvent {
    type: 'flow:complete';
    stackId: string;
    durationMs: number;
    status: 'COMPLETED' | 'FAILED';
    error?: { message: string; stack?: string; code?: string };
    timestamp: number;
    namespace?: string;
}

export interface FlowErrorEvent {
    type: 'flow:error';
    stackId: string;
    error: { message: string; stack?: string; code?: string };
    timestamp: number;
    namespace?: string;
}

export interface FlowSuspendedEvent {
    type: 'flow:suspended';
    stackId: string;
    stepId?: string;
    waitingForEvent: string;
    timeoutMs?: number;
    expiresAt?: number;
    correlationKey?: string;
    timestamp: number;
    namespace?: string;
}

export interface FlowResumedEvent {
    type: 'flow:resumed';
    stackId: string;
    stepId?: string;
    correlationKey?: string;
    eventName?: string;
    timestamp: number;
    namespace?: string;
}

export interface StepStartEvent {
    type: 'step:start';
    stackId: string;
    stepId: string;
    stepName: string;
    attempt: number;
    maxAttempts?: number;
    timestamp: number;
    namespace?: string;
}

export interface StepCompleteEvent {
    type: 'step:complete';
    stackId: string;
    stepId: string;
    stepName: string;
    durationMs: number;
    outputSummary?: any;
    timestamp: number;
    namespace?: string;
}

export interface StepRetryEvent {
    type: 'step:retry';
    stackId: string;
    stepId: string;
    stepName?: string;
    attempt: number;
    maxAttempts?: number;
    error: { message: string; code?: string; stack?: string };
    delayMs: number;
    timestamp: number;
    namespace?: string;
}

export interface StepErrorEvent {
    type: 'step:error';
    stackId: string;
    stepId: string;
    stepName: string;
    attempt?: number;
    error: { message: string; code?: string; stack?: string };
    timestamp: number;
    namespace?: string;
}

export interface StepSkippedEvent {
    type: 'step:skipped';
    stackId: string;
    stepId: string;
    stepName: string;
    timestamp: number;
    namespace?: string;
}

export interface ContextChangeEventPayload {
    type: 'context:change';
    stackId: string;
    stepId: string;
    field: string;
    value: any;
    timestamp: number;
    namespace?: string;
}

export interface CacheHitEvent {
    type: 'cache:hit';
    stackId?: string;
    stepId: string;
    key: string;
    timestamp: number;
    namespace?: string;
}

export interface CacheMissEvent {
    type: 'cache:miss';
    stackId?: string;
    stepId: string;
    key: string;
    timestamp: number;
    namespace?: string;
}

export interface CheckpointSaveEvent {
    type: 'checkpoint:save';
    stackId: string;
    status?: string;
    timestamp: number;
    namespace?: string;
}

export type WorkflowExecutionEvent =
    | FlowStartEvent
    | FlowCompleteEvent
    | FlowErrorEvent
    | FlowSuspendedEvent
    | FlowResumedEvent
    | StepStartEvent
    | StepCompleteEvent
    | StepRetryEvent
    | StepErrorEvent
    | StepSkippedEvent
    | ContextChangeEventPayload
    | CacheHitEvent
    | CacheMissEvent
    | CheckpointSaveEvent;

export interface WorkflowExecutionEventMap {
    'flow:start': FlowStartEvent;
    'flow:complete': FlowCompleteEvent;
    'flow:error': FlowErrorEvent;
    'flow:suspended': FlowSuspendedEvent;
    'flow:resumed': FlowResumedEvent;
    'step:start': StepStartEvent;
    'step:complete': StepCompleteEvent;
    'step:retry': StepRetryEvent;
    'step:error': StepErrorEvent;
    'step:skipped': StepSkippedEvent;
    'context:change': ContextChangeEventPayload;
    'cache:hit': CacheHitEvent;
    'cache:miss': CacheMissEvent;
    'checkpoint:save': CheckpointSaveEvent;
}
