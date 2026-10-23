import {
    getChainContext as gcc,
    getChainDataById as gcdbi,
    getLogMonitor as _getLogMonitor,
    getPlugins as _getPlugins,
    setGetChainContextPlugin as _setGetChainContextPlugin
} from "./get";
import {
    putChainContext as pcc,
    setChainConfig as _setChainConfig,
    setPutChainContextPlugin as _setPutChainContextPlugin
} from "./put";
import { CHAIN_CONFIG } from "./constants";
import {
    StorageState,
    createInitialState,
    PutChainContextMeta,
    SerializedExecutionStack,
    SerializedStorageState
} from "./state";
import { generateUUID } from "../../shared";
import { StorageAdapter } from "./adapter";

export { GetChainTypeException } from "./get";
export { PutChainTypeException } from "./put";
export { StorageState, PutChainContextMeta, SerializedExecutionStack, SerializedStorageState } from "./state";
export { StorageAdapter, ContextChangeEvent } from "./adapter";

export function serializeParam(param: any): string {
    if (param === null || param === undefined) {
        return String(param);
    }
    if (typeof param !== "object") {
        return JSON.stringify(param);
    }
    const seen = new WeakSet();
    const clean = (val: any): any => {
        if (val === null || typeof val !== "object") {
            return val;
        }
        if (seen.has(val)) {
            return "[Circular]";
        }
        seen.add(val);
        if (Array.isArray(val)) {
            return val.map(clean);
        }
        const sortedKeys = Object.keys(val).sort();
        const obj: Record<string, any> = {};
        for (const key of sortedKeys) {
            obj[key] = clean(val[key]);
        }
        return obj;
    };
    try {
        return JSON.stringify(clean(param));
    } catch {
        return String(param);
    }
}

export class StorageManager {
    private state: StorageState;
    private adapter?: StorageAdapter;

    constructor(initialState?: StorageState) {
        this.state = initialState || createInitialState();
    }

    getState(): StorageState {
        return this.state;
    }

    useStorage(adapter: StorageAdapter): void {
        this.adapter = adapter;
    }

    getStorageAdapter(): StorageAdapter | undefined {
        return this.adapter;
    }

    getChainContext(stepId: string, field: string): any {
        return gcc(this.state, stepId, field);
    }

    putChainContext(stepId: string, field: string, value: any, meta?: PutChainContextMeta | string): void {
        pcc(this.state, stepId, field, value, meta);

        if (this.adapter?.onContextChange) {
            let tenantId: string | undefined;
            let stackId: string | undefined;
            if (typeof meta === "string") {
                stackId = meta;
            } else if (meta) {
                stackId = meta.stackId;
                tenantId = meta.tenantId;
            }
            if (!stackId) {
                for (const [sId, stack] of this.state.stacks.entries()) {
                    if (stack.chains && stack.chains.includes(stepId)) {
                        stackId = sId;
                        tenantId = tenantId || stack.tenantId;
                        break;
                    }
                }
            } else if (!tenantId) {
                const stack = this.state.stacks.get(stackId);
                if (stack?.tenantId) {
                    tenantId = stack.tenantId;
                }
            }
            try {
                const res = this.adapter.onContextChange({
                    tenantId,
                    stackId: stackId || "",
                    stepId,
                    field,
                    value,
                    timestamp: Date.now()
                });
                if (res && typeof (res as any).catch === "function") {
                    (res as any).catch(() => {});
                }
            } catch {
                // Ignore adapter errors to preserve execution flow
            }
        }
    }

    getChainDataById(stepId: string): any {
        return gcdbi(this.state, stepId);
    }

    createExecutionStack(tenantId?: string): string {
        const stackId = generateUUID();
        this.state.stacks.set(stackId, {
            type: "execution",
            chains: [],
            tenantId
        });
        return stackId;
    }

    createStack(stackIdOrTenant?: string, tenantId?: string): string {
        let stackId: string;
        let effectiveTenantId: string | undefined;
        if (tenantId !== undefined) {
            stackId = stackIdOrTenant || generateUUID();
            effectiveTenantId = tenantId;
        } else {
            stackId = stackIdOrTenant || generateUUID();
        }
        this.state.stacks.set(stackId, {
            type: "execution",
            chains: [],
            tenantId: effectiveTenantId
        });
        return stackId;
    }

    getStack(stackId: string): { type: string; chains: string[]; tenantId?: string } | undefined {
        return this.state.stacks.get(stackId);
    }

    set(stackId: string, stepId: string, key: string, val: any): void {
        const stack = this.state.stacks.get(stackId);
        if (stack && !stack.chains.includes(stepId)) {
            stack.chains.push(stepId);
        }
        this.putChainContext(stepId, key, val, { stackId, tenantId: stack?.tenantId });
    }

    get(stackId: string, stepId: string): any {
        const raw = this.getChainDataById(stepId);
        if (!raw) {
            return raw;
        }
        const res: Record<string, any> = {};
        for (const [k, v] of Object.entries(raw)) {
            res[k] = (typeof v === "function" && (v as any).val !== undefined) ? (v as any).val : (typeof v === "function" ? v() : v);
        }
        return res;
    }

    addChainToStack(stackId: string, stepId: string): void {
        const stack = this.state.stacks.get(stackId);
        if (stack) {
            stack.chains.push(stepId);
        }
    }

    cacheChainAction(stackId: string, stepId: string, param: any, result: any): void {
        let stackCache = this.state.cache.get(stackId);
        if (!stackCache) {
            stackCache = new Map();
            this.state.cache.set(stackId, stackCache);
        }
        let chainCache = stackCache.get(stepId);
        if (!chainCache) {
            chainCache = new Map();
            stackCache.set(stepId, chainCache);
        }
        chainCache.set(serializeParam(param), {
            result,
            timestamp: Date.now()
        });
    }

    hasCached(stackId: string, stepId: string, param: any): boolean {
        const stackCache = this.state.cache.get(stackId);
        if (!stackCache) {
            return false;
        }
        const chainCache = stackCache.get(stepId);
        if (!chainCache) {
            return false;
        }
        return chainCache.has(serializeParam(param));
    }

    getCachedChainAction(stackId: string, stepId: string, param: any): any {
        const stackCache = this.state.cache.get(stackId);
        if (!stackCache) {
            return undefined;
        }
        const chainCache = stackCache.get(stepId);
        if (!chainCache) {
            return undefined;
        }
        return chainCache.get(serializeParam(param));
    }

    clearCache(stackId: string, stepId: string): void {
        const stackCache = this.state.cache.get(stackId);
        if (stackCache) {
            stackCache.delete(stepId);
        }
    }

    deleteStack(stackId: string): void {
        const stack = this.state.stacks.get(stackId);
        if (stack) {
            if (stack.chains) {
                stack.chains.forEach((stepId: string) => {
                    this.state.contexts.delete(stepId);
                });
            }
            this.state.stacks.delete(stackId);
        }
        this.state.cache.delete(stackId);
    }

    setChainConfig(config: any): void {
        _setChainConfig(this.state, config);
    }

    getLogMonitor(): any {
        return _getLogMonitor(this.state);
    }

    getPlugins(): any {
        return _getPlugins(this.state);
    }

    setGetChainContextPlugin(plugin: any): void {
        _setGetChainContextPlugin(this.state, plugin);
    }

    setPutChainContextPlugin(plugin: any): void {
        _setPutChainContextPlugin(this.state, plugin);
    }

    clear(): void {
        this.state = createInitialState();
        this.adapter = undefined;
    }

    snapshot(): Readonly<Record<string, any>> {
        const snap: Record<string, any> = {
            [CHAIN_CONFIG]: this.state.config
        };
        for (const [key, value] of this.state.contexts) {
            snap[key] = value;
        }
        for (const [key, value] of this.state.stacks) {
            snap[key] = value;
        }
        return Object.freeze(snap);
    }

    checkpoint(stackId: string): SerializedExecutionStack {
        const stack = this.state.stacks.get(stackId);
        if (!stack) {
            throw new Error(`Execution stack \x27${stackId}\x27 not found.`);
        }
        const contexts: Record<string, Record<string, any>> = {};
        if (stack.chains) {
            for (const stepId of stack.chains) {
                const ctx = this.state.contexts.get(stepId);
                if (ctx) {
                    const rawCtx: Record<string, any> = {};
                    for (const [key, fnOrVal] of Object.entries(ctx)) {
                        if (key !== "$$$validators") {
                            rawCtx[key] = typeof fnOrVal === "function" ? fnOrVal() : fnOrVal;
                        }
                    }
                    contexts[stepId] = rawCtx;
                }
            }
        }
        const snapshot: SerializedExecutionStack = {
            stackId,
            tenantId: stack.tenantId,
            type: stack.type,
            chains: [...stack.chains],
            contexts,
            timestamp: Date.now()
        };

        if (this.adapter?.saveCheckpoint) {
            try {
                const res = this.adapter.saveCheckpoint(snapshot);
                if (res && typeof (res as any).catch === "function") {
                    (res as any).catch(() => {});
                }
            /* c8 ignore next 3 */
            } catch {
                // Ignore adapter errors
            }
        }

        return snapshot;
    }

    async getCheckpoint(stackId: string): Promise<SerializedExecutionStack | undefined> {
        if (this.adapter?.getCheckpoint) {
            try {
                const fromAdapter = await this.adapter.getCheckpoint(stackId);
                if (fromAdapter) {
                    return fromAdapter;
                }
            } catch {
                // Fallback to in-memory stack
            }
        }
        if (this.state.stacks.has(stackId)) {
            return this.checkpoint(stackId);
        }
        return undefined;
    }

    restoreCheckpoint(checkpointData: SerializedExecutionStack): string {
        if (!checkpointData || !checkpointData.stackId) {
            throw new Error("Invalid checkpoint data.");
        }
        this.state.stacks.set(checkpointData.stackId, {
            type: checkpointData.type || "execution",
            chains: Array.isArray(checkpointData.chains) ? [...checkpointData.chains] : [],
            tenantId: checkpointData.tenantId
        });
        if (checkpointData.contexts) {
            for (const [stepId, fields] of Object.entries(checkpointData.contexts)) {
                if (fields && typeof fields === "object") {
                    for (const [field, value] of Object.entries(fields)) {
                        this.putChainContext(stepId, field, value, {
                            stackId: checkpointData.stackId,
                            tenantId: checkpointData.tenantId
                        });
                    }
                }
            }
        }
        return checkpointData.stackId;
    }

    serializeState(stackId?: string): string {
        if (stackId) {
            return JSON.stringify(this.checkpoint(stackId));
        }
        const stacks: Record<string, { type: string; chains: string[]; tenantId?: string }> = {};
        for (const [sId, sVal] of this.state.stacks.entries()) {
            stacks[sId] = {
                type: sVal.type,
                chains: [...sVal.chains],
                tenantId: sVal.tenantId
            };
        }
        const contexts: Record<string, Record<string, any>> = {};
        for (const [cId, ctx] of this.state.contexts.entries()) {
            const rawCtx: Record<string, any> = {};
            for (const [key, fnOrVal] of Object.entries(ctx)) {
                if (key !== "$$$validators") {
                    rawCtx[key] = typeof fnOrVal === "function" ? fnOrVal() : fnOrVal;
                }
            }
            contexts[cId] = rawCtx;
        }
        const stateObj: SerializedStorageState = {
            version: 1,
            timestamp: Date.now(),
            config: this.state.config ? { ...this.state.config } : {},
            stacks,
            contexts
        };
        return JSON.stringify(stateObj);
    }

    hydrateState(serialized: string | SerializedStorageState | SerializedExecutionStack): string | undefined {
        if (!serialized) {
            throw new Error("Cannot hydrate empty state.");
        }
        const data = typeof serialized === "string" ? JSON.parse(serialized) : serialized;
        let restoredId: string | undefined;
        if (data.stackId) {
            return this.restoreCheckpoint(data as SerializedExecutionStack);
        }
        if (data.config) {
            this.setChainConfig(data.config);
        }
        if (data.stacks) {
            for (const [sId, sVal] of Object.entries(data.stacks as Record<string, any>)) {
                if (!restoredId) {
                    restoredId = sId;
                }
                this.state.stacks.set(sId, {
                    type: sVal.type || "execution",
                    chains: Array.isArray(sVal.chains) ? [...sVal.chains] : [],
                    tenantId: sVal.tenantId
                });
            }
        }
        if (data.contexts) {
            for (const [stepId, fields] of Object.entries(data.contexts as Record<string, any>)) {
                if (fields && typeof fields === "object") {
                    for (const [field, value] of Object.entries(fields)) {
                        this.putChainContext(stepId, field, value);
                    }
                }
            }
        }
        return restoredId;
    }
}

const STORE_ID = generateUUID();

interface StorageHolder {
    __$store: (id: string) => Record<string, any>;
}

export const defaultStorageManager = new StorageManager();

export const storage: StorageHolder = {
    __$store: (id: string) => {
        if (id !== STORE_ID) {
            throw new Error("Unauthorized storage access");
        }
        return defaultStorageManager.snapshot();
    }
};

export function useStorage(adapter: StorageAdapter): void {
    defaultStorageManager.useStorage(adapter);
}

export function getStorageAdapter(): StorageAdapter | undefined {
    return defaultStorageManager.getStorageAdapter();
}

export function getChainContext(stepId: string, field: string): any {
    return defaultStorageManager.getChainContext(stepId, field);
}

export function putChainContext(stepId: string, field: string, value: any, meta?: PutChainContextMeta | string): void {
    defaultStorageManager.putChainContext(stepId, field, value, meta);
}

export function getChainDataById(stepId: string): any {
    return defaultStorageManager.getChainDataById(stepId);
}

export function createExecutionStack(tenantId?: string): string {
    return defaultStorageManager.createExecutionStack(tenantId);
}

export function addChainToStack(stackId: string, stepId: string): void {
    defaultStorageManager.addChainToStack(stackId, stepId);
}

export function cacheChainAction(stackId: string, stepId: string, param: any, result: any): void {
    defaultStorageManager.cacheChainAction(stackId, stepId, param, result);
}

export function hasCached(stackId: string, stepId: string, param: any): boolean {
    return defaultStorageManager.hasCached(stackId, stepId, param);
}

export function getCachedChainAction(stackId: string, stepId: string, param: any): any {
    return defaultStorageManager.getCachedChainAction(stackId, stepId, param);
}

export function clearCache(stackId: string, stepId: string): void {
    defaultStorageManager.clearCache(stackId, stepId);
}

export function deleteStack(stackId: string): void {
    defaultStorageManager.deleteStack(stackId);
}

export function getStorage(): Readonly<Record<string, any>> {
    return defaultStorageManager.snapshot();
}

export function clearStorage(): void {
    defaultStorageManager.clear();
}

export function setChainConfig(config: any): void {
    defaultStorageManager.setChainConfig(config);
}

export function getLogMonitor(): any {
    return defaultStorageManager.getLogMonitor();
}

export function getPlugins(): any {
    return defaultStorageManager.getPlugins();
}

export function setGetChainContextPlugin(plugin: any): void {
    defaultStorageManager.setGetChainContextPlugin(plugin);
}

export function setPutChainContextPlugin(plugin: (stepId: string, field: string, getter: () => any, meta?: PutChainContextMeta) => void): void {
    defaultStorageManager.setPutChainContextPlugin(plugin);
}

export function checkpoint(stackId: string): SerializedExecutionStack {
    return defaultStorageManager.checkpoint(stackId);
}

export function getCheckpoint(stackId: string): Promise<SerializedExecutionStack | undefined> {
    return defaultStorageManager.getCheckpoint(stackId);
}

export function restoreCheckpoint(checkpointData: SerializedExecutionStack): string {
    return defaultStorageManager.restoreCheckpoint(checkpointData);
}

export function serializeState(stackId?: string): string {
    return defaultStorageManager.serializeState(stackId);
}

export function hydrateState(serialized: string | SerializedStorageState | SerializedExecutionStack): string | undefined {
    return defaultStorageManager.hydrateState(serialized);
}
