import {
    ATTEMPT,
    DurationInput,
    ExecutionPhase,
    IS_DURABLE,
    RETRY_DELAY,
    WORKFLOW_ID,
    isObject,
    isReservedKey,
    parseDuration,
} from '../../shared';
import { SigloError } from '../executer/exceptions';
import { SyncValue, isThenable } from '../spec/sync';
import { registerStorageResetHook, serializeParam } from '../storage';

export const DEFAULT_COMPUTE_CACHE_TTL_MS = 1500;
export const DEFAULT_COMPUTE_CACHE_MAX_ENTRIES = 1000;

export interface ComputeCacheOptions {
    /** Cache entry TTL (number in ms or DurationInput string like '5m'). Default: 1500ms. */
    ttl?: DurationInput;
    /** Maximum number of entries retained in the step-local LRU cache. Default: 1000. */
    maxEntries?: number;
    /** Synchronous custom cache key serializer (receives post-.spec() normalized input). */
    keySerializer?: (stepId: string, param: any, namespace?: string) => SyncValue<string>;
}

interface ComputeCacheEntry {
    value: any;
    expiresAt: number;
}

const EXTRA_INTERNAL_KEYS = new Set<string>([ATTEMPT, RETRY_DELAY, IS_DURABLE, WORKFLOW_ID]);

const activeComputeCaches = new Set<ComputeCache>();

export function clearComputeCaches(): void {
    for (const cache of activeComputeCaches) {
        cache.clear();
    }
    activeComputeCaches.clear();
}

function stripInternalKeys(param: any): any {
    if (!isObject(param) || Array.isArray(param)) {
        return param;
    }
    const stripped: Record<string, any> = {};
    for (const key of Object.keys(param)) {
        if (isReservedKey(key) || EXTRA_INTERNAL_KEYS.has(key)) {
            continue;
        }
        stripped[key] = param[key];
    }
    return stripped;
}

function cloneCacheValue<T>(val: T): T {
    if (val === null || typeof val !== 'object') {
        return val;
    }
    if (Array.isArray(val)) {
        return val.map(cloneCacheValue) as unknown as T;
    }
    const proto = Object.getPrototypeOf(val);
    if (proto === Object.prototype || proto === null) {
        const copy: Record<string, any> = {};
        for (const key of Object.keys(val)) {
            copy[key] = cloneCacheValue((val as any)[key]);
        }
        return copy as T;
    }
    return val;
}

export class ComputeCache {
    private readonly entries = new Map<string, ComputeCacheEntry>();
    readonly ttlMs: number;
    readonly maxEntries: number;
    readonly keySerializer?: (stepId: string, param: any, namespace?: string) => SyncValue<string>;

    constructor(options: ComputeCacheOptions = {}) {
        const parsedTtl = parseDuration(options.ttl);
        this.ttlMs = parsedTtl !== undefined && parsedTtl > 0 ? parsedTtl : DEFAULT_COMPUTE_CACHE_TTL_MS;
        this.maxEntries =
            options.maxEntries !== undefined && options.maxEntries > 0
                ? Math.floor(options.maxEntries)
                : DEFAULT_COMPUTE_CACHE_MAX_ENTRIES;
        this.keySerializer = options.keySerializer;
    }

    buildKey(stepId: string, normalizedInput: any, namespace?: string): string {
        const stripped = stripInternalKeys(normalizedInput);
        let paramKey: string;
        if (this.keySerializer) {
            const customKey: unknown = this.keySerializer(stepId, stripped, namespace);
            if (isThenable(customKey)) {
                if (customKey instanceof Promise) {
                    customKey.catch(() => {});
                }
                throw new SigloError(
                    `Step.compute cache keySerializer for '${stepId}' must be synchronous and cannot return a Promise.`,
                    {
                        stepName: stepId,
                        phase: ExecutionPhase.ACTION,
                        retryable: false,
                    },
                );
            }
            paramKey = String(customKey);
        } else {
            paramKey = serializeParam(stripped);
        }
        return namespace ? `${namespace}:${stepId}:${paramKey}` : `${stepId}:${paramKey}`;
    }

    get(key: string): { hit: true; value: any } | { hit: false } {
        const entry = this.entries.get(key);
        if (!entry) {
            return { hit: false };
        }
        if (Date.now() > entry.expiresAt) {
            this.entries.delete(key);
            if (this.entries.size === 0) {
                activeComputeCaches.delete(this);
            }
            return { hit: false };
        }
        // Refresh LRU recency by moving entry to the end of insertion order
        this.entries.delete(key);
        this.entries.set(key, entry);
        return { hit: true, value: cloneCacheValue(entry.value) };
    }

    set(key: string, value: any): void {
        if (this.entries.has(key)) {
            this.entries.delete(key);
        }
        this.entries.set(key, {
            value: cloneCacheValue(value),
            expiresAt: Date.now() + this.ttlMs,
        });
        while (this.entries.size > this.maxEntries) {
            const oldestKey = this.entries.keys().next().value;
            /* c8 ignore next 3 */
            if (oldestKey === undefined) {
                break;
            }
            this.entries.delete(oldestKey);
        }
        activeComputeCaches.add(this);
        registerStorageResetHook(clearComputeCaches);
    }

    clear(): void {
        this.entries.clear();
        activeComputeCaches.delete(this);
    }

    get size(): number {
        return this.entries.size;
    }
}
