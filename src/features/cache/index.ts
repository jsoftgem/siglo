import { cacheChainAction, clearCache, defaultStorageManager, getCachedChainAction, hasCached } from '../storage';
import { toPOJO } from '../context/proxy';

export function cache(
    stackId: string,
    stepId: string,
    param: any,
    cachedLast: number,
    action: (param: any) => any,
    tenantId?: string
): any {
    const adapter = defaultStorageManager.getStorageAdapter();

    const cleanParam = toPOJO(param);
    const paramToHash = Object.assign({}, cleanParam);
    const internalKeys = ['$chainId', '$stackId', '$tenantId', '$$$validators', '$steps', '$history', '$signal', 'signal', 'props', 'raw'];
    for (const ik of internalKeys) {
        delete paramToHash[ik];
    }
    const paramJSON = JSON.stringify(paramToHash);
    const effectiveCacheKey = tenantId
        ? `${tenantId}:${stepId}:${paramJSON}`
        : `${stepId}:${paramJSON}`;

    if (hasCached(stackId, effectiveCacheKey, paramJSON)) {
        const cachedAction = getCachedChainAction(stackId, effectiveCacheKey, paramJSON);
        const currentTime = new Date().getTime();
        const expirationTime = cachedAction.timestamp + cachedLast;
        if (currentTime <= expirationTime) {
            return cachedAction.result;
        } else {
            clearCache(stackId, effectiveCacheKey);
        }
    }

    if (adapter?.getCachedStep) {
        return (async () => {
            try {
                const adapterCached = await adapter.getCachedStep!(effectiveCacheKey);
                if (adapterCached !== undefined) {
                    cacheChainAction(stackId, effectiveCacheKey, paramJSON, adapterCached);
                    return adapterCached;
                }
            /* c8 ignore next 3 */
            } catch {
                // Ignore adapter read failure
            }

            const actionResult = await action(param);
            cacheChainAction(stackId, effectiveCacheKey, paramJSON, actionResult);
            if (adapter?.setCachedStep) {
                try {
                    await adapter.setCachedStep(effectiveCacheKey, actionResult, cachedLast);
                /* c8 ignore next 3 */
                } catch {
                    // Ignore adapter write failure
                }
            }
            return actionResult;
        })();
    }

    const result = action(param);
    if (result instanceof Promise) {
        return result.then(async (val) => {
            cacheChainAction(stackId, effectiveCacheKey, paramJSON, val);
            if (adapter?.setCachedStep) {
                try {
                    await adapter.setCachedStep(effectiveCacheKey, val, cachedLast);
                /* c8 ignore next 3 */
                } catch {
                    // Ignore adapter write failure
                }
            }
            return val;
        });
    }

    cacheChainAction(stackId, effectiveCacheKey, paramJSON, result);
    if (adapter?.setCachedStep) {
        try {
            const setRes = adapter.setCachedStep(effectiveCacheKey, result, cachedLast);
            /* c8 ignore next 3 */
            if (setRes && typeof (setRes as any).catch === 'function') {
                (setRes as any).catch(() => {});
            }
        /* c8 ignore next 3 */
        } catch {
            // Ignore adapter write failure
        }
    }
    return result;
}
