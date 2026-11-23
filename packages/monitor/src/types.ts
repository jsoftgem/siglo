import * as http from 'http';
import { WorkflowEventEmitter, WorkflowExecutionEvent, RedactionOptions, EcosystemInspection, Flow } from '@siglo/core';

export type MonitorFlowLike =
    Flow<any, any> | { id?: string; name?: string; workflowId?: string; resumeSchema?: unknown };

export interface MonitorWorkflowStoreLike {
    addEvent(event: WorkflowExecutionEvent): void;
    getRun(stackId: string): WorkflowRunRecord | undefined;
    listRuns(filter?: { namespace?: string; status?: string }): WorkflowRunRecord[];
    clear(): void;
}

export interface StepRunRecord {
    selectedRoute?: string;
    stepId: string;
    stepName: string;
    status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'RETRYING' | 'SUSPENDED' | 'WAITING';
    attempts: number;
    maxAttempts?: number;
    startTime?: number;
    endTime?: number;
    durationMs?: number;
    waitState?: 'waiting' | 'resumed' | 'expired';
    waitExpiresAt?: number;
    outputSummary?: unknown;
    inspections?: { attempt: number; timestamp: number; data: EcosystemInspection }[];
    error?: { message: string; code?: string; stack?: string };
}

export interface ContextDiffRecord {
    stepId: string;
    field: string;
    value: unknown;
    timestamp: number;
}

export interface WorkflowRunRecord {
    stackId: string;
    flowName?: string;
    version?: string;
    namespace?: string;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SUSPENDED';
    startTime: number;
    endTime?: number;
    durationMs?: number;
    ast?: unknown;
    steps: Record<string, StepRunRecord>;
    context: Record<string, unknown>;
    contextDiffs: ContextDiffRecord[];
    events: WorkflowExecutionEvent[];
    error?: { message: string; stack?: string };
    waitingForEvent?: string;
}

export interface MonitorServerAuthOptions {
    /** General secret token/API key required for all requests if configured */
    apiKey?: string;
    /** Dedicated token or API key required to ingest events via POST /api/events */
    ingestionKey?: string;
    /** Dedicated token or API key required for control plane actions (/resume, /replay) */
    adminKey?: string;
    /** Custom auth validator callback */
    validator?: (token: string, scope: 'read' | 'ingest' | 'control', req: http.IncomingMessage) => boolean;
}

export interface MonitorServerCorsOptions {
    /**
     * Allowed CORS origin(s).
     * Set to false to disable CORS entirely.
     * Can be a string, array of strings, or predicate function.
     */
    origin?: string | string[] | boolean | ((origin: string) => boolean);
    credentials?: boolean;
}

export interface MonitorSecurityOptions {
    /** List of field names to redact in context diffs and telemetry events (e.g. ['password', 'secret', 'token']) */
    redactedKeys?: string[];
    /** Custom masking function for sensitive values */
    maskFn?: (key: string, value: unknown) => unknown;
}

export interface MonitorServerOptions {
    port?: number;
    host?: string;
    emitter?: WorkflowEventEmitter;
    store?: MonitorWorkflowStoreLike;
    redaction?: RedactionOptions;
    namespaceFilter?: string;
    flow?: MonitorFlowLike;
    workflows?: Map<string, MonitorFlowLike>;
    open?: boolean;
    reuseExisting?: boolean;
    /** Authentication settings (or string shorthand for apiKey) */
    auth?: MonitorServerAuthOptions | string;
    /** CORS origin configuration */
    cors?: MonitorServerCorsOptions;
    /** Maximum allowed JSON payload size in bytes (default: 1MB = 1048576) */
    maxPayloadBytes?: number;
    /** Fine-grained security and telemetry redaction settings */
    security?: MonitorSecurityOptions;
    /** Whether to allow interactive workflow resumption and replay via HTTP/WS (default: true) */
    allowRemoteResume?: boolean;
}

export interface MonitorClientOptions {
    url?: string;
    port?: number;
    host?: string;
    batchSize?: number;
    flushIntervalMs?: number;
    redaction?: RedactionOptions;
    namespace?: string;
    /** Bearer token or API key for authenticating with the remote monitor server */
    apiKey?: string;
    authToken?: string;
    /** Custom HTTP headers sent with event batches */
    headers?: Record<string, string>;
    /** Maximum number of events buffered in memory before dropping oldest (default: 1000) */
    maxQueueSize?: number;
}

export interface MonitorClientInstance {
    emitter: WorkflowEventEmitter;
    monitor: (event: WorkflowExecutionEvent) => void;
    sendEvent: (event: WorkflowExecutionEvent) => Promise<void>;
    flush: () => Promise<void>;
    close: () => Promise<void>;
}

export interface MonitorClientMessage {
    action: 'resume' | 'replay' | 'subscribe' | 'ping' | 'event';
    stackId?: string;
    eventName?: string;
    payload?: unknown;
    namespace?: string;
    stepId?: string;
    event?: WorkflowExecutionEvent;
}
