import { FlowTimeoutException, WorkflowSuspendedException } from '../../exceptions';
import { STEP_ID, ATTEMPT, RETRY_DELAY, STACK_ID, STACK_ID_KEY } from '../../../../shared';
import { emitMonitoringEvent } from '../../../events';

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

const RETRY_MAP = Symbol.for('siglo.retry-map');

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
        options?: any,
    ) {
        error = Object.assign(error || {}, { func: chain.func });
        logError('SingleChain', error);
        logInfo('SingleChain', {
            chain: chains,
            message: 'Failed to complete',
            params: initialParam,
        });
        const outerSignal = options?.outerSignal || options?.signal;

        const resolvedStackId =
            options?.stackId ||
            singleChain?.stackId ||
            (typeof initialParam?.$stackId === 'function' ? initialParam.$stackId() : initialParam?.$stackId) ||
            // prettier-ignore
            (initialParam && typeof initialParam[STACK_ID] === 'function' ? initialParam[STACK_ID]() : initialParam?.[STACK_ID]) ||
            initialParam?.[STACK_ID_KEY] ||
            '';
        const stepId = (chains && chains.$stepId) || chain.$stepId || chain.name || '';
        const stepName = chain.func || chain.name || 'chain';

        let currentAttemptNumber = 1;
        const rawReject = reject;
        const emitStepError = (err: any) => {
            emitMonitoringEvent(options, {
                type: 'step:error',
                stackId: resolvedStackId,
                stepId,
                stepName,
                attempt: currentAttemptNumber,
                error: {
                    message: err?.message || String(err),
                    code: err?.code,
                    stack: err?.stack,
                },
                timestamp: Date.now(),
                namespace: options?.namespace,
            });
        };
        const safeRejectWithEvent = (err: any) => {
            emitStepError(err);
            rawReject(err);
        };
        reject = safeRejectWithEvent;

        if (error instanceof WorkflowSuspendedException || error?.name === 'WorkflowSuspendedException') {
            rawReject(error);
            return;
        }

        if (outerSignal?.aborted) {
            reject(outerSignal.reason || new Error('This operation was aborted'));
            return;
        }

        if (error instanceof FlowTimeoutException || error?.name === 'FlowTimeoutException') {
            reject(error);
            return;
        }

        if (error?.name === 'CancellationException' || error?.name === 'AbortError') {
            reject(error);
            return;
        }

        if (error && typeof error === 'object' && error.retryable === false) {
            reject(error);
            return;
        }

        if (chain.onfail) {
            if (typeof chain.onfail === 'function') {
                const retryFn = (fallback?: any) => {
                    if (fallback !== undefined) {
                        resolve(fallback);
                        return;
                    }
                    /* c8 ignore next 4 */
                    if (outerSignal?.aborted) {
                        reject(outerSignal.reason || new Error('This operation was aborted'));
                        return;
                    }
                    singleChain
                        .start(initialParam, chains, options)
                        .then((result: any) => {
                            resolve(result);
                        })
                        .catch((err: any) => {
                            reject(err);
                        });
                };

                const rejectFn = (customError?: any) => {
                    reject(customError || error);
                };

                try {
                    const callbackRes = chain.onfail(error, retryFn, rejectFn);
                    if (callbackRes !== undefined) {
                        if (callbackRes instanceof Promise) {
                            callbackRes
                                .then((res: any) => {
                                    if (res !== undefined) resolve(res);
                                })
                                .catch((cbErr: any) => reject(cbErr));
                        } else {
                            resolve(callbackRes);
                        }
                    }
                } catch (cbErr) {
                    reject(cbErr);
                }
            } else if (typeof chain.onfail === 'object') {
                const config: RetryConfig = chain.onfail;
                const maxRetries =
                    config.maxRetries !== undefined
                        ? config.maxRetries
                        : (config as any).maxAttempts !== undefined
                          ? (config as any).maxAttempts
                          : 3;
                const baseDelay = config.delay !== undefined ? config.delay : 100;
                const maxDelay = config.maxDelay !== undefined ? config.maxDelay : 10000;
                const backoff = config.backoff || 'fixed';

                if (initialParam && typeof initialParam === 'object') {
                    if (!initialParam[RETRY_MAP]) {
                        initialParam[RETRY_MAP] = {};
                    }
                }
                const stepKey =
                    chains && typeof chains === 'object' && chains[STEP_ID]
                        ? chains[STEP_ID]
                        : chain.func || chain.name || (typeof chains === 'string' ? chains : 'chain');
                const retryMap = initialParam && typeof initialParam === 'object' ? initialParam[RETRY_MAP] : {};
                const currentAttempt = (retryMap[stepKey] || 0) + 1;
                retryMap[stepKey] = currentAttempt;
                currentAttemptNumber = currentAttempt;

                if (config.retryIf && !config.retryIf(error, currentAttempt)) {
                    reject(error);
                    return;
                }

                if (currentAttempt <= maxRetries) {
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
                    if (typeof config.jitter === 'function') {
                        delayMs = config.jitter(delayMs);
                    } else if (config.jitter) {
                        const rand = typeof config.randomFn === 'function' ? config.randomFn() : Math.random();
                        delayMs = Math.floor(rand * delayMs);
                    }
                    delayMs = Math.max(0, delayMs);

                    if (config.onRetry) {
                        config.onRetry(error, currentAttempt, delayMs);
                    }

                    emitMonitoringEvent(options, {
                        type: 'step:retry',
                        stackId: resolvedStackId,
                        stepId,
                        stepName,
                        attempt: currentAttempt,
                        maxAttempts: maxRetries,
                        error: {
                            message: error?.message || String(error),
                            code: error?.code,
                            stack: error?.stack,
                        },
                        delayMs,
                        timestamp: Date.now(),
                        namespace: options?.namespace,
                    });

                    if (initialParam && typeof initialParam === 'object') {
                        const attFn = () => currentAttempt;
                        (attFn as any).val = currentAttempt;
                        initialParam[ATTEMPT] = attFn;

                        const delFn = () => delayMs;
                        (delFn as any).val = delayMs;
                        initialParam[RETRY_DELAY] = delFn;
                    }

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
                        singleChain
                            .start(initialParam, chains, options)
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
