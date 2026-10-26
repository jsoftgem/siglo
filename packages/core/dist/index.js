"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.race = exports.allSettled = exports.all = exports.parallel = exports.toDot = exports.toJSON = exports.toMermaid = exports.inspectGraph = exports.assertValidGraph = exports.validateGraph = exports.toGraph = exports.getErrorMode = exports.setErrorMode = exports.cleanExpiredCheckpoints = exports.hydrateState = exports.serializeState = exports.restoreCheckpoint = exports.getCheckpoint = exports.checkpoint = exports.getStorageAdapter = exports.useStorage = exports.storage = exports.defaultStorageManager = exports.StorageManager = exports.normalizeError = exports.GraphValidationException = exports.WorkflowVersionMismatchException = exports.ExpiredWaitException = exports.DuplicateEventException = exports.WorkflowSuspendedException = exports.CompensationException = exports.IdempotencyConflictException = exports.FieldCollisionException = exports.CheckpointVersionException = exports.NamespaceMismatchException = exports.CheckpointConflictException = exports.StorageAdapterException = exports.ValidationException = exports.CancellationException = exports.FlowTimeoutException = exports.StepTimeoutException = exports.FluidFuncError = exports.isPipeline = exports.pipe = exports.Chain = exports.Func = exports.toPOJO = exports.isFlow = exports.flow = exports.Step = void 0;
exports.isObject = exports.isFunction = exports.isReservedKey = exports.tagErrorPhase = exports.ExecutionPhase = exports.Status = exports.clearStorage = exports.getStorage = exports.setPutChainContextPlugin = exports.setGetChainContextPlugin = exports.putChainContext = exports.getChainContext = exports.resumeWorkflow = exports.validateWorkflowVersion = exports.defaultDurableManager = exports.DurableManager = exports.wait = exports.waitForEvent = exports.parseDuration = exports.defaultCompensationManager = exports.CompensationManager = exports.buildIdempotencyKey = exports.defaultIdempotencyStore = exports.InMemoryIdempotencyStore = exports.ParallelMode = exports.ParallelMergeStrategy = exports.map = exports.branch = exports.when = void 0;
/* c8 ignore start */
const step_1 = require("./features/step");
Object.defineProperty(exports, "Step", { enumerable: true, get: function () { return step_1.Step; } });
Object.defineProperty(exports, "flow", { enumerable: true, get: function () { return step_1.flow; } });
Object.defineProperty(exports, "isFlow", { enumerable: true, get: function () { return step_1.isFlow; } });
Object.defineProperty(exports, "toPOJO", { enumerable: true, get: function () { return step_1.toPOJO; } });
Object.defineProperty(exports, "Func", { enumerable: true, get: function () { return 
    // Compatibility aliases
    step_1.Func; } });
Object.defineProperty(exports, "Chain", { enumerable: true, get: function () { return step_1.Chain; } });
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
Object.defineProperty(exports, "NamespaceMismatchException", { enumerable: true, get: function () { return step_1.NamespaceMismatchException; } });
Object.defineProperty(exports, "CheckpointVersionException", { enumerable: true, get: function () { return step_1.CheckpointVersionException; } });
Object.defineProperty(exports, "FieldCollisionException", { enumerable: true, get: function () { return step_1.FieldCollisionException; } });
Object.defineProperty(exports, "IdempotencyConflictException", { enumerable: true, get: function () { return step_1.IdempotencyConflictException; } });
Object.defineProperty(exports, "CompensationException", { enumerable: true, get: function () { return step_1.CompensationException; } });
Object.defineProperty(exports, "WorkflowSuspendedException", { enumerable: true, get: function () { return step_1.WorkflowSuspendedException; } });
Object.defineProperty(exports, "DuplicateEventException", { enumerable: true, get: function () { return step_1.DuplicateEventException; } });
Object.defineProperty(exports, "ExpiredWaitException", { enumerable: true, get: function () { return step_1.ExpiredWaitException; } });
Object.defineProperty(exports, "WorkflowVersionMismatchException", { enumerable: true, get: function () { return step_1.WorkflowVersionMismatchException; } });
Object.defineProperty(exports, "GraphValidationException", { enumerable: true, get: function () { return step_1.GraphValidationException; } });
Object.defineProperty(exports, "normalizeError", { enumerable: true, get: function () { return step_1.normalizeError; } });
Object.defineProperty(exports, "toGraph", { enumerable: true, get: function () { return step_1.toGraph; } });
Object.defineProperty(exports, "validateGraph", { enumerable: true, get: function () { return step_1.validateGraph; } });
Object.defineProperty(exports, "assertValidGraph", { enumerable: true, get: function () { return step_1.assertValidGraph; } });
Object.defineProperty(exports, "inspectGraph", { enumerable: true, get: function () { return step_1.inspectGraph; } });
Object.defineProperty(exports, "toMermaid", { enumerable: true, get: function () { return step_1.toMermaid; } });
Object.defineProperty(exports, "toJSON", { enumerable: true, get: function () { return step_1.toJSON; } });
Object.defineProperty(exports, "toDot", { enumerable: true, get: function () { return step_1.toDot; } });
Object.defineProperty(exports, "parallel", { enumerable: true, get: function () { return 
    // Phase 2 Combinators
    step_1.parallel; } });
Object.defineProperty(exports, "all", { enumerable: true, get: function () { return step_1.all; } });
Object.defineProperty(exports, "allSettled", { enumerable: true, get: function () { return step_1.allSettled; } });
Object.defineProperty(exports, "race", { enumerable: true, get: function () { return step_1.race; } });
Object.defineProperty(exports, "when", { enumerable: true, get: function () { return step_1.when; } });
Object.defineProperty(exports, "branch", { enumerable: true, get: function () { return step_1.branch; } });
Object.defineProperty(exports, "map", { enumerable: true, get: function () { return step_1.map; } });
Object.defineProperty(exports, "ParallelMergeStrategy", { enumerable: true, get: function () { return step_1.ParallelMergeStrategy; } });
Object.defineProperty(exports, "ParallelMode", { enumerable: true, get: function () { return step_1.ParallelMode; } });
Object.defineProperty(exports, "InMemoryIdempotencyStore", { enumerable: true, get: function () { return step_1.InMemoryIdempotencyStore; } });
Object.defineProperty(exports, "defaultIdempotencyStore", { enumerable: true, get: function () { return step_1.defaultIdempotencyStore; } });
Object.defineProperty(exports, "buildIdempotencyKey", { enumerable: true, get: function () { return step_1.buildIdempotencyKey; } });
Object.defineProperty(exports, "CompensationManager", { enumerable: true, get: function () { return step_1.CompensationManager; } });
Object.defineProperty(exports, "defaultCompensationManager", { enumerable: true, get: function () { return step_1.defaultCompensationManager; } });
Object.defineProperty(exports, "parseDuration", { enumerable: true, get: function () { return step_1.parseDuration; } });
Object.defineProperty(exports, "waitForEvent", { enumerable: true, get: function () { return step_1.waitForEvent; } });
Object.defineProperty(exports, "wait", { enumerable: true, get: function () { return step_1.wait; } });
Object.defineProperty(exports, "DurableManager", { enumerable: true, get: function () { return step_1.DurableManager; } });
Object.defineProperty(exports, "defaultDurableManager", { enumerable: true, get: function () { return step_1.defaultDurableManager; } });
Object.defineProperty(exports, "validateWorkflowVersion", { enumerable: true, get: function () { return step_1.validateWorkflowVersion; } });
Object.defineProperty(exports, "resumeWorkflow", { enumerable: true, get: function () { return step_1.resumeWorkflow; } });
Object.defineProperty(exports, "Status", { enumerable: true, get: function () { return step_1.Status; } });
Object.defineProperty(exports, "ExecutionPhase", { enumerable: true, get: function () { return step_1.ExecutionPhase; } });
Object.defineProperty(exports, "tagErrorPhase", { enumerable: true, get: function () { return step_1.tagErrorPhase; } });
Object.defineProperty(exports, "isReservedKey", { enumerable: true, get: function () { return step_1.isReservedKey; } });
Object.defineProperty(exports, "isFunction", { enumerable: true, get: function () { return step_1.isFunction; } });
Object.defineProperty(exports, "isObject", { enumerable: true, get: function () { return step_1.isObject; } });
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
exports.default = step_1.Step;
// Compatibility for both CJS require('fluid-func') and ESM import FluidFunc from 'fluid-func'
/* c8 ignore next 80 */
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
        NamespaceMismatchException: step_1.NamespaceMismatchException,
        CheckpointVersionException: step_1.CheckpointVersionException,
        FieldCollisionException: step_1.FieldCollisionException,
        IdempotencyConflictException: step_1.IdempotencyConflictException,
        CompensationException: step_1.CompensationException,
        WorkflowSuspendedException: step_1.WorkflowSuspendedException,
        DuplicateEventException: step_1.DuplicateEventException,
        ExpiredWaitException: step_1.ExpiredWaitException,
        WorkflowVersionMismatchException: step_1.WorkflowVersionMismatchException,
        GraphValidationException: step_1.GraphValidationException,
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
        putChainContext: storage_1.putChainContext,
        // Combinators
        parallel: step_1.parallel,
        all: step_1.all,
        allSettled: step_1.allSettled,
        race: step_1.race,
        when: step_1.when,
        branch: step_1.branch,
        map: step_1.map,
        waitForEvent: step_1.waitForEvent,
        wait: step_1.wait,
        resumeWorkflow: step_1.resumeWorkflow,
        toGraph: step_1.toGraph,
        validateGraph: step_1.validateGraph,
        assertValidGraph: step_1.assertValidGraph,
        inspectGraph: step_1.inspectGraph,
        toMermaid: step_1.toMermaid,
        toJSON: step_1.toJSON,
        toDot: step_1.toDot,
        // Idempotency
        InMemoryIdempotencyStore: step_1.InMemoryIdempotencyStore,
        defaultIdempotencyStore: step_1.defaultIdempotencyStore,
        buildIdempotencyKey: step_1.buildIdempotencyKey,
        // Compensation
        CompensationManager: step_1.CompensationManager,
        defaultCompensationManager: step_1.defaultCompensationManager,
        // Durable & Versioning
        DurableManager: step_1.DurableManager,
        defaultDurableManager: step_1.defaultDurableManager,
        validateWorkflowVersion: step_1.validateWorkflowVersion,
        parseDuration: step_1.parseDuration,
        Status: step_1.Status,
        ExecutionPhase: step_1.ExecutionPhase,
        tagErrorPhase: step_1.tagErrorPhase,
        ParallelMergeStrategy: step_1.ParallelMergeStrategy,
        ParallelMode: step_1.ParallelMode,
        isReservedKey: step_1.isReservedKey,
        isFunction: step_1.isFunction,
        isObject: step_1.isObject
    });
}
//# sourceMappingURL=index.js.map