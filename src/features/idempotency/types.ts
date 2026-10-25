export type IdempotencyClaimStatus = 'claimed' | 'completed' | 'in-progress';

export interface IdempotencyStore {
    claim(key: string, ttlMs?: number): Promise<IdempotencyClaimStatus>;
    complete(key: string, result: unknown): Promise<void>;
    fail(key: string, error: unknown): Promise<void>;
    get?(key: string): Promise<unknown>;
}

export interface IdempotencyRecord {
    status: 'in-progress' | 'completed' | 'failed';
    result?: unknown;
    error?: unknown;
    claimedAt: number;
    expiresAt?: number;
}

export interface IdempotencyOptions {
    key?: string | ((ctx: any) => string);
    ttlMs?: number;
    store?: IdempotencyStore;
}
