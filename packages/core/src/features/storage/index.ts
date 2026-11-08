function redactValue(val: any, redactList: Set<string>): any {
    if (val === null || typeof val !== 'object') {
        return val;
    }
    if (Array.isArray(val)) {
        return val.map(item => redactValue(item, redactList));
    }
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
        if (redactList.has(k)) {
            result[k] = '[REDACTED]';
        } else {
            result[k] = redactValue(v, redactList);
        }
    }
    return result;
}

import {
    getChainContext as gcc,
    getChainDataById as gcdbi,
    getLogMonitor as _getLogMonitor,
    getPlugins as _getPlugins,
    setGetChainContextPlugin as _setGetChainContextPlugin,
} from './get';
import {
    putChainContext as pcc,
    setChainConfig as _setChainConfig,
    setPutChainContextPlugin as _setPutChainContextPlugin,
} from './put';
import { CHAIN_CONFIG } from './constants';
import {
    StorageState,
    createInitialState,
    PutChainContextMeta,
    SerializedExecutionStack,
    SerializedStorageState,
    StorageErrorMode,
} from './state';
import { generateUUID, Status, VALIDATORS } from '../../shared';
import { StorageAdapter, CacheEvent, ContextChangeEvent } from './adapter';
import {
    CheckpointConflictException,
    NamespaceMismatchException,
    CheckpointVersionException,
    StorageAdapterException,
} from '../executer';
import { emitMonitoringEvent } from '../events/emitter';
import { defaultCompensationManager } from '../compensation';
import { toPOJO } from '../context/proxy';

export { GetChainTypeException } from './get';
export { PutChainTypeException } from './put';
export {
    StorageState,
    PutChainContextMeta,
    SerializedExecutionStack,
    SerializedStorageState,
    StorageErrorMode,
} from './state';
export { StorageAdapter, ContextChangeEvent, CacheEvent } from './adapter';

export interface CheckpointOptions {
    ttlMs?: number;
    status?: 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting';
    workflowId?: string;
    redactFields?: string[];
    metadata?: Record<string, any>;
    expectedRevision?: number;
}

export function serializeParam(param: any): string {
    if (param === null || param === undefined) {
        return String(param);
    }
    if (typeof param !== 'object') {
        return JSON.stringify(param);
    }
    const seen = new WeakSet();
    const clean = (val: any): any => {
        if (val === null || typeof val !== 'object') {
            return val;
        }
        if (seen.has(val)) {
            return '[Circular]';
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
    private revisions = new Map<string, number>();
    private errorMode: StorageErrorMode = 'best-effort';

    constructor(initialState?: StorageState, options?: { errorMode?: StorageErrorMode }) {
        this.state = initialState || createInitialState();
        if (options?.errorMode) {
            this.errorMode = options.errorMode;
        }
    }

    getState(): StorageState {
        return this.state;
    }

    setErrorMode(mode: StorageErrorMode): void {
        this.errorMode = mode;
    }

    getErrorMode(): StorageErrorMode {
        return this.errorMode;
    }

    handleAdapterError(operation: string, error: unknown): void {
        if (this.errorMode === 'strict') {
            throw new StorageAdapterException(operation, this.adapter?.name, error);
        }
        if (this.errorMode === 'warn') {
            const msg = `Storage adapter '${this.adapter?.name || 'unknown'}' warning during '${operation}': ${(error as any)?.message || error}`;
            console.warn(msg);
        }
        // best-effort: silently ignore
    }

    useStorage(adapter: StorageAdapter): void {
        this.adapter = adapter;
    }

    getStorageAdapter(): StorageAdapter | undefined {
        return this.adapter;
    }

    getAdapter(): StorageAdapter | undefined {
        return this.adapter;
    }

    getChainContext(stepId: string, field: string): any {
        return gcc(this.state, stepId, field);
    }

    putChainContext(stepId: string, field: string, value: any, meta?: PutChainContextMeta | string): void {
        pcc(this.state, stepId, field, value, meta);

        let namespace: string | undefined;
        let stackId: string | undefined;
        let stackObj: any;
        if (typeof meta === 'string') {
            stackId = meta;
        } else if (meta) {
            stackId = meta.stackId;
            namespace = meta.namespace;
        }
        if (!stackId) {
            for (const [sId, stack] of this.state.stacks.entries()) {
                if (stack.chains && stack.chains.includes(stepId)) {
                    stackId = sId;
                    namespace = namespace || stack.namespace;
                    stackObj = stack;
                    break;
                }
            }
        } else {
            stackObj = this.state.stacks.get(stackId);
            if (stackObj?.namespace && !namespace) {
                namespace = stackObj.namespace;
            }
        }

        const changeEvent: ContextChangeEvent = {
            namespace,
            stackId: stackId || '',
            stepId,
            field,
            value,
            timestamp: Date.now(),
        };
        emitMonitoringEvent(
            { monitor: stackObj?.monitor },
            {
                type: 'context:change',
                ...changeEvent,
            },
        );

        if (this.adapter?.onContextChange) {
            try {
                const res = this.adapter.onContextChange(changeEvent);
                if (res && typeof (res as any).catch === 'function') {
                    (res as any).catch((err: any) => {
                        this.handleAdapterError('onContextChange', err);
                    });
                }
            } catch (err) {
                this.handleAdapterError('onContextChange', err);
            }
        }
    }

    emitCacheEvent(event: CacheEvent): void {
        const stackObj = event.stackId ? this.state.stacks.get(event.stackId) : undefined;
        emitMonitoringEvent(
            { monitor: stackObj?.monitor },
            {
                type: event.type === 'hit' ? 'cache:hit' : 'cache:miss',
                stackId: event.stackId,
                stepId: event.stepId,
                key: event.key,
                timestamp: event.timestamp || Date.now(),
                namespace: event.namespace,
            },
        );

        if (this.adapter?.onCacheEvent) {
            try {
                const res = this.adapter.onCacheEvent(event);
                if (res && typeof (res as any).catch === 'function') {
                    (res as any).catch((err: any) => {
                        this.handleAdapterError('onCacheEvent', err);
                    });
                }
            } catch (err) {
                this.handleAdapterError('onCacheEvent', err);
            }
        }
    }

    getChainDataById(stepId: string): any {
        return gcdbi(this.state, stepId);
    }

    createExecutionStack(namespace?: string, monitor?: any): string {
        const stackId = generateUUID();
        this.state.stacks.set(stackId, {
            type: 'execution',
            chains: [],
            namespace,
            status: Status.RUNNING,
            revision: 0,
            monitor,
        });
        this.revisions.set(stackId, 0);
        return stackId;
    }

    createStack(stackIdOrNamespace?: string, namespace?: string, monitor?: any): string {
        let stackId: string;
        let effectiveNamespace: string | undefined;
        if (namespace !== undefined) {
            stackId = stackIdOrNamespace || generateUUID();
            effectiveNamespace = namespace;
        } else {
            stackId = stackIdOrNamespace || generateUUID();
        }
        this.state.stacks.set(stackId, {
            type: 'execution',
            chains: [],
            namespace: effectiveNamespace,
            status: Status.RUNNING,
            revision: 0,
            monitor,
        });
        this.revisions.set(stackId, 0);
        return stackId;
    }

    getStack(stackId: string): any {
        return this.state.stacks.get(stackId);
    }

    getAllStacks(): any[] {
        return Array.from(this.state.stacks.entries()).map(([stackId, stack]) => ({
            stackId,
            ...stack,
        }));
    }

    set(stackId: string, stepId: string, key: string, val: any): void {
        const stack = this.state.stacks.get(stackId);
        if (stack && !stack.chains.includes(stepId)) {
            stack.chains.push(stepId);
        }
        this.putChainContext(stepId, key, val, { stackId, namespace: stack?.namespace });
    }

    get(stackId: string, stepId: string): any {
        const raw = this.getChainDataById(stepId);
        if (!raw) {
            return raw;
        }
        const res: Record<string, any> = {};
        for (const [k, v] of Object.entries(raw)) {
            // prettier-ignore
            res[k] = typeof v === 'function' && (v as any).val !== undefined ? (v as any).val : typeof v === 'function' ? v() : v;
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
            timestamp: Date.now(),
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
        this.revisions.delete(stackId);
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
        this.revisions.clear();
        this.errorMode = 'best-effort';
    }

    snapshot(): Readonly<Record<string, any>> {
        const snap: Record<string, any> = {
            [CHAIN_CONFIG]: this.state.config,
        };
        for (const [key, value] of this.state.contexts) {
            snap[key] = value;
        }
        for (const [key, value] of this.state.stacks) {
            snap[key] = value;
        }
        return Object.freeze(snap);
    }

    cleanExpiredCheckpoints(): number {
        const now = Date.now();
        let cleaned = 0;
        for (const [stackId, stack] of this.state.stacks.entries()) {
            if (stack.expiresAt && stack.expiresAt <= now) {
                this.deleteStack(stackId);
                cleaned++;
            }
        }
        if (this.adapter?.cleanExpiredCheckpoints) {
            try {
                const res = this.adapter.cleanExpiredCheckpoints();
                if (res && typeof (res as any).catch === 'function') {
                    (res as any).catch((err: any) => {
                        this.handleAdapterError('cleanExpiredCheckpoints', err);
                    });
                }
            } catch (err) {
                this.handleAdapterError('cleanExpiredCheckpoints', err);
            }
        }
        return cleaned;
    }

    checkpoint(stackId: string, options?: CheckpointOptions): SerializedExecutionStack {
        const stack = this.state.stacks.get(stackId);
        if (!stack) {
            throw new Error(`Execution stack '${stackId}' not found.`);
        }

        const currentRev = this.revisions.get(stackId) || 0;
        if (options?.expectedRevision !== undefined && options.expectedRevision !== currentRev) {
            throw new CheckpointConflictException(stackId, currentRev, options.expectedRevision);
        }
        const nextRev = currentRev + 1;
        this.revisions.set(stackId, nextRev);

        const redactList = new Set<string>([
            ...(options?.redactFields || []),
            ...(this.state.config?.redactFields || []),
        ]);

        const contexts: Record<string, Record<string, any>> = {};
        if (stack.chains) {
            for (const stepId of stack.chains) {
                const ctx = this.state.contexts.get(stepId);
                if (ctx) {
                    const rawCtx: Record<string, any> = {};
                    for (const [key, fnOrVal] of Object.entries(ctx)) {
                        if (key !== VALIDATORS) {
                            if (redactList.has(key)) {
                                rawCtx[key] = '[REDACTED]';
                            } else {
                                const resolved = typeof fnOrVal === 'function' ? fnOrVal() : fnOrVal;
                                rawCtx[key] = redactValue(resolved, redactList);
                            }
                        }
                    }
                    contexts[stepId] = rawCtx;
                }
            }
        }

        const status = options?.status || stack.status || Status.RUNNING;
        const expiresAt = options?.ttlMs ? Date.now() + options.ttlMs : stack.expiresAt;

        stack.revision = nextRev;
        stack.status = status;
        if (expiresAt !== undefined) {
            stack.expiresAt = expiresAt;
        }

        const compensations = defaultCompensationManager.getCompensations(stackId).map(rec => ({
            stepId: rec.stepId,
            stepName: rec.stepName,
            output: toPOJO(rec.output),
            input: toPOJO(rec.input),
            handlerName: rec.handlerName,
            payload: toPOJO(rec.payload),
            options: rec.options,
            status: rec.status,
            completedAt: rec.completedAt,
        }));

        const mergedMetadata: Record<string, any> = {
            ...(stack.metadata || {}),
            ...(options?.metadata || {}),
            ...(compensations.length > 0 ? { compensations } : {}),
        };
        stack.metadata = mergedMetadata;

        const snapshot: SerializedExecutionStack = {
            version: 2,
            schemaVersion: '2.0.0',
            stackId,
            workflowId: options?.workflowId || stack.workflowId,
            namespace: stack.namespace,
            type: stack.type,
            status,
            revision: nextRev,
            chains: [...stack.chains],
            contexts,
            timestamp: Date.now(),
            expiresAt,
            metadata: mergedMetadata,
        };

        const stackObj = this.state.stacks.get(stackId);
        emitMonitoringEvent(
            { monitor: stackObj?.monitor },
            {
                type: 'checkpoint:save',
                stackId,
                status: snapshot.status,
                timestamp: Date.now(),
                namespace: snapshot.namespace,
            },
        );

        if (this.adapter?.saveCheckpoint) {
            try {
                const res = this.adapter.saveCheckpoint(snapshot);
                if (res && typeof (res as any).catch === 'function') {
                    (res as any).catch((err: any) => {
                        this.handleAdapterError('saveCheckpoint', err);
                    });
                }
            } catch (err) {
                this.handleAdapterError('saveCheckpoint', err);
            }
        }

        return snapshot;
    }

    async saveCheckpoint(checkpointData: SerializedExecutionStack): Promise<void> {
        if (!checkpointData || !checkpointData.stackId) {
            throw new Error('Invalid checkpoint data.');
        }
        const currentRev = this.revisions.get(checkpointData.stackId) || 0;
        if (checkpointData.revision !== undefined && checkpointData.revision <= currentRev) {
            this.handleAdapterError(
                'saveCheckpoint',
                new CheckpointConflictException(checkpointData.stackId, currentRev, checkpointData.revision),
            );
            return;
        }

        this.revisions.set(checkpointData.stackId, checkpointData.revision || currentRev + 1);

        const stackObj = this.state.stacks.get(checkpointData.stackId);
        emitMonitoringEvent(
            { monitor: stackObj?.monitor },
            {
                type: 'checkpoint:save',
                stackId: checkpointData.stackId,
                status: checkpointData.status,
                timestamp: checkpointData.timestamp || Date.now(),
                namespace: checkpointData.namespace,
            },
        );

        if (this.adapter?.saveCheckpoint) {
            try {
                await this.adapter.saveCheckpoint(checkpointData);
            } catch (err) {
                this.handleAdapterError('saveCheckpoint', err);
            }
        }
    }

    async getCheckpoint(stackId: string): Promise<SerializedExecutionStack | undefined> {
        if (this.adapter?.getCheckpoint) {
            try {
                const fromAdapter = await this.adapter.getCheckpoint(stackId);
                if (fromAdapter) {
                    return fromAdapter;
                }
            } catch (err) {
                this.handleAdapterError('getCheckpoint', err);
            }
        }
        if (this.state.stacks.has(stackId)) {
            return this.checkpoint(stackId);
        }
        return undefined;
    }

    restoreCheckpoint(
        checkpointData: SerializedExecutionStack,
        options?: { expectedNamespace?: string; expectedWorkflowId?: string },
    ): string {
        if (!checkpointData || !checkpointData.stackId) {
            throw new Error('Invalid checkpoint data.');
        }

        if (
            checkpointData.version !== undefined &&
            typeof checkpointData.version === 'number' &&
            checkpointData.version > 2
        ) {
            throw new CheckpointVersionException(checkpointData.version);
        }

        const expectedNamespace = options?.expectedNamespace || (options as any)?.namespace;
        if (expectedNamespace && checkpointData.namespace && checkpointData.namespace !== expectedNamespace) {
            throw new NamespaceMismatchException(expectedNamespace, checkpointData.namespace);
        }

        const rev = checkpointData.revision || 1;
        this.revisions.set(checkpointData.stackId, rev);

        this.state.stacks.set(checkpointData.stackId, {
            type: checkpointData.type || 'execution',
            chains: Array.isArray(checkpointData.chains) ? [...checkpointData.chains] : [],
            namespace: checkpointData.namespace,
            workflowId: checkpointData.workflowId,
            status: checkpointData.status || Status.RUNNING,
            revision: rev,
            expiresAt: checkpointData.expiresAt,
            metadata: checkpointData.metadata,
        });

        if (checkpointData.contexts) {
            for (const [stepId, fields] of Object.entries(checkpointData.contexts)) {
                if (fields && typeof fields === 'object') {
                    for (const [field, value] of Object.entries(fields)) {
                        this.putChainContext(stepId, field, value, {
                            stackId: checkpointData.stackId,
                            namespace: checkpointData.namespace,
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
        const stacks: Record<string, any> = {};
        for (const [sId, sVal] of this.state.stacks.entries()) {
            stacks[sId] = {
                type: sVal.type,
                chains: [...sVal.chains],
                namespace: sVal.namespace,
                status: sVal.status,
                revision: sVal.revision,
                workflowId: sVal.workflowId,
                expiresAt: sVal.expiresAt,
            };
        }
        const contexts: Record<string, Record<string, any>> = {};
        for (const [cId, ctx] of this.state.contexts.entries()) {
            const rawCtx: Record<string, any> = {};
            for (const [key, fnOrVal] of Object.entries(ctx)) {
                if (key !== VALIDATORS) {
                    rawCtx[key] = typeof fnOrVal === 'function' ? fnOrVal() : fnOrVal;
                }
            }
            contexts[cId] = rawCtx;
        }
        const stateObj: SerializedStorageState = {
            version: 1,
            timestamp: Date.now(),
            config: this.state.config ? { ...this.state.config } : {},
            stacks,
            contexts,
        };
        return JSON.stringify(stateObj);
    }

    hydrateState(
        serialized: string | SerializedStorageState | SerializedExecutionStack,
        options?: { expectedNamespace?: string },
    ): string | undefined {
        if (!serialized) {
            throw new Error('Cannot hydrate empty state.');
        }
        const data = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
        let restoredId: string | undefined;
        if (data.stackId) {
            return this.restoreCheckpoint(data as SerializedExecutionStack, options);
        }
        if (data.config) {
            this.setChainConfig(data.config);
        }
        if (data.stacks) {
            for (const [sId, sVal] of Object.entries(data.stacks as Record<string, any>)) {
                if (!restoredId) {
                    restoredId = sId;
                }
                const rev = sVal.revision || 1;
                this.revisions.set(sId, rev);
                this.state.stacks.set(sId, {
                    type: sVal.type || 'execution',
                    chains: Array.isArray(sVal.chains) ? [...sVal.chains] : [],
                    namespace: sVal.namespace,
                    status: sVal.status || Status.RUNNING,
                    revision: rev,
                    workflowId: sVal.workflowId,
                    expiresAt: sVal.expiresAt,
                });
            }
        }
        if (data.contexts) {
            for (const [stepId, fields] of Object.entries(data.contexts as Record<string, any>)) {
                if (fields && typeof fields === 'object') {
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
            throw new Error('Unauthorized storage access');
        }
        return defaultStorageManager.snapshot();
    },
};

export function useStorage(adapter: StorageAdapter): void {
    defaultStorageManager.useStorage(adapter);
}

export function getStorageAdapter(): StorageAdapter | undefined {
    return defaultStorageManager.getStorageAdapter();
}

export function setErrorMode(mode: StorageErrorMode): void {
    defaultStorageManager.setErrorMode(mode);
}

export function getErrorMode(): StorageErrorMode {
    return defaultStorageManager.getErrorMode();
}

export function cleanExpiredCheckpoints(): number {
    return defaultStorageManager.cleanExpiredCheckpoints();
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

export function createExecutionStack(namespace?: string, monitor?: any): string {
    return defaultStorageManager.createExecutionStack(namespace, monitor);
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

export function setPutChainContextPlugin(
    plugin: (stepId: string, field: string, getter: () => any, meta?: PutChainContextMeta) => void,
): void {
    defaultStorageManager.setPutChainContextPlugin(plugin);
}

export function checkpoint(stackId: string, options?: CheckpointOptions): SerializedExecutionStack {
    return defaultStorageManager.checkpoint(stackId, options);
}

export function getCheckpoint(stackId: string): Promise<SerializedExecutionStack | undefined> {
    return defaultStorageManager.getCheckpoint(stackId);
}

export function restoreCheckpoint(
    checkpointData: SerializedExecutionStack,
    options?: { expectedNamespace?: string; expectedWorkflowId?: string },
): string {
    return defaultStorageManager.restoreCheckpoint(checkpointData, options);
}

export function serializeState(stackId?: string): string {
    return defaultStorageManager.serializeState(stackId);
}

export function hydrateState(
    serialized: string | SerializedStorageState | SerializedExecutionStack,
    options?: { expectedNamespace?: string },
): string | undefined {
    return defaultStorageManager.hydrateState(serialized, options);
}
