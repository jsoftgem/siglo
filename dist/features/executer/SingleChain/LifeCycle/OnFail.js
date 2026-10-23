"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const RETRY_MAP = Symbol.for('fluid-func.retry-map');
class OnFail {
    constructor(chain, error, resolve, reject, singleChain, initialParam, chains, logInfo, logError, _executeAfter, _Context, options) {
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
                chain.onfail(error, () => {
                    /* c8 ignore next 4 */
                    /* c8 ignore next 4 */
                    if (outerSignal?.aborted) {
                        reject(outerSignal.reason || new Error('This operation was aborted'));
                        return;
                    }
                    singleChain.start(initialParam, chains, options)
                        .then((result) => {
                        resolve(result);
                    })
                        .catch((err) => {
                        reject(err);
                    });
                }, () => {
                    reject(error);
                });
            }
            else if (typeof chain.onfail === 'object') {
                const config = chain.onfail;
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
                    }
                    else if (backoff === 'exponential') {
                        delayMs = baseDelay * Math.pow(2, currentAttempt - 1);
                    }
                    else if (backoff === 'linear') {
                        delayMs = baseDelay * currentAttempt;
                    }
                    if (maxDelay !== undefined && delayMs > maxDelay) {
                        delayMs = maxDelay;
                    }
                    if (config.jitter) {
                        delayMs = Math.floor(Math.random() * delayMs);
                    }
                    delayMs = Math.max(0, delayMs);
                    let timerId;
                    let abortHandler;
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
                            .then((result) => {
                            resolve(result);
                        })
                            .catch((err) => {
                            reject(err);
                        });
                    };
                    if (delayMs === 0) {
                        doRetry();
                    }
                    else {
                        timerId = setTimeout(doRetry, delayMs);
                    }
                }
                else {
                    reject(error);
                }
            }
            else {
                reject(error);
            }
        }
        else {
            reject(error);
        }
    }
}
exports.default = OnFail;
//# sourceMappingURL=OnFail.js.map