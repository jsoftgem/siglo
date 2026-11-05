import { StorageAdapter, SerializedExecutionStack } from '@siglo/core';
import { RedisStorageAdapterOptions, RedisClientInterface } from './types';

export class RedisStorageAdapter implements StorageAdapter {
    public readonly name = 'redis';
    private client: RedisClientInterface;
    private keyPrefix: string;
    private cacheTtlMs: number;
    private checkpointTtlMs: number;
    private recordContextChanges: boolean;

    constructor(options: RedisStorageAdapterOptions) {
        if (!options || !options.client) {
            throw new Error('RedisStorageAdapter requires a valid Redis client instance.');
        }
        this.client = options.client;
        this.keyPrefix = options.keyPrefix || 'siglo:';
        this.cacheTtlMs = options.cacheTtlMs || 86400000; // 24 hours
        this.checkpointTtlMs = options.checkpointTtlMs || 604800000; // 7 days
        this.recordContextChanges = options.recordContextChanges ?? true;
    }

    private cacheKey(key: string): string {
        return `${this.keyPrefix}cache:${key}`;
    }

    private checkpointKey(stackId: string, namespace?: string): string {
        return namespace
            ? `${this.keyPrefix}${namespace}:checkpoint:${stackId}`
            : `${this.keyPrefix}checkpoint:${stackId}`;
    }

    private waitRecordKey(key: string): string {
        return `${this.keyPrefix}wait:${key}`;
    }

    private contextKey(stackId: string, stepId: string, namespace?: string): string {
        return namespace
            ? `${this.keyPrefix}${namespace}:context:${stackId}:${stepId}`
            : `${this.keyPrefix}context:${stackId}:${stepId}`;
    }

    async onContextChange(entry: {
        namespace?: string;
        stackId: string;
        stepId: string;
        field: string;
        value: any;
        timestamp: number;
    }): Promise<void> {
        if (!this.recordContextChanges) {
            return;
        }
        try {
            const key = this.contextKey(entry.stackId, entry.stepId, entry.namespace);
            const serialized = typeof entry.value === 'object' && entry.value !== null
                ? JSON.stringify(entry.value)
                : String(entry.value ?? '');

            await this.client.hset(key, entry.field, serialized);
            if (this.client.pexpire) {
                await this.client.pexpire(key, this.checkpointTtlMs);
            }
        } catch {
            // Non-blocking telemetry error: silently ignore to protect execution flow
        }
    }

    async saveCheckpoint(checkpoint: SerializedExecutionStack): Promise<void> {
        if (!checkpoint || !checkpoint.stackId) {
            return;
        }
        const key = this.checkpointKey(checkpoint.stackId, checkpoint.namespace);
        const serialized = JSON.stringify(checkpoint);
        await this.client.set(key, serialized, 'PX', this.checkpointTtlMs);
    }

    async getCheckpoint(stackId: string, namespace?: string): Promise<SerializedExecutionStack | undefined> {
        if (!stackId) {
            return undefined;
        }
        let data: string | null = null;
        if (namespace) {
            data = await this.client.get(this.checkpointKey(stackId, namespace));
        }
        if (!data) {
            data = await this.client.get(this.checkpointKey(stackId));
        }
        if (!data) {
            return undefined;
        }
        try {
            return JSON.parse(data) as SerializedExecutionStack;
        } catch {
            return undefined;
        }
    }

    async cleanExpiredCheckpoints(): Promise<number> {
        return 0; // Handled automatically by Redis TTL expiration
    }

    async saveWaitRecord(record: any): Promise<void> {
        if (!record || (!record.correlationKey && !record.stackId)) {
            return;
        }
        const serialized = JSON.stringify(record);
        if (record.correlationKey) {
            await this.client.set(this.waitRecordKey(record.correlationKey), serialized, 'PX', this.checkpointTtlMs);
        }
        if (record.stackId) {
            await this.client.set(this.waitRecordKey(record.stackId), serialized, 'PX', this.checkpointTtlMs);
        }
    }

    async getWaitRecord(correlationKeyOrStackId: string): Promise<any | undefined> {
        if (!correlationKeyOrStackId) {
            return undefined;
        }
        const data = await this.client.get(this.waitRecordKey(correlationKeyOrStackId));
        if (data) {
            try {
                return JSON.parse(data);
            } catch {
                return undefined;
            }
        }
        const cp = await this.getCheckpoint(correlationKeyOrStackId);
        return cp?.metadata?.waitRecord;
    }

    async getCachedStep(key: string): Promise<any | undefined> {
        if (!key) {
            return undefined;
        }
        const fullKey = this.cacheKey(key);
        const data = await this.client.get(fullKey);
        if (!data) {
            return undefined;
        }
        try {
            return JSON.parse(data);
        } catch {
            return data;
        }
    }

    async setCachedStep(key: string, value: any, ttlMs?: number): Promise<void> {
        if (!key) {
            return;
        }
        const fullKey = this.cacheKey(key);
        const effectiveTtl = ttlMs || this.cacheTtlMs;
        const serialized = typeof value === 'object' && value !== null ? JSON.stringify(value) : JSON.stringify({ value });
        await this.client.set(fullKey, serialized, 'PX', effectiveTtl);
    }
}
