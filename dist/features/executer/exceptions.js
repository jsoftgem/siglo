"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GraphValidationException = exports.WorkflowVersionMismatchException = exports.ExpiredWaitException = exports.DuplicateEventException = exports.WorkflowSuspendedException = exports.CompensationException = exports.IdempotencyConflictException = exports.FieldCollisionException = exports.CheckpointVersionException = exports.NamespaceMismatchException = exports.CheckpointConflictException = exports.StorageAdapterException = exports.ValidationException = exports.CancellationException = exports.FlowTimeoutException = exports.StepTimeoutException = exports.FluidFuncError = void 0;
exports.normalizeError = normalizeError;
const shared_1 = require("../../shared");
/* c8 ignore stop */
class FluidFuncError extends Error {
    stepName;
    phase;
    retryable;
    stackId;
    namespace;
    workflowId;
    stateSnapshot;
    cause;
    constructor(message, metadata = {}) {
        super(message);
        this.name = 'FluidFuncError';
        this.stepName = metadata.stepName;
        this.phase = metadata.phase;
        this.retryable = metadata.retryable !== undefined ? metadata.retryable : true;
        this.stackId = metadata.stackId;
        this.namespace = metadata.namespace;
        this.workflowId = metadata.workflowId;
        this.stateSnapshot = metadata.stateSnapshot;
        this.cause = metadata.cause;
        // Legacy compatibility: existing tests assert err.stackId or err.error
        this.error = metadata.cause || this;
        if (metadata.stackId) {
            this.stackId = metadata.stackId;
        }
        Object.setPrototypeOf(this, FluidFuncError.prototype);
    }
    get isTimeout() {
        return this.name.includes('Timeout');
    }
    get isCancellation() {
        return this.name.includes('Cancellation') || this.name.includes('Abort');
    }
    toJSON() {
        let serializedCause = undefined;
        if (this.cause instanceof Error) {
            serializedCause = {
                name: this.cause.name,
                message: this.cause.message,
                stack: this.cause.stack
            };
        }
        else if (this.cause !== undefined) {
            try {
                serializedCause = JSON.parse(JSON.stringify(this.cause));
            }
            catch {
                serializedCause = String(this.cause);
            }
        }
        let serializedSnapshot = undefined;
        if (this.stateSnapshot) {
            try {
                serializedSnapshot = JSON.parse(JSON.stringify(this.stateSnapshot));
            }
            catch {
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
}
exports.FluidFuncError = FluidFuncError;
class StepTimeoutException extends FluidFuncError {
    timeoutMs;
    elapsedMs;
    constructor(stepName, timeoutMs, metadataOrElapsed = {}, elapsedMs) {
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
}
exports.StepTimeoutException = StepTimeoutException;
class FlowTimeoutException extends FluidFuncError {
    stackId;
    timeoutMs;
    completedSteps;
    constructor(stackId, timeoutMs, completedSteps, metadata = {}) {
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
}
exports.FlowTimeoutException = FlowTimeoutException;
class CancellationException extends FluidFuncError {
    constructor(message = 'This operation was aborted', metadata = {}) {
        super(message, {
            ...metadata,
            retryable: false
        });
        this.name = 'CancellationException';
        Object.setPrototypeOf(this, CancellationException.prototype);
    }
}
exports.CancellationException = CancellationException;
class ValidationException extends FluidFuncError {
    errors;
    constructor(errors, metadata = {}) {
        const errorDetails = errors.map(e => `${e.field}: ${e.error?.message || e.error || e.message}`).join('; ');
        super(`Validation failed: ${errorDetails}`, {
            ...metadata,
            phase: 'validation',
            retryable: false
        });
        this.name = 'ValidationException';
        this.errors = errors;
        // Backward compatibility
        this.error = errors;
        Object.setPrototypeOf(this, ValidationException.prototype);
    }
}
exports.ValidationException = ValidationException;
class StorageAdapterException extends FluidFuncError {
    operation;
    adapterName;
    constructor(operation, adapterName, cause, metadata = {}) {
        const msg = `Storage adapter operation '${operation}' failed${adapterName ? ` on '${adapterName}'` : ''}: ${cause?.message || cause}`;
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
}
exports.StorageAdapterException = StorageAdapterException;
class CheckpointConflictException extends FluidFuncError {
    currentRevision;
    attemptedRevision;
    get expectedRevision() {
        return this.currentRevision;
    }
    get actualRevision() {
        return this.attemptedRevision;
    }
    constructor(stackId, currentRevision, attemptedRevision, metadata = {}) {
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
}
exports.CheckpointConflictException = CheckpointConflictException;
class NamespaceMismatchException extends FluidFuncError {
    expectedNamespace;
    actualNamespace;
    constructor(expectedNamespace, actualNamespace, metadata = {}) {
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
}
exports.NamespaceMismatchException = NamespaceMismatchException;
class CheckpointVersionException extends FluidFuncError {
    version;
    constructor(version, metadata = {}) {
        super(`Invalid or unsupported checkpoint version '${version}'.`, {
            ...metadata,
            phase: 'checkpoint',
            retryable: false
        });
        this.name = 'CheckpointVersionException';
        this.version = version;
        Object.setPrototypeOf(this, CheckpointVersionException.prototype);
    }
}
exports.CheckpointVersionException = CheckpointVersionException;
class FieldCollisionException extends FluidFuncError {
    collisions;
    constructor(collisions, metadata = {}) {
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
}
exports.FieldCollisionException = FieldCollisionException;
class IdempotencyConflictException extends FluidFuncError {
    idempotencyKey;
    constructor(idempotencyKey, metadata = {}) {
        super(`Execution rejected: Idempotency key '${idempotencyKey}' is already in-progress.`, {
            ...metadata,
            phase: 'action',
            retryable: false
        });
        this.name = 'IdempotencyConflictException';
        this.idempotencyKey = idempotencyKey;
        Object.setPrototypeOf(this, IdempotencyConflictException.prototype);
    }
}
exports.IdempotencyConflictException = IdempotencyConflictException;
class CompensationException extends FluidFuncError {
    originalError;
    compensationErrors;
    completedCompensations;
    constructor(message, details, metadata = {}) {
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
}
exports.CompensationException = CompensationException;
class WorkflowSuspendedException extends FluidFuncError {
    correlationKey;
    eventName;
    continuationNodeId;
    expiresAt;
    status;
    constructor(message, details = {}, metadata = {}) {
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
        this.status = shared_1.Status.WAITING;
        Object.setPrototypeOf(this, WorkflowSuspendedException.prototype);
    }
}
exports.WorkflowSuspendedException = WorkflowSuspendedException;
class DuplicateEventException extends FluidFuncError {
    correlationKey;
    eventName;
    constructor(correlationKey, eventName, metadata = {}) {
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
}
exports.DuplicateEventException = DuplicateEventException;
class ExpiredWaitException extends FluidFuncError {
    correlationKey;
    eventName;
    expiredAt;
    constructor(correlationKey, expiredAt, eventName, metadata = {}) {
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
}
exports.ExpiredWaitException = ExpiredWaitException;
class WorkflowVersionMismatchException extends FluidFuncError {
    expectedVersion;
    actualVersion;
    constructor(expectedVersion, actualVersion, metadata = {}) {
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
}
exports.WorkflowVersionMismatchException = WorkflowVersionMismatchException;
class GraphValidationException extends FluidFuncError {
    errors;
    constructor(errors, metadata = {}) {
        super(`Workflow graph validation failed: ${errors.join('; ')}`, {
            ...metadata,
            phase: 'validation',
            retryable: false
        });
        this.name = 'GraphValidationException';
        this.errors = errors;
        Object.setPrototypeOf(this, GraphValidationException.prototype);
    }
}
exports.GraphValidationException = GraphValidationException;
function normalizeError(error, metadata = {}) {
    if (error instanceof FluidFuncError) {
        if (!error.stackId && metadata.stackId)
            error.stackId = metadata.stackId;
        if (!error.namespace && metadata.namespace)
            error.namespace = metadata.namespace;
        if (!error.workflowId && metadata.workflowId)
            error.workflowId = metadata.workflowId;
        if (!error.stepName && metadata.stepName)
            error.stepName = metadata.stepName;
        if (!error.phase && metadata.phase)
            error.phase = metadata.phase;
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
    const fluidError = new FluidFuncError(message, {
        ...metadata,
        cause: error instanceof Error ? error : undefined
    });
    // Legacy compatibility: maintain error property
    fluidError.error = error;
    return fluidError;
}
//# sourceMappingURL=exceptions.js.map