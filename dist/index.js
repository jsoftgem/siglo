"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearStorage = exports.getStorage = exports.setPutChainContextPlugin = exports.setGetChainContextPlugin = exports.putChainContext = exports.getChainContext = exports.getErrorMode = exports.setErrorMode = exports.cleanExpiredCheckpoints = exports.hydrateState = exports.serializeState = exports.restoreCheckpoint = exports.getCheckpoint = exports.checkpoint = exports.getStorageAdapter = exports.useStorage = exports.storage = exports.defaultStorageManager = exports.StorageManager = exports.normalizeError = exports.CheckpointVersionException = exports.TenantMismatchException = exports.CheckpointConflictException = exports.StorageAdapterException = exports.ValidationException = exports.CancellationException = exports.FlowTimeoutException = exports.StepTimeoutException = exports.FluidFuncError = exports.isPipeline = exports.pipe = exports.Chain = exports.Func = exports.toPOJO = exports.isFlow = exports.flow = exports.Step = void 0;
/* c8 ignore start */
const step_1 = require("./features/step");
Object.defineProperty(exports, "Step", { enumerable: true, get: function () { return step_1.Step; } });
Object.defineProperty(exports, "flow", { enumerable: true, get: function () { return step_1.flow; } });
Object.defineProperty(exports, "isFlow", { enumerable: true, get: function () { return step_1.isFlow; } });
Object.defineProperty(exports, "toPOJO", { enumerable: true, get: function () { return step_1.toPOJO; } });
Object.defineProperty(exports, "Chain", { enumerable: true, get: function () { return 
    // Compatibility aliases
    step_1.Chain; } });
Object.defineProperty(exports, "pipe", { enumerable: true, get: function () { return step_1.pipe; } });
Object.defineProperty(exports, "isPipeline", { enumerable: true, get: function () { return step_1.isPipeline; } });
Object.defineProperty(exports, "FluidFuncError", { enumerable: true, get: function () { return 
    // Error model
    step_1.FluidFuncError; } });
Object.defineProperty(exports, "StepTimeoutException", { enumerable: true, get: function () { return step_1.StepTimeoutException; } });
Object.defineProperty(exports, "FlowTimeoutException", { enumerable: true, get: function () { return step_1.FlowTimeoutException; } });
Object.defineProperty(exports, "CancellationException", { enumerable: true, get: function () { return step_1.CancellationException; } });
Object.defineProperty(exports, "ValidationException", { enumerable: true, get: function () { return step_1.ValidationException; } });
Object.defineProperty(exports, "StorageAdapterException", { enumerable: true, get: function () { return step_1.StorageAdapterException; } });
Object.defineProperty(exports, "CheckpointConflictException", { enumerable: true, get: function () { return step_1.CheckpointConflictException; } });
Object.defineProperty(exports, "TenantMismatchException", { enumerable: true, get: function () { return step_1.TenantMismatchException; } });
Object.defineProperty(exports, "CheckpointVersionException", { enumerable: true, get: function () { return step_1.CheckpointVersionException; } });
Object.defineProperty(exports, "normalizeError", { enumerable: true, get: function () { return step_1.normalizeError; } });
const storage_1 = require("./features/storage");
Object.defineProperty(exports, "StorageManager", { enumerable: true, get: function () { return storage_1.StorageManager; } });
Object.defineProperty(exports, "defaultStorageManager", { enumerable: true, get: function () { return storage_1.defaultStorageManager; } });
Object.defineProperty(exports, "storage", { enumerable: true, get: function () { return storage_1.storage; } });
Object.defineProperty(exports, "useStorage", { enumerable: true, get: function () { return storage_1.useStorage; } });
Object.defineProperty(exports, "getStorageAdapter", { enumerable: true, get: function () { return storage_1.getStorageAdapter; } });
Object.defineProperty(exports, "checkpoint", { enumerable: true, get: function () { return storage_1.checkpoint; } });
Object.defineProperty(exports, "getCheckpoint", { enumerable: true, get: function () { return storage_1.getCheckpoint; } });
Object.defineProperty(exports, "restoreCheckpoint", { enumerable: true, get: function () { return storage_1.restoreCheckpoint; } });
Object.defineProperty(exports, "serializeState", { enumerable: true, get: function () { return storage_1.serializeState; } });
Object.defineProperty(exports, "hydrateState", { enumerable: true, get: function () { return storage_1.hydrateState; } });
Object.defineProperty(exports, "cleanExpiredCheckpoints", { enumerable: true, get: function () { return storage_1.cleanExpiredCheckpoints; } });
Object.defineProperty(exports, "setErrorMode", { enumerable: true, get: function () { return storage_1.setErrorMode; } });
Object.defineProperty(exports, "getErrorMode", { enumerable: true, get: function () { return storage_1.getErrorMode; } });
Object.defineProperty(exports, "getChainContext", { enumerable: true, get: function () { return 
    // Deprecated compatibility functions
    storage_1.getChainContext; } });
Object.defineProperty(exports, "putChainContext", { enumerable: true, get: function () { return storage_1.putChainContext; } });
Object.defineProperty(exports, "setGetChainContextPlugin", { enumerable: true, get: function () { return storage_1.setGetChainContextPlugin; } });
Object.defineProperty(exports, "setPutChainContextPlugin", { enumerable: true, get: function () { return storage_1.setPutChainContextPlugin; } });
Object.defineProperty(exports, "getStorage", { enumerable: true, get: function () { return storage_1.getStorage; } });
Object.defineProperty(exports, "clearStorage", { enumerable: true, get: function () { return storage_1.clearStorage; } });
const Func = step_1.Step;
exports.Func = Func;
exports.default = step_1.Step;
// Compatibility for both CJS require('fluid-func') and ESM import FluidFunc from 'fluid-func'
/* c8 ignore next 40 */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign(step_1.Step, {
        default: step_1.Step,
        Step: step_1.Step,
        Func: step_1.Step,
        Chain: step_1.Step,
        flow: step_1.flow,
        isFlow: step_1.isFlow,
        pipe: step_1.pipe,
        Pipeline: step_1.flow,
        isPipeline: step_1.isPipeline,
        toPOJO: step_1.toPOJO,
        FluidFuncError: step_1.FluidFuncError,
        StepTimeoutException: step_1.StepTimeoutException,
        FlowTimeoutException: step_1.FlowTimeoutException,
        CancellationException: step_1.CancellationException,
        ValidationException: step_1.ValidationException,
        StorageAdapterException: step_1.StorageAdapterException,
        CheckpointConflictException: step_1.CheckpointConflictException,
        TenantMismatchException: step_1.TenantMismatchException,
        CheckpointVersionException: step_1.CheckpointVersionException,
        normalizeError: step_1.normalizeError,
        StorageManager: storage_1.StorageManager,
        defaultStorageManager: storage_1.defaultStorageManager,
        storage: storage_1.storage,
        useStorage: storage_1.useStorage,
        getStorageAdapter: storage_1.getStorageAdapter,
        setErrorMode: storage_1.setErrorMode,
        getErrorMode: storage_1.getErrorMode,
        cleanExpiredCheckpoints: storage_1.cleanExpiredCheckpoints,
        checkpoint: storage_1.checkpoint,
        getCheckpoint: storage_1.getCheckpoint,
        restoreCheckpoint: storage_1.restoreCheckpoint,
        serializeState: storage_1.serializeState,
        hydrateState: storage_1.hydrateState,
        setGetChainContextPlugin: storage_1.setGetChainContextPlugin,
        setPutChainContextPlugin: storage_1.setPutChainContextPlugin,
        getStorage: storage_1.getStorage,
        clearStorage: storage_1.clearStorage,
        getChainContext: storage_1.getChainContext,
        putChainContext: storage_1.putChainContext
    });
}
//# sourceMappingURL=index.js.map