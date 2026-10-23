import {
    StorageAdapter,
    ContextChangeEvent,
    SerializedExecutionStack,
    Step,
    defaultStorageManager
} from "fluid-func";
import { IRedisClient } from "../database/redis";
import { IMongoClient } from "../database/mongodb";

export interface ExecutionLogRecord {
    _id?: string;
    namespace?: string;
    stackId: string;
    chainId: string;
    field: string;
    value: any;
    timestamp: number;
}

export interface CheckpointRecord {
    _id?: string;
    stackId: string;
    namespace?: string;
    type: string;
    chains: string[];
    contexts: Record<string, any>;
    updatedAt: number;
}

/**
 * Unified Redis & MongoDB Storage Adapter for fluid-func (Modernized v2 Architecture):
 * - Telemetry & Event Streaming: onContextChange writes to Redis hash & logs to MongoDB.
 * - Distributed Checkpoints: saveCheckpoint & getCheckpoint durable saga state in MongoDB & Redis cache.
 * - Distributed Caching: getCachedStep & setCachedStep for memoized step actions in Redis.
 *
 * NOTE: Application step code closures are never stored in databases; they live in versioned application bundles.
 */
export class RedisMongoStorageAdapter implements StorageAdapter {
    readonly name = "RedisMongoStorageAdapter";
    private logsCollection;
    private checkpointsCollection;

    constructor(
        private readonly redis: IRedisClient,
        private readonly mongo: IMongoClient
    ) {
        this.logsCollection = this.mongo.collection<ExecutionLogRecord>("fluid_execution_logs");
        this.checkpointsCollection = this.mongo.collection<CheckpointRecord>("fluid_checkpoints");
    }

    async onContextChange(entry: ContextChangeEvent): Promise<void> {
        const { namespace, stackId, stepId, field, value, timestamp } = entry;
        const serialized = JSON.stringify(value ?? null);

        // Redis: Fast distributed context lookups
        await this.redis.hset(`fluid:context:${stepId}`, field, serialized).catch(console.error);
        if (stackId) {
            await this.redis.hset(`fluid:stack:${stackId}`, `${stepId}:${field}`, serialized).catch(console.error);
        }

        // MongoDB: Execution audit event log
        await this.logsCollection.insertOne({
            namespace,
            stackId,
            chainId: stepId,
            field,
            value,
            timestamp
        }).catch(console.error);
    }

    async saveCheckpoint(checkpoint: SerializedExecutionStack): Promise<void> {
        const stackId = checkpoint.stackId;
        const serialized = JSON.stringify(checkpoint);

        // Redis: Low-latency checkpoint cache
        await this.redis.set(`fluid:checkpoint:${stackId}`, serialized).catch(console.error);

        // MongoDB: Durable checkpoint record
        const record: CheckpointRecord = {
            stackId,
            namespace: checkpoint.namespace,
            type: checkpoint.type,
            chains: checkpoint.chains,
            contexts: checkpoint.contexts,
            updatedAt: Date.now()
        };
        const updateRes = await this.checkpointsCollection.updateOne(
            { stackId },
            { $set: record }
        ).catch(console.error);

        if (updateRes && updateRes.matchedCount === 0) {
            await this.checkpointsCollection.insertOne(record).catch(console.error);
        }
    }

    async getCheckpoint(stackId: string): Promise<SerializedExecutionStack | undefined> {
        // Try Redis first
        const cached = await this.redis.get(`fluid:checkpoint:${stackId}`).catch(() => null);
        if (cached) {
            try {
                return JSON.parse(cached);
            } catch {
                // fall through to Mongo
            }
        }

        // Fallback to MongoDB
        const doc = await this.checkpointsCollection.findOne({ stackId }).catch(() => null);
        if (doc) {
            return {
                stackId: doc.stackId,
                namespace: doc.namespace,
                type: doc.type,
                chains: doc.chains,
                contexts: doc.contexts
            };
        }
        return undefined;
    }

    async getCachedStep(key: string): Promise<any | undefined> {
        const raw = await this.redis.get(`fluid:cache:${key}`).catch(() => null);
        if (!raw) return undefined;
        try {
            return JSON.parse(raw);
        } catch {
            return raw;
        }
    }

    async setCachedStep(key: string, value: any, ttlMs: number): Promise<void> {
        const serialized = JSON.stringify(value ?? null);
        const ttlSec = ttlMs > 0 ? Math.ceil(ttlMs / 1000) : undefined;
        await this.redis.set(`fluid:cache:${key}`, serialized, ttlSec).catch(console.error);
    }
}

/**
 * Registers Redis & MongoDB as the unified storage provider for fluid-func.
 */
export function registerRedisMongoStorage(redis: IRedisClient, mongo: IMongoClient): RedisMongoStorageAdapter {
    const adapter = new RedisMongoStorageAdapter(redis, mongo);
    Step.useStorage(adapter);
    console.log("[StoragePlugin] Successfully registered Redis & MongoDB storage adapter for fluid-func.");
    return adapter;
}
