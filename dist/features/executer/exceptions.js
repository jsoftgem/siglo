"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckpointVersionException = exports.TenantMismatchException = exports.CheckpointConflictException = exports.StorageAdapterException = exports.ValidationException = exports.CancellationException = exports.FlowTimeoutException = exports.StepTimeoutException = exports.FluidFuncError = void 0;
exports.normalizeError = normalizeError;
/* c8 ignore stop */
class FluidFuncError extends Error {
    stepName;
    phase;
    retryable;
    stackId;
    tenantId;
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
        this.tenantId = metadata.tenantId;
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
            tenantId: this.tenantId,
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
class TenantMismatchException extends FluidFuncError {
    expectedTenantId;
    actualTenantId;
    constructor(expectedTenantId, actualTenantId, metadata = {}) {
        super(`Tenant mismatch: checkpoint tenant '${actualTenantId}' does not match expected tenant '${expectedTenantId}'.`, {
            ...metadata,
            tenantId: actualTenantId,
            phase: 'checkpoint',
            retryable: false
        });
        this.name = 'TenantMismatchException';
        this.expectedTenantId = expectedTenantId;
        this.actualTenantId = actualTenantId;
        Object.setPrototypeOf(this, TenantMismatchException.prototype);
    }
}
exports.TenantMismatchException = TenantMismatchException;
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
function normalizeError(error, metadata = {}) {
    if (error instanceof FluidFuncError) {
        if (!error.stackId && metadata.stackId)
            error.stackId = metadata.stackId;
        if (!error.tenantId && metadata.tenantId)
            error.tenantId = metadata.tenantId;
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