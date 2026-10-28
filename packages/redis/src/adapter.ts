import { StorageAdapter, SerializedExecutionStack } from 'rivulet';
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
        this.keyPrefix = options.keyPrefix || 'rivulet:';
        this.cacheTtlMs = options.cacheTtlMs || 86400000; // 24 hours
        this.checkpointTtlMs = options.checkpointTtlMs || 604800000; // 7 days
        this.recordContextChanges = options.recordContextChanges ?? true;
    }

    private cacheKey(key: string): string {
        return `${this.keyPrefix}cache:${key}`;
    }

    private checkpointKey(stackId: string): string {
        return `${this.keyPrefix}checkpoint:${stackId}`;
    }

    private contextKey(stackId: string, stepId: string): string {
        return `${this.keyPrefix}context:${stackId}:${stepId}`;
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
            const key = this.contextKey(entry.stackId, entry.stepId);
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
        const key = this.checkpointKey(checkpoint.stackId);
        const serialized = JSON.stringify(checkpoint);
        await this.client.set(key, serialized, 'PX', this.checkpointTtlMs);
    }

    async getCheckpoint(stackId: string): Promise<SerializedExecutionStack | undefined> {
        if (!stackId) {
            return undefined;
        }
        const key = this.checkpointKey(stackId);
        const data = await this.client.get(key);
        if (!data) {
            return undefined;
        }
        try {
            return JSON.parse(data) as SerializedExecutionStack;
        } catch {
            return undefined;
        }
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
