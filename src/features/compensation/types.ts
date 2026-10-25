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
    handler: CompensationHandler;
    options?: CompensationOptions;
    status?: 'pending' | 'completed' | 'failed';
    completedAt?: number;
    error?: any;
}

export interface CompensationRunResult {
    completed: string[];
    failed: Array<{ stepName: string; error: any }>;
}
