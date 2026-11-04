import * as http from 'http';
import { WorkflowEventEmitter, WorkflowExecutionEvent, RedactionOptions } from 'siglo';

export interface StepRunRecord {
    stepId: string;
    stepName: string;
    status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'RETRYING' | 'SUSPENDED' | 'WAITING';
    attempts: number;
    maxAttempts?: number;
    startTime?: number;
    endTime?: number;
    durationMs?: number;
    outputSummary?: any;
    error?: { message: string; code?: string; stack?: string };
}

export interface ContextDiffRecord {
    stepId: string;
    field: string;
    value: any;
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
    ast?: any;
    steps: Record<string, StepRunRecord>;
    context: Record<string, any>;
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
    maskFn?: (key: string, value: any) => any;
}

export interface MonitorServerOptions {
    port?: number;
    host?: string;
    emitter?: WorkflowEventEmitter;
    store?: any;
    redaction?: RedactionOptions;
    namespaceFilter?: string;
    flow?: any;
    workflows?: any;
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
    payload?: any;
    namespace?: string;
    stepId?: string;
    event?: WorkflowExecutionEvent;
}
