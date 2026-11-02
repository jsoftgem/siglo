import { SerializedExecutionStack } from './state';

export interface ContextChangeEvent {
    namespace?: string;
    stackId: string;
    stepId: string;
    field: string;
    value: any;
    timestamp: number;
}

export interface CacheEvent {
    type: 'hit' | 'miss';
    key: string;
    stepId: string;
    stackId?: string;
    namespace?: string;
    timestamp: number;
}

export interface StorageAdapter {
    name: string;

    // 1. Context & Event Streaming
    onContextChange?(entry: ContextChangeEvent): Promise<void> | void;

    // 2. Checkpointing & Durability
    saveCheckpoint?(checkpoint: SerializedExecutionStack): Promise<void>;
    getCheckpoint?(stackId: string): Promise<SerializedExecutionStack | undefined>;
    cleanExpiredCheckpoints?(): Promise<number> | number | void;

    // 3. Durable Wait Persistence
    saveWaitRecord?(record: any): Promise<void> | void;
    getWaitRecord?(correlationKeyOrStackId: string): Promise<any | undefined>;
    claimWaitRecord?(correlationKey: string, claimantId?: string): Promise<any>;

    // 4. Distributed Caching
    getCachedStep?(key: string): Promise<any | undefined>;
    setCachedStep?(key: string, value: any, ttlMs: number): Promise<void>;

    // 5. Cache & Telemetry Events
    onCacheEvent?(event: CacheEvent): Promise<void> | void;
}
