"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PutChainTypeException = exports.GetChainTypeException = exports.hydrateState = exports.serializeState = exports.restoreCheckpoint = exports.getCheckpoint = exports.checkpoint = exports.serializeParam = exports.setPutChainContextPlugin = exports.setGetChainContextPlugin = exports.getPlugins = exports.getLogMonitor = exports.setChainConfig = exports.clearStorage = exports.getStorage = exports.deleteStack = exports.addChainToStack = exports.createExecutionStack = exports.getChainDataById = exports.putChainContext = exports.getChainContext = exports.getStorageAdapter = exports.useStorage = exports.storage = exports.defaultStorageManager = exports.StorageManager = exports.FlowTimeoutException = exports.StepTimeoutException = exports.isPipeline = exports.toPOJO = exports.pipe = exports.isFlow = exports.flow = exports.Step = exports.Func = void 0;
/* c8 ignore start */
const step_1 = require("./features/step");
Object.defineProperty(exports, "Func", { enumerable: true, get: function () { return step_1.Step; } });
Object.defineProperty(exports, "Step", { enumerable: true, get: function () { return step_1.Step; } });
Object.defineProperty(exports, "flow", { enumerable: true, get: function () { return step_1.flow; } });
Object.defineProperty(exports, "toPOJO", { enumerable: true, get: function () { return step_1.toPOJO; } });
Object.defineProperty(exports, "isFlow", { enumerable: true, get: function () { return step_1.isFlow; } });
Object.defineProperty(exports, "pipe", { enumerable: true, get: function () { return step_1.pipe; } });
Object.defineProperty(exports, "isPipeline", { enumerable: true, get: function () { return step_1.isPipeline; } });
Object.defineProperty(exports, "StepTimeoutException", { enumerable: true, get: function () { return step_1.StepTimeoutException; } });
Object.defineProperty(exports, "FlowTimeoutException", { enumerable: true, get: function () { return step_1.FlowTimeoutException; } });
const storage_1 = require("./features/storage");
Object.defineProperty(exports, "StorageManager", { enumerable: true, get: function () { return storage_1.StorageManager; } });
Object.defineProperty(exports, "defaultStorageManager", { enumerable: true, get: function () { return storage_1.defaultStorageManager; } });
Object.defineProperty(exports, "storage", { enumerable: true, get: function () { return storage_1.storage; } });
Object.defineProperty(exports, "useStorage", { enumerable: true, get: function () { return storage_1.useStorage; } });
Object.defineProperty(exports, "getStorageAdapter", { enumerable: true, get: function () { return storage_1.getStorageAdapter; } });
Object.defineProperty(exports, "getChainContext", { enumerable: true, get: function () { return storage_1.getChainContext; } });
Object.defineProperty(exports, "putChainContext", { enumerable: true, get: function () { return storage_1.putChainContext; } });
Object.defineProperty(exports, "getChainDataById", { enumerable: true, get: function () { return storage_1.getChainDataById; } });
Object.defineProperty(exports, "createExecutionStack", { enumerable: true, get: function () { return storage_1.createExecutionStack; } });
Object.defineProperty(exports, "addChainToStack", { enumerable: true, get: function () { return storage_1.addChainToStack; } });
Object.defineProperty(exports, "deleteStack", { enumerable: true, get: function () { return storage_1.deleteStack; } });
Object.defineProperty(exports, "getStorage", { enumerable: true, get: function () { return storage_1.getStorage; } });
Object.defineProperty(exports, "clearStorage", { enumerable: true, get: function () { return storage_1.clearStorage; } });
Object.defineProperty(exports, "setChainConfig", { enumerable: true, get: function () { return storage_1.setChainConfig; } });
Object.defineProperty(exports, "getLogMonitor", { enumerable: true, get: function () { return storage_1.getLogMonitor; } });
Object.defineProperty(exports, "getPlugins", { enumerable: true, get: function () { return storage_1.getPlugins; } });
Object.defineProperty(exports, "setGetChainContextPlugin", { enumerable: true, get: function () { return storage_1.setGetChainContextPlugin; } });
Object.defineProperty(exports, "setPutChainContextPlugin", { enumerable: true, get: function () { return storage_1.setPutChainContextPlugin; } });
Object.defineProperty(exports, "serializeParam", { enumerable: true, get: function () { return storage_1.serializeParam; } });
Object.defineProperty(exports, "checkpoint", { enumerable: true, get: function () { return storage_1.checkpoint; } });
Object.defineProperty(exports, "getCheckpoint", { enumerable: true, get: function () { return storage_1.getCheckpoint; } });
Object.defineProperty(exports, "restoreCheckpoint", { enumerable: true, get: function () { return storage_1.restoreCheckpoint; } });
Object.defineProperty(exports, "serializeState", { enumerable: true, get: function () { return storage_1.serializeState; } });
Object.defineProperty(exports, "hydrateState", { enumerable: true, get: function () { return storage_1.hydrateState; } });
Object.defineProperty(exports, "GetChainTypeException", { enumerable: true, get: function () { return storage_1.GetChainTypeException; } });
Object.defineProperty(exports, "PutChainTypeException", { enumerable: true, get: function () { return storage_1.PutChainTypeException; } });
exports.default = step_1.Step;
// Compatibility for both CJS require('fluid-func') and ESM import FluidFunc from 'fluid-func'
/* c8 ignore next 29 */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign(step_1.Step, {
        default: step_1.Step,
        Func: step_1.Step,
        Step: step_1.Step,
        flow: step_1.flow,
        isFlow: step_1.isFlow,
        pipe: step_1.pipe,
        isPipeline: step_1.isPipeline,
        toPOJO: step_1.toPOJO,
        StepTimeoutException: step_1.StepTimeoutException,
        FlowTimeoutException: step_1.FlowTimeoutException,
        StorageManager: storage_1.StorageManager,
        defaultStorageManager: storage_1.defaultStorageManager,
        storage: storage_1.storage,
        useStorage: storage_1.useStorage,
        getStorageAdapter: storage_1.getStorageAdapter,
        setGetChainContextPlugin: storage_1.setGetChainContextPlugin,
        setPutChainContextPlugin: storage_1.setPutChainContextPlugin,
        checkpoint: storage_1.checkpoint,
        getCheckpoint: storage_1.getCheckpoint,
        restoreCheckpoint: storage_1.restoreCheckpoint,
        serializeState: storage_1.serializeState,
        hydrateState: storage_1.hydrateState
    });
}
//# sourceMappingURL=index.js.map