export interface RetryConfig {
    maxRetries?: number;
    backoff?: 'fixed' | 'linear' | 'exponential' | ((attempt: number) => number);
    delay?: number;
    maxDelay?: number;
    jitter?: boolean;
    onRetry?: (error: any, attempt: number) => void;
}

const RETRY_MAP = Symbol.for('fluid-func.retry-map');

export default class OnFail {
    constructor(
        chain: any,
        error: any,
        resolve: (value: any) => void,
        reject: (reason?: any) => void,
        singleChain: any,
        initialParam: any,
        chains: any,
        logInfo: (source: string, message: any) => void,
        logError: (source: string, error: any) => void,
        _executeAfter?: any,
        _Context?: any,
        options?: any
    ) {
        error = Object.assign(error || {}, { func: chain.func });
        logError('SingleChain', error);
        logInfo('SingleChain', {
            chain: chains,
            message: 'Failed to complete',
            params: initialParam
        });
        const outerSignal = options?.outerSignal || options?.signal;
        if (chain.onfail) {
            if (typeof chain.onfail === 'function') {
                chain.onfail(
                    error,
                    () => {
                        /* c8 ignore next 4 */
                        /* c8 ignore next 4 */
                        if (outerSignal?.aborted) {
                            reject(outerSignal.reason || new Error('This operation was aborted'));
                            return;
                        }
                        singleChain.start(initialParam, chains, options)
                            .then((result: any) => {
                                resolve(result);
                            })
                            .catch((err: any) => {
                                reject(err);
                            });
                    },
                    () => {
                        reject(error);
                    }
                );
            } else if (typeof chain.onfail === 'object') {
                const config: RetryConfig = chain.onfail;
                const maxRetries = config.maxRetries !== undefined ? config.maxRetries : 3;
                const baseDelay = config.delay !== undefined ? config.delay : 100;
                const maxDelay = config.maxDelay !== undefined ? config.maxDelay : 10000;
                const backoff = config.backoff || 'fixed';

                if (initialParam && typeof initialParam === 'object') {
                    if (!initialParam[RETRY_MAP]) {
                        initialParam[RETRY_MAP] = {};
                    }
                }
                const stepKey = (chains && typeof chains === 'object' && chains.$chainId)
                    ? chains.$chainId
                    : (chain.func || chain.name || (typeof chains === 'string' ? chains : 'chain'));
                const retryMap = initialParam && typeof initialParam === 'object' ? initialParam[RETRY_MAP] : {};
                const currentAttempt = (retryMap[stepKey] || 0) + 1;
                retryMap[stepKey] = currentAttempt;

                if (currentAttempt <= maxRetries) {
                    if (config.onRetry) {
                        config.onRetry(error, currentAttempt);
                    }
                    let delayMs = baseDelay;
                    if (typeof backoff === 'function') {
                        delayMs = backoff(currentAttempt);
                    } else if (backoff === 'exponential') {
                        delayMs = baseDelay * Math.pow(2, currentAttempt - 1);
                    } else if (backoff === 'linear') {
                        delayMs = baseDelay * currentAttempt;
                    }
                    if (maxDelay !== undefined && delayMs > maxDelay) {
                        delayMs = maxDelay;
                    }
                    if (config.jitter) {
                        delayMs = Math.floor(Math.random() * delayMs);
                    }
                    delayMs = Math.max(0, delayMs);

                    let timerId: any;
                    let abortHandler: (() => void) | undefined;
                    if (outerSignal) {
                        abortHandler = () => {
                            if (timerId !== undefined) {
                                clearTimeout(timerId);
                            }
                            reject(outerSignal.reason || new Error('This operation was aborted'));
                        };
                        /* c8 ignore next 4 */
                        if (outerSignal.aborted) {
                            reject(outerSignal.reason || new Error('This operation was aborted'));
                            return;
                        }
                        outerSignal.addEventListener('abort', abortHandler, { once: true });
                    }

                    const cleanup = () => {
                        /* c8 ignore next 3 */
                        if (abortHandler && outerSignal) {
                            outerSignal.removeEventListener('abort', abortHandler);
                        }
                    };

                    const doRetry = () => {
                        cleanup();
                        /* c8 ignore next 4 */
                        if (outerSignal?.aborted) {
                            reject(outerSignal.reason || new Error('This operation was aborted'));
                            return;
                        }
                        singleChain.start(initialParam, chains, options)
                            .then((result: any) => {
                                resolve(result);
                            })
                            .catch((err: any) => {
                                reject(err);
                            });
                    };

                    if (delayMs === 0) {
                        doRetry();
                    } else {
                        timerId = setTimeout(doRetry, delayMs);
                    }
                } else {
                    reject(error);
                }
            } else {
                reject(error);
            }
        } else {
            reject(error);
        }
    }
/* c8 ignore next */
}
