"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cache = cache;
const shared_1 = require("../../shared");
const storage_1 = require("../storage");
const context_1 = require("../context");
const inFlightPromises = new Map();
function cache(stackId, stepId, param, cachedLast, action, namespace, options) {
    const adapter = storage_1.defaultStorageManager.getStorageAdapter();
    const cleanParam = (0, context_1.toPOJO)(param);
    const paramToHash = Object.assign({}, cleanParam);
    const internalKeys = [
        shared_1.CHAIN_ID,
        shared_1.STEP_ID,
        shared_1.STACK_ID,
        shared_1.VALIDATORS,
        shared_1.STEPS,
        shared_1.HISTORY,
        shared_1.SIGNAL,
        shared_1.SIGNAL_KEY,
        'props',
        'raw',
        shared_1.ATTEMPT,
        shared_1.RETRY_DELAY,
        shared_1.WORKFLOW_ID
    ];
    for (const ik of internalKeys) {
        delete paramToHash[ik];
    }
    delete paramToHash[shared_1.NAMESPACE];
    delete paramToHash[shared_1.NAMESPACE_KEY];
    delete paramToHash[shared_1.STACK_ID_KEY];
    const customSerializer = options?.keySerializer || (storage_1.defaultStorageManager.getState().config?.cacheKeySerializer);
    const paramKey = customSerializer
        ? customSerializer(stepId, paramToHash, namespace)
        : JSON.stringify(paramToHash);
    const effectiveCacheKey = namespace
        ? `${namespace}:${stepId}:${paramKey}`
        : `${stepId}:${paramKey}`;
    const swrWindow = typeof options?.swr === 'number'
        ? options.swr
        : (options?.staleWhileRevalidate || (options?.swr ? cachedLast : 0));
    // 1. In-Memory Cache Lookup
    if ((0, storage_1.hasCached)(stackId, effectiveCacheKey, paramKey)) {
        const cachedAction = (0, storage_1.getCachedChainAction)(stackId, effectiveCacheKey, paramKey);
        const currentTime = Date.now();
        const expirationTime = cachedAction.timestamp + cachedLast;
        if (currentTime <= expirationTime) {
            storage_1.defaultStorageManager.emitCacheEvent({
                type: 'hit',
                key: effectiveCacheKey,
                stepId,
                stackId,
                namespace,
                timestamp: currentTime
            });
            return cachedAction.result;
        }
        else if (swrWindow > 0 && currentTime <= expirationTime + swrWindow) {
            storage_1.defaultStorageManager.emitCacheEvent({
                type: 'hit',
                key: effectiveCacheKey,
                stepId,
                stackId,
                namespace,
                timestamp: currentTime
            });
            // Background revalidation
            Promise.resolve().then(async () => {
                try {
                    const fresh = await action(param);
                    (0, storage_1.cacheChainAction)(stackId, effectiveCacheKey, paramKey, fresh);
                    if (adapter?.setCachedStep) {
                        try {
                            await adapter.setCachedStep(effectiveCacheKey, fresh, cachedLast);
                        }
                        catch (err) {
                            storage_1.defaultStorageManager.handleAdapterError('setCachedStep', err);
                        }
                    }
                }
                catch {
                    // Suppress background revalidation error
                }
            });
            return cachedAction.result;
        }
        else {
            (0, storage_1.clearCache)(stackId, effectiveCacheKey);
        }
    }
    // 2. Cache Stampede Protection (In-flight Promise deduplication)
    const useStampedeProtection = options?.stampedeProtection !== false;
    if (useStampedeProtection && inFlightPromises.has(effectiveCacheKey)) {
        return inFlightPromises.get(effectiveCacheKey);
    }
    // 3. Adapter Distributed Cache Lookup
    if (adapter?.getCachedStep) {
        const executionPromise = (async () => {
            try {
                const adapterCached = await adapter.getCachedStep(effectiveCacheKey);
                if (adapterCached !== undefined) {
                    storage_1.defaultStorageManager.emitCacheEvent({
                        type: 'hit',
                        key: effectiveCacheKey,
                        stepId,
                        stackId,
                        namespace,
                        timestamp: Date.now()
                    });
                    (0, storage_1.cacheChainAction)(stackId, effectiveCacheKey, paramKey, adapterCached);
                    return adapterCached;
                }
            }
            catch (err) {
                storage_1.defaultStorageManager.handleAdapterError('getCachedStep', err);
            }
            storage_1.defaultStorageManager.emitCacheEvent({
                type: 'miss',
                key: effectiveCacheKey,
                stepId,
                stackId,
                namespace,
                timestamp: Date.now()
            });
            const actionResult = await action(param);
            (0, storage_1.cacheChainAction)(stackId, effectiveCacheKey, paramKey, actionResult);
            if (adapter?.setCachedStep) {
                try {
                    await adapter.setCachedStep(effectiveCacheKey, actionResult, cachedLast);
                }
                catch (err) {
                    storage_1.defaultStorageManager.handleAdapterError('setCachedStep', err);
                }
            }
            return actionResult;
        })();
        if (useStampedeProtection) {
            inFlightPromises.set(effectiveCacheKey, executionPromise);
            const clean = () => { inFlightPromises.delete(effectiveCacheKey); };
            executionPromise.then(clean, clean);
        }
        return executionPromise;
    }
    storage_1.defaultStorageManager.emitCacheEvent({
        type: 'miss',
        key: effectiveCacheKey,
        stepId,
        stackId,
        namespace,
        timestamp: Date.now()
    });
    // 4. Local Execution
    const rawResult = action(param);
    if (rawResult instanceof Promise) {
        const executionPromise = rawResult.then(async (val) => {
            (0, storage_1.cacheChainAction)(stackId, effectiveCacheKey, paramKey, val);
            if (adapter?.setCachedStep) {
                try {
                    await adapter.setCachedStep(effectiveCacheKey, val, cachedLast);
                }
                catch (err) {
                    storage_1.defaultStorageManager.handleAdapterError('setCachedStep', err);
                }
            }
            return val;
        });
        if (useStampedeProtection) {
            inFlightPromises.set(effectiveCacheKey, executionPromise);
            const clean = () => { inFlightPromises.delete(effectiveCacheKey); };
            executionPromise.then(clean, clean);
        }
        return executionPromise;
    }
    // Synchronous execution result
    (0, storage_1.cacheChainAction)(stackId, effectiveCacheKey, paramKey, rawResult);
    if (adapter?.setCachedStep) {
        try {
            const setRes = adapter.setCachedStep(effectiveCacheKey, rawResult, cachedLast);
            if (setRes && typeof setRes.catch === 'function') {
                setRes.catch((err) => {
                    try {
                        storage_1.defaultStorageManager.handleAdapterError('setCachedStep', err);
                    }
                    catch {
                        // Suppress unhandled rejection in background fire-and-forget sync write
                    }
                });
            }
        }
        catch (err) {
            storage_1.defaultStorageManager.handleAdapterError('setCachedStep', err);
        }
    }
    return rawResult;
}
//# sourceMappingURL=index.js.map