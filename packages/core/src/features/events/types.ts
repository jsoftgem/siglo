import type { EcosystemInspection } from './inspection';
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
    | 'checkpoint:save'
    | 'notification:dispatched'
    | 'approval:requested'
    | 'ai:complete'
    | 'step:inspection';

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
    resumeReason?: 'event' | 'timer-expired';
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

export interface NotificationDispatchedEvent {
    namespace?: string;
    type: 'notification:dispatched' | 'approval:requested';
    stackId: string;
    stepId: string;
    timestamp: number;
    notificationId: string;
    channel: 'email' | 'slack' | 'discord' | 'sms' | 'push';
    dispatchedAt: number;
    recipientMasked: string;
}

/** Provider-independent AI accounting; prompts and generated content are excluded. */
export interface AiCompleteEvent {
    attempt?: number;
    inspection?: EcosystemInspection;
    type: 'ai:complete';
    stackId: string;
    stepId: string;
    stepName: string;
    timestamp: number;
    namespace?: string;
    aiMetrics: {
        promptTokens: number; completionTokens: number; totalTokens: number;
        estimatedCostUsd?: number; latencyMs: number; modelUsed: string;
        providerUsed: string; repairAttempts: number; fallbackCount: number;
    };
}

export interface StepInspectionEvent {
    type: 'step:inspection'; stackId: string; stepId: string; stepName: string;
    attempt: number; timestamp: number; namespace?: string; inspection: EcosystemInspection;
}

export type WorkflowExecutionEvent =
    | StepInspectionEvent
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
    | CheckpointSaveEvent
    | NotificationDispatchedEvent
    | AiCompleteEvent;

export interface WorkflowExecutionEventMap {
    'step:inspection': StepInspectionEvent;
    'ai:complete': AiCompleteEvent;
    'notification:dispatched': NotificationDispatchedEvent;
    'approval:requested': NotificationDispatchedEvent;
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
