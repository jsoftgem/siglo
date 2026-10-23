export interface ExecutionErrorMetadata {
    stepName?: string;
    phase?: 'validation' | 'before' | 'action' | 'after' | 'checkpoint' | 'retry';
    retryable?: boolean;
    stackId?: string;
    tenantId?: string;
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
    readonly tenantId?: string;
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
export declare class TenantMismatchException extends FluidFuncError {
    readonly expectedTenantId: string;
    readonly actualTenantId?: string;
    constructor(expectedTenantId: string, actualTenantId?: string, metadata?: ExecutionErrorMetadata);
}
export declare class CheckpointVersionException extends FluidFuncError {
    readonly version: any;
    constructor(version: any, metadata?: ExecutionErrorMetadata);
}
export declare function normalizeError(error: any, metadata?: ExecutionErrorMetadata): FluidFuncError;
//# sourceMappingURL=exceptions.d.ts.map