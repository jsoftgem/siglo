export interface PutChainContextMeta {
    stackId?: string;
    tenantId?: string;
    [key: string]: any;
}
export interface StoragePlugins {
    getChainContext?: (chainId: string, field: string) => any;
    putChainContext?: (chainId: string, field: string, getter: () => any, meta?: PutChainContextMeta) => void;
}
export interface StorageState {
    chains: Map<string, any>;
    contexts: Map<string, Record<string, any>>;
    stacks: Map<string, {
        type: string;
        chains: string[];
        tenantId?: string;
    }>;
    cache: Map<string, Map<string, Map<string, any>>>;
    config: Record<string, any>;
    plugins: StoragePlugins;
}
export interface SerializedExecutionStack {
    stackId: string;
    tenantId?: string;
    type: string;
    chains: string[];
    contexts: Record<string, Record<string, any>>;
    timestamp: number;
}
export interface SerializedStorageState {
    version: number;
    timestamp: number;
    config: Record<string, any>;
    stacks: Record<string, {
        type: string;
        chains: string[];
        tenantId?: string;
    }>;
    contexts: Record<string, Record<string, any>>;
}
export declare function createInitialState(): StorageState;
//# sourceMappingURL=state.d.ts.map