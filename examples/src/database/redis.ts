export interface IRedisClient {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSeconds?: number): Promise<'OK'>;
    hget(hash: string, field: string): Promise<string | null>;
    hset(hash: string, field: string, value: string): Promise<number>;
    hgetall(hash: string): Promise<Record<string, string>>;
    del(key: string): Promise<number>;
    flushall(): Promise<'OK'>;
    isConnected(): boolean;
    disconnect(): Promise<void>;
}

export class InMemoryRedisClient implements IRedisClient {
    private strings = new Map<string, string>();
    private hashes = new Map<string, Map<string, string>>();

    async get(key: string): Promise<string | null> {
        return this.strings.get(key) || null;
    }

    async set(key: string, value: string): Promise<'OK'> {
        this.strings.set(key, value);
        return 'OK';
    }

    async hget(hash: string, field: string): Promise<string | null> {
        const h = this.hashes.get(hash);
        if (!h) return null;
        return h.get(field) || null;
    }

    async hset(hash: string, field: string, value: string): Promise<number> {
        let h = this.hashes.get(hash);
        if (!h) {
            h = new Map();
            this.hashes.set(hash, h);
        }
        const isNew = !h.has(field);
        h.set(field, value);
        return isNew ? 1 : 0;
    }

    async hgetall(hash: string): Promise<Record<string, string>> {
        const h = this.hashes.get(hash);
        if (!h) return {};
        const res: Record<string, string> = {};
        for (const [k, v] of h.entries()) {
            res[k] = v;
        }
        return res;
    }

    async del(key: string): Promise<number> {
        let deleted = 0;
        if (this.strings.delete(key)) deleted++;
        if (this.hashes.delete(key)) deleted++;
        return deleted;
    }

    async flushall(): Promise<'OK'> {
        this.strings.clear();
        this.hashes.clear();
        return 'OK';
    }

    isConnected(): boolean {
        return true;
    }

    async disconnect(): Promise<void> {
        // In-memory noop
    }
}

export class LiveRedisClient implements IRedisClient {
    private client: any;

    constructor(client: any) {
        this.client = client;
    }

    async get(key: string): Promise<string | null> {
        return this.client.get(key);
    }

    async set(key: string, value: string): Promise<'OK'> {
        return this.client.set(key, value);
    }

    async hget(hash: string, field: string): Promise<string | null> {
        return this.client.hget(hash, field);
    }

    async hset(hash: string, field: string, value: string): Promise<number> {
        return this.client.hset(hash, field, value);
    }

    async hgetall(hash: string): Promise<Record<string, string>> {
        return this.client.hgetall(hash);
    }

    async del(key: string): Promise<number> {
        return this.client.del(key);
    }

    async flushall(): Promise<'OK'> {
        return this.client.flushall();
    }

    isConnected(): boolean {
        return this.client.status === 'ready' || this.client.status === 'connect';
    }

    async disconnect(): Promise<void> {
        await this.client.quit().catch(() => {});
    }
}

/**
 * Factory to create Redis client.
 * Connects to live Redis if REDIS_URL is provided, or uses in-memory adapter.
 */
export function createRedisClient(url = process.env.REDIS_URL): IRedisClient {
    if (url) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { Redis } = require('ioredis');
            const io = new Redis(url, {
                maxRetriesPerRequest: 1,
                connectTimeout: 3000,
                retryStrategy: () => null // don't loop endlessly if daemon is not up
            });
            console.log(`[Redis] Connected to live Redis instance at: ${url}`);
            return new LiveRedisClient(io);
        } catch {
            console.warn('[Redis] ioredis failed to initialize. Falling back to in-memory adapter.');
            return new InMemoryRedisClient();
        }
    }

    console.log('[Redis] Running in-memory Redis adapter (zero-daemon ready)');
    return new InMemoryRedisClient();
}
