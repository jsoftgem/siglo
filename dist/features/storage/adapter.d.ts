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
    onContextChange?(entry: ContextChangeEvent): Promise<void> | void;
    saveCheckpoint?(checkpoint: SerializedExecutionStack): Promise<void>;
    getCheckpoint?(stackId: string): Promise<SerializedExecutionStack | undefined>;
    cleanExpiredCheckpoints?(): Promise<number> | number | void;
    getCachedStep?(key: string): Promise<any | undefined>;
    setCachedStep?(key: string, value: any, ttlMs: number): Promise<void>;
    onCacheEvent?(event: CacheEvent): Promise<void> | void;
}
//# sourceMappingURL=adapter.d.ts.map