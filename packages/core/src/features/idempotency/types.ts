export type IdempotencyClaimStatus = 'claimed' | 'completed' | 'in-progress';

export interface IdempotencyStore {
    claim(key: string, ttlMs?: number): Promise<IdempotencyClaimStatus>;
    complete(key: string, result: unknown): Promise<void>;
    fail(key: string, error: unknown): Promise<void>;
    get?(key: string): Promise<unknown>;
    getRecord?(key: string): Promise<IdempotencyRecord | undefined>;
}

export interface IdempotencyRecord {
    status: 'in-progress' | 'completed' | 'failed';
    result?: unknown;
    error?: unknown;
    isPermanentError?: boolean;
    claimedAt: number;
    expiresAt?: number;
}

export interface IdempotencyOptions {
    key?: string | ((ctx: any) => string);
    ttlMs?: number;
    store?: IdempotencyStore;
    settleTimeoutMs?: number;
    pollIntervalMs?: number;
    isPermanentError?: (err: any) => boolean;
}

export function isPermanentBusinessError(error: any, options?: IdempotencyOptions): boolean {
    if (options?.isPermanentError && typeof options.isPermanentError === 'function') {
        return Boolean(options.isPermanentError(error));
    }
    if (error && typeof error === 'object') {
        if (error.isPermanent === true || error.permanent === true || error.isBusinessError === true) {
            return true;
        }
    }
    return false;
}
