export type CompensationHandler = (output: any, input: any, context?: any) => any | Promise<any>;

export interface CompensationOptions {
    maxRetries?: number;
    delay?: number;
    retryIf?: (err: any, attempt: number) => boolean;
}

export interface CompensationRecord {
    stepId: string;
    stepName: string;
    output: any;
    input: any;
    handler?: CompensationHandler;
    handlerName?: string;
    payload?: any;
    options?: CompensationOptions;
    status?: 'pending' | 'completed' | 'failed';
    completedAt?: number;
    error?: any;
}

export interface CompensationDeadLetterQueue {
    send(entry: {
        stackId: string;
        stepName: string;
        handlerName?: string;
        failedCompensation?: any;
        error: string;
        record?: any;
        timestamp: number;
    }): Promise<void> | void;
}

export interface CompensationRunOptions {
    mode?: 'strict' | 'best-effort';
    onFailure?: (failed: { stepName: string; error: any; record: CompensationRecord }, error: any) => Promise<void> | void;
    deadLetterQueue?: CompensationDeadLetterQueue;
    maxRetries?: number;
    delay?: number;
}

export interface CompensationRunResult {
    completed: string[];
    failed: Array<{ stepName: string; error: any }>;
}
