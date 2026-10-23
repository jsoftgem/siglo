export type StorageErrorMode = 'strict' | 'warn' | 'best-effort';

export interface PutChainContextMeta {
    stackId?: string;
    namespace?: string;
    [key: string]: any;
}

export interface StoragePlugins {
    getChainContext?: (chainId: string, field: string) => any;
    putChainContext?: (
        chainId: string,
        field: string,
        getter: () => any,
        meta?: PutChainContextMeta
    ) => void;
}

export interface StackRecord {
    type: string;
    chains: string[];
    namespace?: string;
    status?: 'running' | 'completed' | 'failed' | 'cancelled';
    workflowId?: string;
    expiresAt?: number;
    revision?: number;
    metadata?: Record<string, any>;
}

export interface StorageState {
    chains: Map<string, any>;
    contexts: Map<string, Record<string, any>>;
    stacks: Map<string, StackRecord>;
    cache: Map<string, Map<string, Map<string, any>>>;
    config: Record<string, any>;
    plugins: StoragePlugins;
}

export interface SerializedExecutionStack {
    version: number;
    schemaVersion?: string;
    stackId: string;
    workflowId?: string;
    namespace?: string;
    type: string;
    status?: 'running' | 'completed' | 'failed' | 'cancelled';
    revision: number;
    chains: string[];
    contexts: Record<string, Record<string, any>>;
    timestamp: number;
    expiresAt?: number;
    metadata?: Record<string, any>;
}

export interface SerializedStorageState {
    version: number;
    timestamp: number;
    config: Record<string, any>;
    stacks: Record<string, StackRecord>;
    contexts: Record<string, Record<string, any>>;
}

export function createInitialState(): StorageState {
    return {
        chains: new Map(),
        contexts: new Map(),
        stacks: new Map(),
        cache: new Map(),
        config: {},
        plugins: {}
    };
}
