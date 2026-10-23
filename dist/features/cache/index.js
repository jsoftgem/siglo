"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cache = cache;
const storage_1 = require("../storage");
const proxy_1 = require("../context/proxy");
function cache(stackId, stepId, param, cachedLast, action, tenantId) {
    const adapter = storage_1.defaultStorageManager.getStorageAdapter();
    const cleanParam = (0, proxy_1.toPOJO)(param);
    const paramToHash = Object.assign({}, cleanParam);
    const internalKeys = ['$chainId', '$stackId', '$tenantId', '$$$validators', '$steps', '$history', '$signal', 'signal', 'props', 'raw'];
    for (const ik of internalKeys) {
        delete paramToHash[ik];
    }
    const paramJSON = JSON.stringify(paramToHash);
    const effectiveCacheKey = tenantId
        ? `${tenantId}:${stepId}:${paramJSON}`
        : `${stepId}:${paramJSON}`;
    if ((0, storage_1.hasCached)(stackId, effectiveCacheKey, paramJSON)) {
        const cachedAction = (0, storage_1.getCachedChainAction)(stackId, effectiveCacheKey, paramJSON);
        const currentTime = new Date().getTime();
        const expirationTime = cachedAction.timestamp + cachedLast;
        if (currentTime <= expirationTime) {
            return cachedAction.result;
        }
        else {
            (0, storage_1.clearCache)(stackId, effectiveCacheKey);
        }
    }
    if (adapter?.getCachedStep) {
        return (async () => {
            try {
                const adapterCached = await adapter.getCachedStep(effectiveCacheKey);
                if (adapterCached !== undefined) {
                    (0, storage_1.cacheChainAction)(stackId, effectiveCacheKey, paramJSON, adapterCached);
                    return adapterCached;
                }
                /* c8 ignore next 3 */
            }
            catch {
                // Ignore adapter read failure
            }
            const actionResult = await action(param);
            (0, storage_1.cacheChainAction)(stackId, effectiveCacheKey, paramJSON, actionResult);
            if (adapter?.setCachedStep) {
                try {
                    await adapter.setCachedStep(effectiveCacheKey, actionResult, cachedLast);
                    /* c8 ignore next 3 */
                }
                catch {
                    // Ignore adapter write failure
                }
            }
            return actionResult;
        })();
    }
    const result = action(param);
    if (result instanceof Promise) {
        return result.then(async (val) => {
            (0, storage_1.cacheChainAction)(stackId, effectiveCacheKey, paramJSON, val);
            if (adapter?.setCachedStep) {
                try {
                    await adapter.setCachedStep(effectiveCacheKey, val, cachedLast);
                    /* c8 ignore next 3 */
                }
                catch {
                    // Ignore adapter write failure
                }
            }
            return val;
        });
    }
    (0, storage_1.cacheChainAction)(stackId, effectiveCacheKey, paramJSON, result);
    if (adapter?.setCachedStep) {
        try {
            const setRes = adapter.setCachedStep(effectiveCacheKey, result, cachedLast);
            /* c8 ignore next 3 */
            if (setRes && typeof setRes.catch === 'function') {
                setRes.catch(() => { });
            }
            /* c8 ignore next 3 */
        }
        catch {
            // Ignore adapter write failure
        }
    }
    return result;
}
//# sourceMappingURL=index.js.map