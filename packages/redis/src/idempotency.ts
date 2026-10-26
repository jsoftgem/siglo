import { IdempotencyStore } from 'fluid-func';
import { RedisIdempotencyOptions, RedisClientInterface } from './types';

const COMPLETED_PREFIX = 'COMPLETED:';
const IN_PROGRESS_VAL = 'in-progress';

export class RedisIdempotencyStore implements IdempotencyStore {
    private client: RedisClientInterface;
    private keyPrefix: string;
    private defaultTtlMs: number;

    constructor(options: RedisIdempotencyOptions) {
        if (!options || !options.client) {
            throw new Error('RedisIdempotencyStore requires a valid Redis client instance.');
        }
        this.client = options.client;
        this.keyPrefix = options.keyPrefix || 'fluid:idemp:';
        this.defaultTtlMs = options.defaultTtlMs || 86400000; // 24 hours default
    }

    private formatKey(key: string): string {
        return `${this.keyPrefix}${key}`;
    }

    async claim(key: string, ttlMs?: number): Promise<'claimed' | 'completed' | 'in-progress'> {
        const fullKey = this.formatKey(key);
        const effectiveTtl = ttlMs || this.defaultTtlMs;

        // Atomic lock attempt: SET fullKey "in-progress" NX PX effectiveTtl
        const response = await this.client.set(fullKey, IN_PROGRESS_VAL, 'PX', effectiveTtl, 'NX');
        if (response === 'OK') {
            return 'claimed';
        }

        // Already exists: inspect current state
        const existing = await this.client.get(fullKey);
        if (existing && existing.startsWith(COMPLETED_PREFIX)) {
            return 'completed';
        }

        return 'in-progress';
    }

    async complete(key: string, result: unknown, ttlMs?: number): Promise<void> {
        const fullKey = this.formatKey(key);
        const effectiveTtl = ttlMs || this.defaultTtlMs;
        const payload = COMPLETED_PREFIX + JSON.stringify(result ?? null);
        await this.client.set(fullKey, payload, 'PX', effectiveTtl);
    }

    async fail(key: string, _error: unknown): Promise<void> {
        const fullKey = this.formatKey(key);
        // Clear in-flight claim to allow subsequent retry execution
        const existing = await this.client.get(fullKey);
        if (existing === IN_PROGRESS_VAL) {
            await this.client.del(fullKey);
        }
    }

    async getResult(key: string): Promise<unknown | undefined> {
        const fullKey = this.formatKey(key);
        const data = await this.client.get(fullKey);
        if (data && data.startsWith(COMPLETED_PREFIX)) {
            try {
                return JSON.parse(data.slice(COMPLETED_PREFIX.length));
            } catch {
                return undefined;
            }
        }
        return undefined;
    }
}
