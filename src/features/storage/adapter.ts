import { SerializedExecutionStack } from './state';

export interface ContextChangeEvent {
    tenantId?: string;
    stackId: string;
    stepId: string;
    field: string;
    value: any;
    timestamp: number;
}

export interface StorageAdapter {
    name: string;

    // 1. Context & Event Streaming
    onContextChange?(entry: ContextChangeEvent): Promise<void> | void;

    // 2. Checkpointing & Durability
    saveCheckpoint?(checkpoint: SerializedExecutionStack): Promise<void>;
    getCheckpoint?(stackId: string): Promise<SerializedExecutionStack | undefined>;

    // 3. Distributed Caching
    getCachedStep?(key: string): Promise<any | undefined>;
    setCachedStep?(key: string, value: any, ttlMs: number): Promise<void>;
}
