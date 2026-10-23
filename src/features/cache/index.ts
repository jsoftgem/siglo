import { cacheChainAction, clearCache, defaultStorageManager, getCachedChainAction, hasCached } from '../storage';
import { toPOJO } from '../context';

export interface CacheOptions {
    ttl?: number;
    staleWhileRevalidate?: number;
    swr?: boolean | number;
    keySerializer?: (stepId: string, param: any, namespace?: string) => string;
    stampedeProtection?: boolean;
}

const inFlightPromises = new Map<string, Promise<any>>();

export function cache(
    stackId: string,
    stepId: string,
    param: any,
    cachedLast: number,
    action: (param: any) => any,
    namespace?: string,
    options?: CacheOptions
): any {
    const adapter = defaultStorageManager.getStorageAdapter();
    const cleanParam = toPOJO(param);
    const paramToHash = Object.assign({}, cleanParam);
    const internalKeys = [
        '$chainId',
        '$stepId',
        '$stackId',
        
        '$$$validators',
        '$steps',
        '$history',
        '$signal',
        'signal',
        'props',
        'raw',
        '$attempt',
        '$retryDelay',
        '$workflowId'
    ];
    for (const ik of internalKeys) {
        delete paramToHash[ik];
    }
    delete paramToHash['$namespace'];
    delete paramToHash['namespace'];

    const customSerializer = options?.keySerializer || (defaultStorageManager.getState().config?.cacheKeySerializer);
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
    if (hasCached(stackId, effectiveCacheKey, paramKey)) {
        const cachedAction = getCachedChainAction(stackId, effectiveCacheKey, paramKey);
        const currentTime = Date.now();
        const expirationTime = cachedAction.timestamp + cachedLast;

        if (currentTime <= expirationTime) {
            defaultStorageManager.emitCacheEvent({
                type: 'hit',
                key: effectiveCacheKey,
                stepId,
                stackId,
                namespace,
                timestamp: currentTime
            });
            return cachedAction.result;
        } else if (swrWindow > 0 && currentTime <= expirationTime + swrWindow) {
            defaultStorageManager.emitCacheEvent({
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
                    cacheChainAction(stackId, effectiveCacheKey, paramKey, fresh);
                    if (adapter?.setCachedStep) {
                        try {
                            await adapter.setCachedStep(effectiveCacheKey, fresh, cachedLast);
                        } catch (err) {
                            defaultStorageManager.handleAdapterError('setCachedStep', err);
                        }
                    }
                } catch {
                    // Suppress background revalidation error
                }
            });
            return cachedAction.result;
        } else {
            clearCache(stackId, effectiveCacheKey);
        }
    }

    // 2. Cache Stampede Protection (In-flight Promise deduplication)
    const useStampedeProtection = options?.stampedeProtection !== false;
    if (useStampedeProtection && inFlightPromises.has(effectiveCacheKey)) {
        return inFlightPromises.get(effectiveCacheKey)!;
    }

    // 3. Adapter Distributed Cache Lookup
    if (adapter?.getCachedStep) {
        const executionPromise = (async () => {
            try {
                const adapterCached = await adapter.getCachedStep!(effectiveCacheKey);
                if (adapterCached !== undefined) {
                    defaultStorageManager.emitCacheEvent({
                        type: 'hit',
                        key: effectiveCacheKey,
                        stepId,
                        stackId,
                namespace,
                timestamp: Date.now()
                    });
                    cacheChainAction(stackId, effectiveCacheKey, paramKey, adapterCached);
                    return adapterCached;
                }
            } catch (err) {
                defaultStorageManager.handleAdapterError('getCachedStep', err);
            }

            defaultStorageManager.emitCacheEvent({
                type: 'miss',
                key: effectiveCacheKey,
                stepId,
                stackId,
                namespace,
                timestamp: Date.now()
            });

            const actionResult = await action(param);
            cacheChainAction(stackId, effectiveCacheKey, paramKey, actionResult);
            if (adapter?.setCachedStep) {
                try {
                    await adapter.setCachedStep(effectiveCacheKey, actionResult, cachedLast);
                } catch (err) {
                    defaultStorageManager.handleAdapterError('setCachedStep', err);
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

    defaultStorageManager.emitCacheEvent({
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
            cacheChainAction(stackId, effectiveCacheKey, paramKey, val);
            if (adapter?.setCachedStep) {
                try {
                    await adapter.setCachedStep(effectiveCacheKey, val, cachedLast);
                } catch (err) {
                    defaultStorageManager.handleAdapterError('setCachedStep', err);
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
    cacheChainAction(stackId, effectiveCacheKey, paramKey, rawResult);
    if (adapter?.setCachedStep) {
        try {
            const setRes = adapter.setCachedStep(effectiveCacheKey, rawResult, cachedLast);
            if (setRes && typeof (setRes as any).catch === 'function') {
                (setRes as any).catch((err: any) => {
                    try {
                        defaultStorageManager.handleAdapterError('setCachedStep', err);
                    } catch {
                        // Suppress unhandled rejection in background fire-and-forget sync write
                    }
                });
            }
        } catch (err) {
            defaultStorageManager.handleAdapterError('setCachedStep', err);
        }
    }
    return rawResult;
}
