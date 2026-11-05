import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Step, StorageAdapter } from '@siglo/core';
import { PostgresStorageAdapter, PostgresIdempotencyStore } from '@siglo/postgres';
import { RedisStorageAdapter, RedisClientInterface } from '@siglo/redis';

export const namespace = 'distributed-checkout';
export const channel = 'tutorial:checkout:events';
export const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6380';

// Adapt ioredis overloads to the adapters' small client interfaces.
export function pubsubClient(redis: Redis) {
    return {
        publish: (topic: string, message: string) => redis.publish(topic, message),
        subscribe: (topic: string) => redis.subscribe(topic),
        on: (event: 'message', listener: (topic: string, message: string) => void) => redis.on(event, listener)
    };
}

export async function connectInfrastructure() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL
            || 'postgres://siglo:siglo@127.0.0.1:5433/checkout',
        connectionTimeoutMillis: 5000
    });
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    redis.on('error', error => console.error('Redis:', error.message));
    const postgres = new PostgresStorageAdapter({ client: pool });
    const idempotency = new PostgresIdempotencyStore({ client: pool });
    const cacheClient: RedisClientInterface = {
        get: key => redis.get(key),
        set: (key, value, ...args) => redis.set(key, value, 'PX', Number(args[1])),
        del: key => redis.del(...(Array.isArray(key) ? key : [key])),
        hset: (key, field, value) => typeof field === 'string'
            ? redis.hset(key, field, value!) : redis.hset(key, field)
    };
    const cache = new RedisStorageAdapter({ client: cacheClient, keyPrefix: 'tutorial:', recordContextChanges: false });

    // The engine may dispatch checkpoint writes without awaiting them. Serialize
    // those writes and drain them before acknowledging a successful HTTP request.
    // A failed write poisons this chain: restart the process after fixing storage.
    let writes: Promise<void> = Promise.resolve();
    const storage: StorageAdapter = {
        name: 'checkout-postgres-with-redis-cache',
        saveCheckpoint(checkpoint) {
            writes = writes.then(() => postgres.saveCheckpoint(checkpoint));
            return writes;
        },
        getCheckpoint: id => postgres.getCheckpoint(id),
        onContextChange: entry => postgres.onContextChange(entry),
        getCachedStep: key => cache.getCachedStep(key),
        setCachedStep: (key, value, ttl) => cache.setCachedStep(key, value, ttl)
    };
    try {
        await redis.connect();
        // Initialize once before replicas start (Compose's init service).
        // Host mode may initialize here when only one process starts at a time.
        await pool.query('SELECT 1');
        Step.useStorage(storage);
        return {
            pool, redis, postgres, idempotency,
            flush: () => writes,
            async close() {
                await writes.catch(console.error);
                redis.disconnect();
                await pool.end();
            }
        };
    } catch (error) {
        redis.disconnect();
        await pool.end();
        throw error;
    }
}

if (require.main === module) {
    connectInfrastructure().then(async infra => {
        try {
            await infra.postgres.ensureTables();
            await infra.idempotency.ensureTable();
        } finally { await infra.close(); }
    }).catch(error => { console.error(error); process.exitCode = 1; });
}
