import { StorageState, PutChainContextMeta, SerializedExecutionStack, SerializedStorageState, StorageErrorMode } from "./state";
import { StorageAdapter, CacheEvent } from "./adapter";
export { GetChainTypeException } from "./get";
export { PutChainTypeException } from "./put";
export { StorageState, PutChainContextMeta, SerializedExecutionStack, SerializedStorageState, StorageErrorMode } from "./state";
export { StorageAdapter, ContextChangeEvent, CacheEvent } from "./adapter";
export interface CheckpointOptions {
    ttlMs?: number;
    status?: 'running' | 'completed' | 'failed' | 'cancelled';
    workflowId?: string;
    redactFields?: string[];
    metadata?: Record<string, any>;
    expectedRevision?: number;
}
export declare function serializeParam(param: any): string;
export declare class StorageManager {
    private state;
    private adapter?;
    private revisions;
    private errorMode;
    constructor(initialState?: StorageState, options?: {
        errorMode?: StorageErrorMode;
    });
    getState(): StorageState;
    setErrorMode(mode: StorageErrorMode): void;
    getErrorMode(): StorageErrorMode;
    handleAdapterError(operation: string, error: unknown): void;
    useStorage(adapter: StorageAdapter): void;
    getStorageAdapter(): StorageAdapter | undefined;
    getChainContext(stepId: string, field: string): any;
    putChainContext(stepId: string, field: string, value: any, meta?: PutChainContextMeta | string): void;
    emitCacheEvent(event: CacheEvent): void;
    getChainDataById(stepId: string): any;
    createExecutionStack(tenantId?: string): string;
    createStack(stackIdOrTenant?: string, tenantId?: string): string;
    getStack(stackId: string): any;
    set(stackId: string, stepId: string, key: string, val: any): void;
    get(stackId: string, stepId: string): any;
    addChainToStack(stackId: string, stepId: string): void;
    cacheChainAction(stackId: string, stepId: string, param: any, result: any): void;
    hasCached(stackId: string, stepId: string, param: any): boolean;
    getCachedChainAction(stackId: string, stepId: string, param: any): any;
    clearCache(stackId: string, stepId: string): void;
    deleteStack(stackId: string): void;
    setChainConfig(config: any): void;
    getLogMonitor(): any;
    getPlugins(): any;
    setGetChainContextPlugin(plugin: any): void;
    setPutChainContextPlugin(plugin: any): void;
    clear(): void;
    snapshot(): Readonly<Record<string, any>>;
    cleanExpiredCheckpoints(): number;
    checkpoint(stackId: string, options?: CheckpointOptions): SerializedExecutionStack;
    saveCheckpoint(checkpointData: SerializedExecutionStack): Promise<void>;
    getCheckpoint(stackId: string): Promise<SerializedExecutionStack | undefined>;
    restoreCheckpoint(checkpointData: SerializedExecutionStack, options?: {
        expectedTenantId?: string;
        expectedWorkflowId?: string;
    }): string;
    serializeState(stackId?: string): string;
    hydrateState(serialized: string | SerializedStorageState | SerializedExecutionStack, options?: {
        expectedTenantId?: string;
    }): string | undefined;
}
interface StorageHolder {
    __$store: (id: string) => Record<string, any>;
}
export declare const defaultStorageManager: StorageManager;
export declare const storage: StorageHolder;
export declare function useStorage(adapter: StorageAdapter): void;
export declare function getStorageAdapter(): StorageAdapter | undefined;
export declare function setErrorMode(mode: StorageErrorMode): void;
export declare function getErrorMode(): StorageErrorMode;
export declare function cleanExpiredCheckpoints(): number;
export declare function getChainContext(stepId: string, field: string): any;
export declare function putChainContext(stepId: string, field: string, value: any, meta?: PutChainContextMeta | string): void;
export declare function getChainDataById(stepId: string): any;
export declare function createExecutionStack(tenantId?: string): string;
export declare function addChainToStack(stackId: string, stepId: string): void;
export declare function cacheChainAction(stackId: string, stepId: string, param: any, result: any): void;
export declare function hasCached(stackId: string, stepId: string, param: any): boolean;
export declare function getCachedChainAction(stackId: string, stepId: string, param: any): any;
export declare function clearCache(stackId: string, stepId: string): void;
export declare function deleteStack(stackId: string): void;
export declare function getStorage(): Readonly<Record<string, any>>;
export declare function clearStorage(): void;
export declare function setChainConfig(config: any): void;
export declare function getLogMonitor(): any;
export declare function getPlugins(): any;
export declare function setGetChainContextPlugin(plugin: any): void;
export declare function setPutChainContextPlugin(plugin: (stepId: string, field: string, getter: () => any, meta?: PutChainContextMeta) => void): void;
export declare function checkpoint(stackId: string, options?: CheckpointOptions): SerializedExecutionStack;
export declare function getCheckpoint(stackId: string): Promise<SerializedExecutionStack | undefined>;
export declare function restoreCheckpoint(checkpointData: SerializedExecutionStack, options?: {
    expectedTenantId?: string;
    expectedWorkflowId?: string;
}): string;
export declare function serializeState(stackId?: string): string;
export declare function hydrateState(serialized: string | SerializedStorageState | SerializedExecutionStack, options?: {
    expectedTenantId?: string;
}): string | undefined;
//# sourceMappingURL=index.d.ts.map