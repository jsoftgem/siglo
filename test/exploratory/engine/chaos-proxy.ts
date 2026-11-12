import { RandomSource } from './property-generators';
import {
    StorageAdapter,
    SerializedExecutionStack,
    ContextChangeEvent,
    CacheEvent,
    CheckpointConflictException,
} from '@siglo/core';

export interface ChaosConfig {
    failureRate?: number; // 0.0 to 1.0 probability of injected fault
    minLatencyMs?: number;
    maxLatencyMs?: number;
    conflictRate?: number; // Probability of throwing CheckpointConflictException
    corruptionRate?: number; // Probability of returning corrupted JSON/checkpoint
}

export class ChaosStorageProxy implements StorageAdapter {
    readonly name: string = 'chaos-storage-proxy';
    private underlying: StorageAdapter;
    private config: Required<ChaosConfig>;
    public callCounts: {
        saveCheckpoint: number;
        getCheckpoint: number;
        getCachedStep: number;
        setCachedStep: number;
    } = { saveCheckpoint: 0, getCheckpoint: 0, getCachedStep: 0, setCachedStep: 0 };

    public activeConcurrentOps: number = 0;
    public highWaterMark: number = 0;

    constructor(
        underlying: StorageAdapter,
        config: ChaosConfig = {},
        private rng = new RandomSource(42),
    ) {
        this.underlying = underlying;
        this.config = {
            failureRate: config.failureRate ?? 0,
            minLatencyMs: config.minLatencyMs ?? 0,
            maxLatencyMs: config.maxLatencyMs ?? 0,
            conflictRate: config.conflictRate ?? 0,
            corruptionRate: config.corruptionRate ?? 0,
        };
    }

    public faultSchedule: Array<{ operation: string; latencyMs: number; fault?: string }> = [];

    private async injectChaos(operation: string): Promise<void> {
        const event: { operation: string; latencyMs: number; fault?: string } = { operation, latencyMs: 0 };
        this.faultSchedule.push(event);
        this.activeConcurrentOps++;
        if (this.activeConcurrentOps > this.highWaterMark) {
            this.highWaterMark = this.activeConcurrentOps;
        }

        try {
            // Latency injection
            if (this.config.maxLatencyMs > 0) {
                const latency = Math.floor(
                    this.rng.nextFloat() * (this.config.maxLatencyMs - this.config.minLatencyMs + 1) +
                        this.config.minLatencyMs,
                );
                event.latencyMs = latency;
                if (latency > 0) {
                    await new Promise(r => setTimeout(r, latency));
                }
            }

            // Injected network / connection failures
            if (this.config.failureRate > 0 && this.rng.nextFloat() < this.config.failureRate) {
                event.fault = 'ECONNRESET';
                const err = new Error('ECONNRESET: Connection reset by peer (Injected Chaos)');
                (err as any).code = 'ECONNRESET';
                throw err;
            }

            // Injected optimistic concurrency conflicts
            if (this.config.conflictRate > 0 && this.rng.nextFloat() < this.config.conflictRate) {
                event.fault = 'CheckpointConflictException';
                throw new CheckpointConflictException('chaos-injected', 1, 2, {});
            }
        } finally {
            this.activeConcurrentOps--;
        }
    }

    async saveCheckpoint(checkpoint: SerializedExecutionStack): Promise<void> {
        this.callCounts.saveCheckpoint++;
        await this.injectChaos('saveCheckpoint');
        if (this.underlying.saveCheckpoint) {
            return this.underlying.saveCheckpoint(checkpoint);
        }
    }

    async getCheckpoint(stackId: string): Promise<SerializedExecutionStack | undefined> {
        this.callCounts.getCheckpoint++;
        await this.injectChaos('getCheckpoint');
        if (this.underlying.getCheckpoint) {
            const result = await this.underlying.getCheckpoint(stackId);
            if (result && this.config.corruptionRate > 0 && this.rng.nextFloat() < this.config.corruptionRate) {
                // Return slightly corrupted checkpoint to test boundary resilience
                const corrupted = { ...result } as any;
                corrupted.schemaVersion = '999.0.0-corrupted';
                this.faultSchedule.push({ operation: 'getCheckpoint', latencyMs: 0, fault: 'corrupt-schema-version' });
                return corrupted;
            }
            return result;
        }
        return undefined;
    }

    async getCachedStep(key: string): Promise<any | undefined> {
        this.callCounts.getCachedStep++;
        await this.injectChaos('getCachedStep');
        return this.underlying.getCachedStep?.(key);
    }

    async setCachedStep(key: string, value: any, ttlMs: number): Promise<void> {
        this.callCounts.setCachedStep++;
        await this.injectChaos('setCachedStep');
        return this.underlying.setCachedStep?.(key, value, ttlMs);
    }

    async onContextChange(entry: ContextChangeEvent): Promise<void> {
        return this.underlying.onContextChange?.(entry);
    }

    async onCacheEvent(event: CacheEvent): Promise<void> {
        return this.underlying.onCacheEvent?.(event);
    }

    resetMetrics(): void {
        this.faultSchedule = [];
        this.callCounts = { saveCheckpoint: 0, getCheckpoint: 0, getCachedStep: 0, setCachedStep: 0 };
        this.activeConcurrentOps = 0;
        this.highWaterMark = 0;
    }
}
