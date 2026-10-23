export class StepTimeoutException extends Error {
    readonly stepName: string;
    readonly timeoutMs: number;
    readonly elapsedMs: number;

    constructor(stepName: string, timeoutMs: number, elapsedMs: number) {
        super(`Step '${stepName}' timed out after ${timeoutMs}ms (elapsed: ${elapsedMs}ms).`);
        this.name = 'StepTimeoutException';
        this.stepName = stepName;
        this.timeoutMs = timeoutMs;
        this.elapsedMs = elapsedMs;
        Object.setPrototypeOf(this, StepTimeoutException.prototype);
    }
/* c8 ignore next */
}

export class FlowTimeoutException extends Error {
    readonly stackId: string;
    readonly timeoutMs: number;
    readonly completedSteps: number;

    constructor(stackId: string, timeoutMs: number, completedSteps: number) {
        super(`Flow timed out after ${timeoutMs}ms on stack '${stackId}' (completed steps: ${completedSteps}).`);
        this.name = 'FlowTimeoutException';
        this.stackId = stackId;
        this.timeoutMs = timeoutMs;
        this.completedSteps = completedSteps;
        Object.setPrototypeOf(this, FlowTimeoutException.prototype);
    }
/* c8 ignore next */
}
