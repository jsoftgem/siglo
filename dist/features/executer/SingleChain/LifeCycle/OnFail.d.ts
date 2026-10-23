export interface RetryConfig {
    maxRetries?: number;
    backoff?: 'fixed' | 'linear' | 'exponential' | ((attempt: number) => number);
    delay?: number;
    maxDelay?: number;
    jitter?: boolean;
    onRetry?: (error: any, attempt: number) => void;
}
export default class OnFail {
    constructor(chain: any, error: any, resolve: (value: any) => void, reject: (reason?: any) => void, singleChain: any, initialParam: any, chains: any, logInfo: (source: string, message: any) => void, logError: (source: string, error: any) => void, _executeAfter?: any, _Context?: any, options?: any);
}
//# sourceMappingURL=OnFail.d.ts.map