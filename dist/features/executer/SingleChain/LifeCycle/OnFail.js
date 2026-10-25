"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const exceptions_1 = require("../../exceptions");
const shared_1 = require("../../../../shared");
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
        if (outerSignal?.aborted) {
            reject(outerSignal.reason || new Error('This operation was aborted'));
            return;
        }
        if (error instanceof exceptions_1.FlowTimeoutException || error?.name === 'FlowTimeoutException') {
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
                const retryFn = (fallback) => {
                    if (fallback !== undefined) {
                        resolve(fallback);
                        return;
                    }
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
                const rejectFn = (customError) => {
                    reject(customError || error);
                };
                try {
                    const callbackRes = chain.onfail(error, retryFn, rejectFn);
                    if (callbackRes !== undefined) {
                        if (callbackRes instanceof Promise) {
                            callbackRes.then((res) => {
                                if (res !== undefined)
                                    resolve(res);
                            }).catch((cbErr) => reject(cbErr));
                        }
                        else {
                            resolve(callbackRes);
                        }
                    }
                }
                catch (cbErr) {
                    reject(cbErr);
                }
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
                const stepKey = (chains && typeof chains === 'object' && chains[shared_1.CHAIN_ID])
                    ? chains[shared_1.CHAIN_ID]
                    : (chain.func || chain.name || (typeof chains === 'string' ? chains : 'chain'));
                const retryMap = initialParam && typeof initialParam === 'object' ? initialParam[RETRY_MAP] : {};
                const currentAttempt = (retryMap[stepKey] || 0) + 1;
                retryMap[stepKey] = currentAttempt;
                if (config.retryIf && !config.retryIf(error, currentAttempt)) {
                    reject(error);
                    return;
                }
                if (currentAttempt <= maxRetries) {
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
                    if (typeof config.jitter === 'function') {
                        delayMs = config.jitter(delayMs);
                    }
                    else if (config.jitter) {
                        const rand = typeof config.randomFn === 'function' ? config.randomFn() : Math.random();
                        delayMs = Math.floor(rand * delayMs);
                    }
                    delayMs = Math.max(0, delayMs);
                    if (config.onRetry) {
                        config.onRetry(error, currentAttempt, delayMs);
                    }
                    if (initialParam && typeof initialParam === 'object') {
                        const attFn = () => currentAttempt;
                        attFn.val = currentAttempt;
                        initialParam[shared_1.ATTEMPT] = attFn;
                        const delFn = () => delayMs;
                        delFn.val = delayMs;
                        initialParam[shared_1.RETRY_DELAY] = delFn;
                    }
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