import { randomBytes } from 'crypto';
import { RedisClientInterface } from './types';

export interface RedisLockResult {
    acquired: boolean;
    token: string;
}

export interface RedisLockOptions {
    keyPrefix?: string;
    strictAtomicity?: boolean;
}

export class RedisLock {
    private client: RedisClientInterface;
    private keyPrefix: string;
    private strictAtomicity: boolean;

    constructor(client: RedisClientInterface, optionsOrPrefix: string | RedisLockOptions = 'siglo:lock:') {
        if (!client) {
            throw new Error('RedisLock requires a valid Redis client instance.');
        }
        this.client = client;
        if (typeof optionsOrPrefix === 'string') {
            this.keyPrefix = optionsOrPrefix;
            this.strictAtomicity = false;
        } else {
            this.keyPrefix = optionsOrPrefix.keyPrefix || 'siglo:lock:';
            this.strictAtomicity = optionsOrPrefix.strictAtomicity ?? false;
        }
    }

    private fullKey(key: string): string {
        return `${this.keyPrefix}${key}`;
    }

    /**
     * Attempts to acquire an atomic distributed lock for single-flight coordination.
     */
    async acquire(lockKey: string, ttlMs: number = 10000, customToken?: string): Promise<RedisLockResult> {
        const key = this.fullKey(lockKey);
        const token = customToken || `lock_${Date.now()}_${randomBytes(16).toString('hex')}`;

        const res = await this.client.set(key, token, 'PX', ttlMs, 'NX');
        const acquired = res === 'OK';

        return { acquired, token };
    }

    /**
     * Releases the lock safely only if the token matches.
     */
    async release(lockKey: string, token: string): Promise<boolean> {
        const key = this.fullKey(lockKey);

        if (this.client.eval) {
            const lua = `
                if redis.call("get", KEYS[1]) == ARGV[1] then
                    return redis.call("del", KEYS[1])
                else
                    return 0
                end
            `;
            const res = await this.client.eval(lua, 1, key, token);
            return res === 1;
        }

        if (this.strictAtomicity) {
            throw new Error('RedisLock: client.eval is required for atomic release to prevent TOCTOU race condition.');
        }

        const currentVal = await this.client.get(key);
        if (currentVal === token) {
            await this.client.del(key);
            return true;
        }
        return false;
    }

    /**
     * Executes an async operation with single-flight lock protection.
     */
    async withLock<T>(lockKey: string, fn: () => Promise<T>, ttlMs: number = 10000): Promise<T> {
        const { acquired, token } = await this.acquire(lockKey, ttlMs);
        if (!acquired) {
            throw new Error(`Failed to acquire lock for key: ${lockKey} (in-use or concurrent execution)`);
        }
        try {
            return await fn();
        } finally {
            await this.release(lockKey, token).catch(() => {});
        }
    }
}
