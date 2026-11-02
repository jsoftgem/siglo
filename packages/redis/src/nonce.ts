import { RedisClientInterface, RedisNonceStoreOptions } from './types';

/**
 * Distributed Redis nonce / signature deduplication store for webhook replay attack prevention.
 * Uses atomic Redis `SET ... PX ... NX` to enforce single-use tokens within the tolerance window.
 */
export class RedisNonceStore {
    private client: RedisClientInterface;
    private keyPrefix: string;

    constructor(options: RedisNonceStoreOptions) {
        if (!options || !options.client) {
            throw new Error('RedisNonceStore requires a valid Redis client instance.');
        }
        this.client = options.client;
        this.keyPrefix = options.keyPrefix || 'siglo:wh:dedup:';
    }

    /**
     * Atomically claims a deduplication key with TTL.
     * Returns true if claimed (first delivery attempt), or false if key already exists (replay).
     */
    async claim(key: string, ttlSeconds: number): Promise<boolean> {
        const fullKey = `${this.keyPrefix}${key}`;
        const ttlMs = Math.max(1, Math.floor(ttlSeconds * 1000));
        const res = await this.client.set(fullKey, '1', 'PX', ttlMs, 'NX');
        return res === 'OK';
    }
}
