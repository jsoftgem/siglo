export declare class StepTimeoutException extends Error {
    readonly stepName: string;
    readonly timeoutMs: number;
    readonly elapsedMs: number;
    constructor(stepName: string, timeoutMs: number, elapsedMs: number);
}
export declare class FlowTimeoutException extends Error {
    readonly stackId: string;
    readonly timeoutMs: number;
    readonly completedSteps: number;
    constructor(stackId: string, timeoutMs: number, completedSteps: number);
}
//# sourceMappingURL=exceptions.d.ts.map