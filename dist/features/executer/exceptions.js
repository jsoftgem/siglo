"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FlowTimeoutException = exports.StepTimeoutException = void 0;
class StepTimeoutException extends Error {
    stepName;
    timeoutMs;
    elapsedMs;
    constructor(stepName, timeoutMs, elapsedMs) {
        super(`Step '${stepName}' timed out after ${timeoutMs}ms (elapsed: ${elapsedMs}ms).`);
        this.name = 'StepTimeoutException';
        this.stepName = stepName;
        this.timeoutMs = timeoutMs;
        this.elapsedMs = elapsedMs;
        Object.setPrototypeOf(this, StepTimeoutException.prototype);
    }
}
exports.StepTimeoutException = StepTimeoutException;
class FlowTimeoutException extends Error {
    stackId;
    timeoutMs;
    completedSteps;
    constructor(stackId, timeoutMs, completedSteps) {
        super(`Flow timed out after ${timeoutMs}ms on stack '${stackId}' (completed steps: ${completedSteps}).`);
        this.name = 'FlowTimeoutException';
        this.stackId = stackId;
        this.timeoutMs = timeoutMs;
        this.completedSteps = completedSteps;
        Object.setPrototypeOf(this, FlowTimeoutException.prototype);
    }
}
exports.FlowTimeoutException = FlowTimeoutException;
//# sourceMappingURL=exceptions.js.map