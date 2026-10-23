"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storage = exports.defaultStorageManager = exports.StorageManager = exports.PutChainTypeException = exports.GetChainTypeException = void 0;
exports.serializeParam = serializeParam;
exports.useStorage = useStorage;
exports.getStorageAdapter = getStorageAdapter;
exports.getChainContext = getChainContext;
exports.putChainContext = putChainContext;
exports.getChainDataById = getChainDataById;
exports.createExecutionStack = createExecutionStack;
exports.addChainToStack = addChainToStack;
exports.cacheChainAction = cacheChainAction;
exports.hasCached = hasCached;
exports.getCachedChainAction = getCachedChainAction;
exports.clearCache = clearCache;
exports.deleteStack = deleteStack;
exports.getStorage = getStorage;
exports.clearStorage = clearStorage;
exports.setChainConfig = setChainConfig;
exports.getLogMonitor = getLogMonitor;
exports.getPlugins = getPlugins;
exports.setGetChainContextPlugin = setGetChainContextPlugin;
exports.setPutChainContextPlugin = setPutChainContextPlugin;
exports.checkpoint = checkpoint;
exports.getCheckpoint = getCheckpoint;
exports.restoreCheckpoint = restoreCheckpoint;
exports.serializeState = serializeState;
exports.hydrateState = hydrateState;
const get_1 = require("./get");
const put_1 = require("./put");
const constants_1 = require("./constants");
const state_1 = require("./state");
const shared_1 = require("../../shared");
var get_2 = require("./get");
Object.defineProperty(exports, "GetChainTypeException", { enumerable: true, get: function () { return get_2.GetChainTypeException; } });
var put_2 = require("./put");
Object.defineProperty(exports, "PutChainTypeException", { enumerable: true, get: function () { return put_2.PutChainTypeException; } });
function serializeParam(param) {
    if (param === null || param === undefined) {
        return String(param);
    }
    if (typeof param !== "object") {
        return JSON.stringify(param);
    }
    const seen = new WeakSet();
    const clean = (val) => {
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
        const obj = {};
        for (const key of sortedKeys) {
            obj[key] = clean(val[key]);
        }
        return obj;
    };
    try {
        return JSON.stringify(clean(param));
    }
    catch {
        return String(param);
    }
}
class StorageManager {
    state;
    adapter;
    constructor(initialState) {
        this.state = initialState || (0, state_1.createInitialState)();
    }
    getState() {
        return this.state;
    }
    useStorage(adapter) {
        this.adapter = adapter;
    }
    getStorageAdapter() {
        return this.adapter;
    }
    getChainContext(stepId, field) {
        return (0, get_1.getChainContext)(this.state, stepId, field);
    }
    putChainContext(stepId, field, value, meta) {
        (0, put_1.putChainContext)(this.state, stepId, field, value, meta);
        if (this.adapter?.onContextChange) {
            let tenantId;
            let stackId;
            if (typeof meta === "string") {
                stackId = meta;
            }
            else if (meta) {
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
            }
            else if (!tenantId) {
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
                if (res && typeof res.catch === "function") {
                    res.catch(() => { });
                }
            }
            catch {
                // Ignore adapter errors to preserve execution flow
            }
        }
    }
    getChainDataById(stepId) {
        return (0, get_1.getChainDataById)(this.state, stepId);
    }
    createExecutionStack(tenantId) {
        const stackId = (0, shared_1.generateUUID)();
        this.state.stacks.set(stackId, {
            type: "execution",
            chains: [],
            tenantId
        });
        return stackId;
    }
    createStack(stackIdOrTenant, tenantId) {
        let stackId;
        let effectiveTenantId;
        if (tenantId !== undefined) {
            stackId = stackIdOrTenant || (0, shared_1.generateUUID)();
            effectiveTenantId = tenantId;
        }
        else {
            stackId = stackIdOrTenant || (0, shared_1.generateUUID)();
        }
        this.state.stacks.set(stackId, {
            type: "execution",
            chains: [],
            tenantId: effectiveTenantId
        });
        return stackId;
    }
    getStack(stackId) {
        return this.state.stacks.get(stackId);
    }
    set(stackId, stepId, key, val) {
        const stack = this.state.stacks.get(stackId);
        if (stack && !stack.chains.includes(stepId)) {
            stack.chains.push(stepId);
        }
        this.putChainContext(stepId, key, val, { stackId, tenantId: stack?.tenantId });
    }
    get(stackId, stepId) {
        const raw = this.getChainDataById(stepId);
        if (!raw) {
            return raw;
        }
        const res = {};
        for (const [k, v] of Object.entries(raw)) {
            res[k] = (typeof v === "function" && v.val !== undefined) ? v.val : (typeof v === "function" ? v() : v);
        }
        return res;
    }
    addChainToStack(stackId, stepId) {
        const stack = this.state.stacks.get(stackId);
        if (stack) {
            stack.chains.push(stepId);
        }
    }
    cacheChainAction(stackId, stepId, param, result) {
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
    hasCached(stackId, stepId, param) {
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
    getCachedChainAction(stackId, stepId, param) {
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
    clearCache(stackId, stepId) {
        const stackCache = this.state.cache.get(stackId);
        if (stackCache) {
            stackCache.delete(stepId);
        }
    }
    deleteStack(stackId) {
        const stack = this.state.stacks.get(stackId);
        if (stack) {
            if (stack.chains) {
                stack.chains.forEach((stepId) => {
                    this.state.contexts.delete(stepId);
                });
            }
            this.state.stacks.delete(stackId);
        }
        this.state.cache.delete(stackId);
    }
    setChainConfig(config) {
        (0, put_1.setChainConfig)(this.state, config);
    }
    getLogMonitor() {
        return (0, get_1.getLogMonitor)(this.state);
    }
    getPlugins() {
        return (0, get_1.getPlugins)(this.state);
    }
    setGetChainContextPlugin(plugin) {
        (0, get_1.setGetChainContextPlugin)(this.state, plugin);
    }
    setPutChainContextPlugin(plugin) {
        (0, put_1.setPutChainContextPlugin)(this.state, plugin);
    }
    clear() {
        this.state = (0, state_1.createInitialState)();
        this.adapter = undefined;
    }
    snapshot() {
        const snap = {
            [constants_1.CHAIN_CONFIG]: this.state.config
        };
        for (const [key, value] of this.state.contexts) {
            snap[key] = value;
        }
        for (const [key, value] of this.state.stacks) {
            snap[key] = value;
        }
        return Object.freeze(snap);
    }
    checkpoint(stackId) {
        const stack = this.state.stacks.get(stackId);
        if (!stack) {
            throw new Error(`Execution stack \x27${stackId}\x27 not found.`);
        }
        const contexts = {};
        if (stack.chains) {
            for (const stepId of stack.chains) {
                const ctx = this.state.contexts.get(stepId);
                if (ctx) {
                    const rawCtx = {};
                    for (const [key, fnOrVal] of Object.entries(ctx)) {
                        if (key !== "$$$validators") {
                            rawCtx[key] = typeof fnOrVal === "function" ? fnOrVal() : fnOrVal;
                        }
                    }
                    contexts[stepId] = rawCtx;
                }
            }
        }
        const snapshot = {
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
                if (res && typeof res.catch === "function") {
                    res.catch(() => { });
                }
                /* c8 ignore next 3 */
            }
            catch {
                // Ignore adapter errors
            }
        }
        return snapshot;
    }
    async getCheckpoint(stackId) {
        if (this.adapter?.getCheckpoint) {
            try {
                const fromAdapter = await this.adapter.getCheckpoint(stackId);
                if (fromAdapter) {
                    return fromAdapter;
                }
            }
            catch {
                // Fallback to in-memory stack
            }
        }
        if (this.state.stacks.has(stackId)) {
            return this.checkpoint(stackId);
        }
        return undefined;
    }
    restoreCheckpoint(checkpointData) {
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
    serializeState(stackId) {
        if (stackId) {
            return JSON.stringify(this.checkpoint(stackId));
        }
        const stacks = {};
        for (const [sId, sVal] of this.state.stacks.entries()) {
            stacks[sId] = {
                type: sVal.type,
                chains: [...sVal.chains],
                tenantId: sVal.tenantId
            };
        }
        const contexts = {};
        for (const [cId, ctx] of this.state.contexts.entries()) {
            const rawCtx = {};
            for (const [key, fnOrVal] of Object.entries(ctx)) {
                if (key !== "$$$validators") {
                    rawCtx[key] = typeof fnOrVal === "function" ? fnOrVal() : fnOrVal;
                }
            }
            contexts[cId] = rawCtx;
        }
        const stateObj = {
            version: 1,
            timestamp: Date.now(),
            config: this.state.config ? { ...this.state.config } : {},
            stacks,
            contexts
        };
        return JSON.stringify(stateObj);
    }
    hydrateState(serialized) {
        if (!serialized) {
            throw new Error("Cannot hydrate empty state.");
        }
        const data = typeof serialized === "string" ? JSON.parse(serialized) : serialized;
        let restoredId;
        if (data.stackId) {
            return this.restoreCheckpoint(data);
        }
        if (data.config) {
            this.setChainConfig(data.config);
        }
        if (data.stacks) {
            for (const [sId, sVal] of Object.entries(data.stacks)) {
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
            for (const [stepId, fields] of Object.entries(data.contexts)) {
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
exports.StorageManager = StorageManager;
const STORE_ID = (0, shared_1.generateUUID)();
exports.defaultStorageManager = new StorageManager();
exports.storage = {
    __$store: (id) => {
        if (id !== STORE_ID) {
            throw new Error("Unauthorized storage access");
        }
        return exports.defaultStorageManager.snapshot();
    }
};
function useStorage(adapter) {
    exports.defaultStorageManager.useStorage(adapter);
}
function getStorageAdapter() {
    return exports.defaultStorageManager.getStorageAdapter();
}
function getChainContext(stepId, field) {
    return exports.defaultStorageManager.getChainContext(stepId, field);
}
function putChainContext(stepId, field, value, meta) {
    exports.defaultStorageManager.putChainContext(stepId, field, value, meta);
}
function getChainDataById(stepId) {
    return exports.defaultStorageManager.getChainDataById(stepId);
}
function createExecutionStack(tenantId) {
    return exports.defaultStorageManager.createExecutionStack(tenantId);
}
function addChainToStack(stackId, stepId) {
    exports.defaultStorageManager.addChainToStack(stackId, stepId);
}
function cacheChainAction(stackId, stepId, param, result) {
    exports.defaultStorageManager.cacheChainAction(stackId, stepId, param, result);
}
function hasCached(stackId, stepId, param) {
    return exports.defaultStorageManager.hasCached(stackId, stepId, param);
}
function getCachedChainAction(stackId, stepId, param) {
    return exports.defaultStorageManager.getCachedChainAction(stackId, stepId, param);
}
function clearCache(stackId, stepId) {
    exports.defaultStorageManager.clearCache(stackId, stepId);
}
function deleteStack(stackId) {
    exports.defaultStorageManager.deleteStack(stackId);
}
function getStorage() {
    return exports.defaultStorageManager.snapshot();
}
function clearStorage() {
    exports.defaultStorageManager.clear();
}
function setChainConfig(config) {
    exports.defaultStorageManager.setChainConfig(config);
}
function getLogMonitor() {
    return exports.defaultStorageManager.getLogMonitor();
}
function getPlugins() {
    return exports.defaultStorageManager.getPlugins();
}
function setGetChainContextPlugin(plugin) {
    exports.defaultStorageManager.setGetChainContextPlugin(plugin);
}
function setPutChainContextPlugin(plugin) {
    exports.defaultStorageManager.setPutChainContextPlugin(plugin);
}
function checkpoint(stackId) {
    return exports.defaultStorageManager.checkpoint(stackId);
}
function getCheckpoint(stackId) {
    return exports.defaultStorageManager.getCheckpoint(stackId);
}
function restoreCheckpoint(checkpointData) {
    return exports.defaultStorageManager.restoreCheckpoint(checkpointData);
}
function serializeState(stackId) {
    return exports.defaultStorageManager.serializeState(stackId);
}
function hydrateState(serialized) {
    return exports.defaultStorageManager.hydrateState(serialized);
}
//# sourceMappingURL=index.js.map