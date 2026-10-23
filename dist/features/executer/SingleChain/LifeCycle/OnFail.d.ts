export type RetryPredicate = (error: any, attempt: number) => boolean;
export interface RetryConfig {
    maxRetries?: number;
    backoff?: 'fixed' | 'linear' | 'exponential' | ((attempt: number) => number);
    delay?: number;
    maxDelay?: number;
    jitter?: boolean | ((delay: number) => number);
    randomFn?: () => number;
    retryIf?: RetryPredicate;
    onRetry?: (error: any, attempt: number, delayMs?: number) => void;
}
export default class OnFail {
    constructor(chain: any, error: any, resolve: (value: any) => void, reject: (reason?: any) => void, singleChain: any, initialParam: any, chains: any, logInfo: (source: string, message: any) => void, logError: (source: string, error: any) => void, _executeAfter?: any, _Context?: any, options?: any);
}
//# sourceMappingURL=OnFail.d.ts.map