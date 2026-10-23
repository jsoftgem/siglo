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
    onContextChange?(entry: ContextChangeEvent): Promise<void> | void;
    saveCheckpoint?(checkpoint: SerializedExecutionStack): Promise<void>;
    getCheckpoint?(stackId: string): Promise<SerializedExecutionStack | undefined>;
    getCachedStep?(key: string): Promise<any | undefined>;
    setCachedStep?(key: string, value: any, ttlMs: number): Promise<void>;
}
//# sourceMappingURL=adapter.d.ts.map