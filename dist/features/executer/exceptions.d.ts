import { Status } from '../../shared';
export interface ExecutionErrorMetadata {
    stepName?: string;
    phase?: 'validation' | 'before' | 'action' | 'after' | 'checkpoint' | 'retry';
    retryable?: boolean;
    stackId?: string;
    namespace?: string;
    workflowId?: string;
    cause?: unknown;
    stateSnapshot?: Record<string, any>;
    [key: string]: any;
}
export declare class FluidFuncError extends Error {
    readonly stepName?: string;
    readonly phase?: string;
    readonly retryable: boolean;
    readonly stackId?: string;
    readonly namespace?: string;
    readonly workflowId?: string;
    readonly stateSnapshot?: Record<string, any>;
    readonly cause?: unknown;
    constructor(message: string, metadata?: ExecutionErrorMetadata);
    get isTimeout(): boolean;
    get isCancellation(): boolean;
    toJSON(): Record<string, any>;
}
export declare class StepTimeoutException extends FluidFuncError {
    readonly timeoutMs: number;
    readonly elapsedMs?: number;
    constructor(stepName: string, timeoutMs: number, metadataOrElapsed?: ExecutionErrorMetadata | number, elapsedMs?: number);
}
export declare class FlowTimeoutException extends FluidFuncError {
    readonly stackId: string;
    readonly timeoutMs: number;
    readonly completedSteps: number;
    constructor(stackId: string, timeoutMs: number, completedSteps: number, metadata?: ExecutionErrorMetadata);
}
export declare class CancellationException extends FluidFuncError {
    constructor(message?: string, metadata?: ExecutionErrorMetadata);
}
export interface ValidationErrorDetail {
    field: string;
    message?: string;
    error?: any;
    [key: string]: any;
}
export declare class ValidationException extends FluidFuncError {
    readonly errors: ValidationErrorDetail[];
    constructor(errors: ValidationErrorDetail[], metadata?: ExecutionErrorMetadata);
}
export declare class StorageAdapterException extends FluidFuncError {
    readonly operation: string;
    readonly adapterName?: string;
    constructor(operation: string, adapterName?: string, cause?: unknown, metadata?: ExecutionErrorMetadata);
}
export declare class CheckpointConflictException extends FluidFuncError {
    readonly currentRevision: number;
    readonly attemptedRevision: number;
    get expectedRevision(): number;
    get actualRevision(): number;
    constructor(stackId: string, currentRevision: number, attemptedRevision: number, metadata?: ExecutionErrorMetadata);
}
export declare class NamespaceMismatchException extends FluidFuncError {
    readonly expectedNamespace: string;
    readonly actualNamespace?: string;
    constructor(expectedNamespace: string, actualNamespace?: string, metadata?: ExecutionErrorMetadata);
}
export declare class CheckpointVersionException extends FluidFuncError {
    readonly version: any;
    constructor(version: any, metadata?: ExecutionErrorMetadata);
}
export interface CollisionDetail {
    field: string;
    values: any[];
    branchNames: string[];
}
export declare class FieldCollisionException extends FluidFuncError {
    readonly collisions: CollisionDetail[];
    constructor(collisions: CollisionDetail[], metadata?: ExecutionErrorMetadata);
}
export declare class IdempotencyConflictException extends FluidFuncError {
    readonly idempotencyKey: string;
    constructor(idempotencyKey: string, metadata?: ExecutionErrorMetadata);
}
export interface CompensationErrorDetail {
    stepName: string;
    error: unknown;
}
export declare class CompensationException extends FluidFuncError {
    readonly originalError: unknown;
    readonly compensationErrors: CompensationErrorDetail[];
    readonly completedCompensations: string[];
    constructor(message: string, details: {
        originalError: unknown;
        compensationErrors: CompensationErrorDetail[];
        completedCompensations: string[];
    }, metadata?: ExecutionErrorMetadata);
}
export declare class WorkflowSuspendedException extends FluidFuncError {
    readonly correlationKey?: string;
    readonly eventName?: string;
    readonly continuationNodeId?: string;
    readonly expiresAt?: number;
    readonly status: typeof Status.WAITING;
    constructor(message: string, details?: {
        correlationKey?: string;
        eventName?: string;
        continuationNodeId?: string;
        expiresAt?: number;
    }, metadata?: ExecutionErrorMetadata);
}
export declare class DuplicateEventException extends FluidFuncError {
    readonly correlationKey: string;
    readonly eventName?: string;
    constructor(correlationKey: string, eventName?: string, metadata?: ExecutionErrorMetadata);
}
export declare class ExpiredWaitException extends FluidFuncError {
    readonly correlationKey: string;
    readonly eventName?: string;
    readonly expiredAt: number;
    constructor(correlationKey: string, expiredAt: number, eventName?: string, metadata?: ExecutionErrorMetadata);
}
export declare class WorkflowVersionMismatchException extends FluidFuncError {
    readonly expectedVersion: any;
    readonly actualVersion: any;
    constructor(expectedVersion: any, actualVersion: any, metadata?: ExecutionErrorMetadata);
}
export declare class GraphValidationException extends FluidFuncError {
    readonly errors: string[];
    constructor(errors: string[], metadata?: ExecutionErrorMetadata);
}
export declare function normalizeError(error: any, metadata?: ExecutionErrorMetadata): FluidFuncError;
//# sourceMappingURL=exceptions.d.ts.map