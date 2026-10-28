import { Status } from '../../shared';
/* c8 ignore start */
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
/* c8 ignore stop */

export class RivuletError extends Error {
    readonly stepName?: string;
    readonly phase?: string;
    readonly retryable: boolean;
    readonly stackId?: string;
    readonly namespace?: string;
    readonly workflowId?: string;
    readonly stateSnapshot?: Record<string, any>;
    override readonly cause?: unknown;

    constructor(message: string, metadata: ExecutionErrorMetadata = {}) {
        super(message);
        this.name = 'RivuletError';
        this.stepName = metadata.stepName;
        this.phase = metadata.phase;
        this.retryable = metadata.retryable !== undefined ? metadata.retryable : true;
        this.stackId = metadata.stackId;
        this.namespace = metadata.namespace;
        this.workflowId = metadata.workflowId;
        this.stateSnapshot = metadata.stateSnapshot;
        this.cause = metadata.cause;

        // Legacy compatibility: existing tests assert err.stackId or err.error
        (this as any).error = metadata.cause || this;
        if (metadata.stackId) {
            (this as any).stackId = metadata.stackId;
        }

        Object.setPrototypeOf(this, RivuletError.prototype);
    }

    get isTimeout(): boolean {
        return this.name.includes('Timeout');
    }

    get isCancellation(): boolean {
        return this.name.includes('Cancellation') || this.name.includes('Abort');
    }

    toJSON(): Record<string, any> {
        let serializedCause: any = undefined;
        if (this.cause instanceof Error) {
            serializedCause = {
                name: this.cause.name,
                message: this.cause.message,
                stack: this.cause.stack
            };
        } else if (this.cause !== undefined) {
            try {
                serializedCause = JSON.parse(JSON.stringify(this.cause));
            } catch {
                serializedCause = String(this.cause);
            }
        }

        let serializedSnapshot: any = undefined;
        if (this.stateSnapshot) {
            try {
                serializedSnapshot = JSON.parse(JSON.stringify(this.stateSnapshot));
            } catch {
                serializedSnapshot = '[Unserializable stateSnapshot]';
            }
        }

        return {
            name: this.name,
            message: this.message,
            stepName: this.stepName,
            phase: this.phase,
            retryable: this.retryable,
            stackId: this.stackId,
            namespace: this.namespace,
            workflowId: this.workflowId,
            isTimeout: this.isTimeout,
            isCancellation: this.isCancellation,
            cause: serializedCause,
            stateSnapshot: serializedSnapshot,
            stack: this.stack
        };
    }
/* c8 ignore next */
}

export class StepTimeoutException extends RivuletError {
    readonly timeoutMs: number;
    readonly elapsedMs?: number;

    constructor(stepName: string, timeoutMs: number, metadataOrElapsed: ExecutionErrorMetadata | number = {}, elapsedMs?: number) {
        const metadata = typeof metadataOrElapsed === 'number' ? {} : metadataOrElapsed;
        const effElapsed = typeof metadataOrElapsed === 'number' ? metadataOrElapsed : elapsedMs;
        super(`Step '${stepName}' timed out after ${timeoutMs}ms${effElapsed ? ` (elapsed: ${effElapsed}ms)` : ""}.`, {
            ...metadata,
            stepName,
            phase: 'action',
            retryable: true
        });
        this.name = 'StepTimeoutException';
        this.timeoutMs = timeoutMs;
        this.elapsedMs = effElapsed;
        Object.setPrototypeOf(this, StepTimeoutException.prototype);
    }
/* c8 ignore next */
}

export class FlowTimeoutException extends RivuletError {
    override readonly stackId: string;
    readonly timeoutMs: number;
    readonly completedSteps: number;

    constructor(stackId: string, timeoutMs: number, completedSteps: number, metadata: ExecutionErrorMetadata = {}) {
        super(`Flow timed out after ${timeoutMs}ms on stack '${stackId}' (completed steps: ${completedSteps}).`, {
            ...metadata,
            stackId: metadata.stackId || stackId,
            retryable: false
        });
        this.name = 'FlowTimeoutException';
        this.stackId = stackId;
        this.timeoutMs = timeoutMs;
        this.completedSteps = completedSteps;
        Object.setPrototypeOf(this, FlowTimeoutException.prototype);
    }
/* c8 ignore next */
}

export class CancellationException extends RivuletError {
    constructor(message: string = 'This operation was aborted', metadata: ExecutionErrorMetadata = {}) {
        super(message, {
            ...metadata,
            retryable: false
        });
        this.name = 'CancellationException';
        Object.setPrototypeOf(this, CancellationException.prototype);
    }
/* c8 ignore next */
}

export interface ValidationErrorDetail {
    field: string;
    message?: string;
    error?: any;
    [key: string]: any;
}

export class ValidationException extends RivuletError {
    readonly errors: ValidationErrorDetail[];

    constructor(errors: ValidationErrorDetail[], metadata: ExecutionErrorMetadata = {}) {
        const errorDetails = errors.map(e => `${e.field}: ${e.error?.message || e.error || e.message}`).join('; ');
        super(`Validation failed: ${errorDetails}`, {
            ...metadata,
            phase: 'validation',
            retryable: false
        });
        this.name = 'ValidationException';
        this.errors = errors;
        // Backward compatibility
        (this as any).error = errors;
        Object.setPrototypeOf(this, ValidationException.prototype);
    }
/* c8 ignore next */
}

export class StorageAdapterException extends RivuletError {
    readonly operation: string;
    readonly adapterName?: string;

    constructor(operation: string, adapterName?: string, cause?: unknown, metadata: ExecutionErrorMetadata = {}) {
        const msg = `Storage adapter operation '${operation}' failed${adapterName ? ` on '${adapterName}'` : ''}: ${(cause as any)?.message || cause}`;
        super(msg, {
            ...metadata,
            cause,
            phase: 'checkpoint',
            retryable: false
        });
        this.name = 'StorageAdapterException';
        this.operation = operation;
        this.adapterName = adapterName;
        Object.setPrototypeOf(this, StorageAdapterException.prototype);
    }
/* c8 ignore next */
}

export class CheckpointConflictException extends RivuletError {
    readonly currentRevision: number;
    readonly attemptedRevision: number;

    get expectedRevision(): number {
        return this.currentRevision;
    }

    get actualRevision(): number {
        return this.attemptedRevision;
    }

    constructor(stackId: string, currentRevision: number, attemptedRevision: number, metadata: ExecutionErrorMetadata = {}) {
        super(`Checkpoint conflict for stack '${stackId}': revision ${attemptedRevision} is not greater than current revision ${currentRevision}.`, {
            ...metadata,
            stackId,
            phase: 'checkpoint',
            retryable: false
        });
        this.name = 'CheckpointConflictException';
        this.currentRevision = currentRevision;
        this.attemptedRevision = attemptedRevision;
        Object.setPrototypeOf(this, CheckpointConflictException.prototype);
    }
/* c8 ignore next */
}

export class NamespaceMismatchException extends RivuletError {
    readonly expectedNamespace: string;
    readonly actualNamespace?: string;

    constructor(expectedNamespace: string, actualNamespace?: string, metadata: ExecutionErrorMetadata = {}) {
        super(`Namespace mismatch: checkpoint namespace '${actualNamespace}' does not match expected namespace '${expectedNamespace}'.`, {
            ...metadata,
            namespace: actualNamespace,
            phase: 'checkpoint',
            retryable: false
        });
        this.name = 'NamespaceMismatchException';
        this.expectedNamespace = expectedNamespace;
        this.actualNamespace = actualNamespace;
        Object.setPrototypeOf(this, NamespaceMismatchException.prototype);
    }
/* c8 ignore next */
}

export class CheckpointVersionException extends RivuletError {
    readonly version: any;

    constructor(version: any, metadata: ExecutionErrorMetadata = {}) {
        super(`Invalid or unsupported checkpoint version '${version}'.`, {
            ...metadata,
            phase: 'checkpoint',
            retryable: false
        });
        this.name = 'CheckpointVersionException';
        this.version = version;
        Object.setPrototypeOf(this, CheckpointVersionException.prototype);
    }
/* c8 ignore next */
}

export interface CollisionDetail {
    field: string;
    values: any[];
    branchNames: string[];
}

export class FieldCollisionException extends RivuletError {
    readonly collisions: CollisionDetail[];

    constructor(collisions: CollisionDetail[], metadata: ExecutionErrorMetadata = {}) {
        const details = collisions.map(c => `Field '${c.field}' written by branches [${c.branchNames.join(', ')}] with differing values`).join('; ');
        super(`Field collision detected during merge: ${details}`, {
            ...metadata,
            phase: 'action',
            retryable: false
        });
        this.name = 'FieldCollisionException';
        this.collisions = collisions;
        Object.setPrototypeOf(this, FieldCollisionException.prototype);
    }
/* c8 ignore next */
}

export class IdempotencyConflictException extends RivuletError {
    readonly idempotencyKey: string;

    constructor(idempotencyKey: string, metadata: ExecutionErrorMetadata = {}) {
        super(`Execution rejected: Idempotency key '${idempotencyKey}' is already in-progress.`, {
            ...metadata,
            phase: 'action',
            retryable: false
        });
        this.name = 'IdempotencyConflictException';
        this.idempotencyKey = idempotencyKey;
        Object.setPrototypeOf(this, IdempotencyConflictException.prototype);
    }
/* c8 ignore next */
}

export interface CompensationErrorDetail {
    stepName: string;
    error: unknown;
}

export class CompensationException extends RivuletError {
    readonly originalError: unknown;
    readonly compensationErrors: CompensationErrorDetail[];
    readonly completedCompensations: string[];

    constructor(
        message: string,
        details: {
            originalError: unknown;
            compensationErrors: CompensationErrorDetail[];
            completedCompensations: string[];
        },
        metadata: ExecutionErrorMetadata = {}
    ) {
        super(message, {
            ...metadata,
            cause: details.originalError,
            phase: 'action',
            retryable: false
        });
        this.name = 'CompensationException';
        this.originalError = details.originalError;
        this.compensationErrors = details.compensationErrors;
        this.completedCompensations = details.completedCompensations;
        Object.setPrototypeOf(this, CompensationException.prototype);
    }
/* c8 ignore next */
}

export class WorkflowSuspendedException extends RivuletError {
    readonly correlationKey?: string;
    readonly eventName?: string;
    readonly continuationNodeId?: string;
    readonly expiresAt?: number;
    readonly status: typeof Status.WAITING;

    constructor(message: string, details: {
        correlationKey?: string;
        eventName?: string;
        continuationNodeId?: string;
        expiresAt?: number;
    } = {}, metadata: ExecutionErrorMetadata = {}) {
        super(message, {
            ...metadata,
            phase: 'action',
            retryable: false
        });
        this.name = 'WorkflowSuspendedException';
        this.correlationKey = details.correlationKey;
        this.eventName = details.eventName;
        this.continuationNodeId = details.continuationNodeId;
        this.expiresAt = details.expiresAt;
        this.status = Status.WAITING;
        Object.setPrototypeOf(this, WorkflowSuspendedException.prototype);
    }
/* c8 ignore next */
}

export class DuplicateEventException extends RivuletError {
    readonly correlationKey: string;
    readonly eventName?: string;

    constructor(correlationKey: string, eventName?: string, metadata: ExecutionErrorMetadata = {}) {
        super(`Duplicate or invalid event: workflow with correlationKey '${correlationKey}'${eventName ? ` for event '${eventName}'` : ''} is not waiting or has already been resumed.`, {
            ...metadata,
            phase: 'action',
            retryable: false
        });
        this.name = 'DuplicateEventException';
        this.correlationKey = correlationKey;
        this.eventName = eventName;
        Object.setPrototypeOf(this, DuplicateEventException.prototype);
    }
/* c8 ignore next */
}

export class ExpiredWaitException extends RivuletError {
    readonly correlationKey: string;
    readonly eventName?: string;
    readonly expiredAt: number;

    constructor(correlationKey: string, expiredAt: number, eventName?: string, metadata: ExecutionErrorMetadata = {}) {
        super(`Wait expired: event wait for correlationKey '${correlationKey}'${eventName ? ` (event: ${eventName})` : ''} expired at ${new Date(expiredAt).toISOString()}.`, {
            ...metadata,
            phase: 'action',
            retryable: false
        });
        this.name = 'ExpiredWaitException';
        this.correlationKey = correlationKey;
        this.eventName = eventName;
        this.expiredAt = expiredAt;
        Object.setPrototypeOf(this, ExpiredWaitException.prototype);
    }
/* c8 ignore next */
}

export class WorkflowVersionMismatchException extends RivuletError {
    readonly expectedVersion: any;
    readonly actualVersion: any;

    constructor(expectedVersion: any, actualVersion: any, metadata: ExecutionErrorMetadata = {}) {
        super(`Workflow version mismatch: expected version '${expectedVersion}', but checkpoint was created with version '${actualVersion}' and no migration was provided.`, {
            ...metadata,
            phase: 'checkpoint',
            retryable: false
        });
        this.name = 'WorkflowVersionMismatchException';
        this.expectedVersion = expectedVersion;
        this.actualVersion = actualVersion;
        Object.setPrototypeOf(this, WorkflowVersionMismatchException.prototype);
    }
/* c8 ignore next */
}

export class GraphValidationException extends RivuletError {
    readonly errors: string[];

    constructor(errors: string[], metadata: ExecutionErrorMetadata = {}) {
        super(`Workflow graph validation failed: ${errors.join('; ')}`, {
            ...metadata,
            phase: 'validation',
            retryable: false
        });
        this.name = 'GraphValidationException';
        this.errors = errors;
        Object.setPrototypeOf(this, GraphValidationException.prototype);
    }
/* c8 ignore next */
}

export function normalizeError(error: any, metadata: ExecutionErrorMetadata = {}): RivuletError {
    if (error instanceof RivuletError) {
        if (!error.stackId && metadata.stackId) (error as any).stackId = metadata.stackId;
        if (!error.namespace && metadata.namespace) (error as any).namespace = metadata.namespace;
        if (!error.workflowId && metadata.workflowId) (error as any).workflowId = metadata.workflowId;
        if (!error.stepName && metadata.stepName) (error as any).stepName = metadata.stepName;
        if (!error.phase && metadata.phase) (error as any).phase = metadata.phase;
        return error;
    }
    if (error?.name === 'AbortError' || error?.message?.includes('aborted') || error?.message?.includes('cancelled')) {
        return new CancellationException(error?.message || 'This operation was aborted', {
            ...metadata,
            cause: error
        });
    }
    if (Array.isArray(error) && error.length > 0 && error[0] && typeof error[0] === 'object' && ('field' in error[0] || 'error' in error[0])) {
        return new ValidationException(error, metadata);
    }
    const message = error instanceof Error
        ? error.message
        : (typeof error === 'string' ? error : 'Execution failed');
    const rivuletError = new RivuletError(message, {
        ...metadata,
        cause: error instanceof Error ? error : undefined
    });
    // Legacy compatibility: maintain error property
    (rivuletError as any).error = error;
    return rivuletError;
}

