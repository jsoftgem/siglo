"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutionPhase = exports.Status = exports.isPipeline = exports.pipe = exports.Chain = exports.Step = exports.resumeWorkflow = exports.validateWorkflowVersion = exports.defaultDurableManager = exports.DurableManager = exports.wait = exports.waitForEvent = exports.parseDuration = exports.ParallelMode = exports.ParallelMergeStrategy = exports.map = exports.branch = exports.when = exports.race = exports.allSettled = exports.all = exports.parallel = exports.defaultCompensationManager = exports.CompensationManager = exports.buildIdempotencyKey = exports.defaultIdempotencyStore = exports.InMemoryIdempotencyStore = exports.inspectGraph = exports.assertValidGraph = exports.validateGraph = exports.toGraph = exports.toPOJO = exports.normalizeError = exports.GraphValidationException = exports.WorkflowVersionMismatchException = exports.ExpiredWaitException = exports.DuplicateEventException = exports.WorkflowSuspendedException = exports.CompensationException = exports.IdempotencyConflictException = exports.FieldCollisionException = exports.CheckpointVersionException = exports.NamespaceMismatchException = exports.CheckpointConflictException = exports.StorageAdapterException = exports.ValidationException = exports.CancellationException = exports.FlowTimeoutException = exports.StepTimeoutException = exports.FluidFuncError = void 0;
exports.isObject = exports.isFunction = exports.isReservedKey = exports.tagErrorPhase = void 0;
exports.isFlow = isFlow;
exports.flattenSteps = flattenSteps;
exports.flow = flow;
const storage_1 = require("../storage");
const executer_1 = require("../executer");
const spec_1 = __importDefault(require("../spec"));
const configurator_1 = __importDefault(require("../configurator"));
const shared_1 = require("../../shared");
const context_1 = require("../context");
// Phase 2 imports
const graph_1 = require("../graph");
Object.defineProperty(exports, "toGraph", { enumerable: true, get: function () { return graph_1.toGraph; } });
Object.defineProperty(exports, "validateGraph", { enumerable: true, get: function () { return graph_1.validateGraph; } });
Object.defineProperty(exports, "assertValidGraph", { enumerable: true, get: function () { return graph_1.assertValidGraph; } });
Object.defineProperty(exports, "inspectGraph", { enumerable: true, get: function () { return graph_1.inspectGraph; } });
const idempotency_1 = require("../idempotency");
Object.defineProperty(exports, "InMemoryIdempotencyStore", { enumerable: true, get: function () { return idempotency_1.InMemoryIdempotencyStore; } });
Object.defineProperty(exports, "defaultIdempotencyStore", { enumerable: true, get: function () { return idempotency_1.defaultIdempotencyStore; } });
Object.defineProperty(exports, "buildIdempotencyKey", { enumerable: true, get: function () { return idempotency_1.buildIdempotencyKey; } });
const compensation_1 = require("../compensation");
Object.defineProperty(exports, "CompensationManager", { enumerable: true, get: function () { return compensation_1.CompensationManager; } });
Object.defineProperty(exports, "defaultCompensationManager", { enumerable: true, get: function () { return compensation_1.defaultCompensationManager; } });
const combinators_1 = require("../combinators");
Object.defineProperty(exports, "parallel", { enumerable: true, get: function () { return combinators_1.parallel; } });
Object.defineProperty(exports, "all", { enumerable: true, get: function () { return combinators_1.all; } });
Object.defineProperty(exports, "allSettled", { enumerable: true, get: function () { return combinators_1.allSettled; } });
Object.defineProperty(exports, "race", { enumerable: true, get: function () { return combinators_1.race; } });
Object.defineProperty(exports, "when", { enumerable: true, get: function () { return combinators_1.when; } });
Object.defineProperty(exports, "branch", { enumerable: true, get: function () { return combinators_1.branch; } });
Object.defineProperty(exports, "map", { enumerable: true, get: function () { return combinators_1.map; } });
Object.defineProperty(exports, "ParallelMergeStrategy", { enumerable: true, get: function () { return combinators_1.ParallelMergeStrategy; } });
Object.defineProperty(exports, "ParallelMode", { enumerable: true, get: function () { return combinators_1.ParallelMode; } });
const durable_1 = require("../durable");
Object.defineProperty(exports, "parseDuration", { enumerable: true, get: function () { return durable_1.parseDuration; } });
Object.defineProperty(exports, "waitForEvent", { enumerable: true, get: function () { return durable_1.waitForEvent; } });
Object.defineProperty(exports, "wait", { enumerable: true, get: function () { return durable_1.wait; } });
Object.defineProperty(exports, "DurableManager", { enumerable: true, get: function () { return durable_1.DurableManager; } });
Object.defineProperty(exports, "defaultDurableManager", { enumerable: true, get: function () { return durable_1.defaultDurableManager; } });
Object.defineProperty(exports, "validateWorkflowVersion", { enumerable: true, get: function () { return durable_1.validateWorkflowVersion; } });
Object.defineProperty(exports, "resumeWorkflow", { enumerable: true, get: function () { return durable_1.resumeWorkflow; } });
var executer_2 = require("../executer");
Object.defineProperty(exports, "FluidFuncError", { enumerable: true, get: function () { return executer_2.FluidFuncError; } });
Object.defineProperty(exports, "StepTimeoutException", { enumerable: true, get: function () { return executer_2.StepTimeoutException; } });
Object.defineProperty(exports, "FlowTimeoutException", { enumerable: true, get: function () { return executer_2.FlowTimeoutException; } });
Object.defineProperty(exports, "CancellationException", { enumerable: true, get: function () { return executer_2.CancellationException; } });
Object.defineProperty(exports, "ValidationException", { enumerable: true, get: function () { return executer_2.ValidationException; } });
Object.defineProperty(exports, "StorageAdapterException", { enumerable: true, get: function () { return executer_2.StorageAdapterException; } });
Object.defineProperty(exports, "CheckpointConflictException", { enumerable: true, get: function () { return executer_2.CheckpointConflictException; } });
Object.defineProperty(exports, "NamespaceMismatchException", { enumerable: true, get: function () { return executer_2.NamespaceMismatchException; } });
Object.defineProperty(exports, "CheckpointVersionException", { enumerable: true, get: function () { return executer_2.CheckpointVersionException; } });
Object.defineProperty(exports, "FieldCollisionException", { enumerable: true, get: function () { return executer_2.FieldCollisionException; } });
Object.defineProperty(exports, "IdempotencyConflictException", { enumerable: true, get: function () { return executer_2.IdempotencyConflictException; } });
Object.defineProperty(exports, "CompensationException", { enumerable: true, get: function () { return executer_2.CompensationException; } });
Object.defineProperty(exports, "WorkflowSuspendedException", { enumerable: true, get: function () { return executer_2.WorkflowSuspendedException; } });
Object.defineProperty(exports, "DuplicateEventException", { enumerable: true, get: function () { return executer_2.DuplicateEventException; } });
Object.defineProperty(exports, "ExpiredWaitException", { enumerable: true, get: function () { return executer_2.ExpiredWaitException; } });
Object.defineProperty(exports, "WorkflowVersionMismatchException", { enumerable: true, get: function () { return executer_2.WorkflowVersionMismatchException; } });
Object.defineProperty(exports, "GraphValidationException", { enumerable: true, get: function () { return executer_2.GraphValidationException; } });
Object.defineProperty(exports, "normalizeError", { enumerable: true, get: function () { return executer_2.normalizeError; } });
var proxy_1 = require("../context/proxy");
Object.defineProperty(exports, "toPOJO", { enumerable: true, get: function () { return proxy_1.toPOJO; } });
function isFlow(item) {
    if (!(0, shared_1.isObject)(item)) {
        return false;
    }
    if (item instanceof Step) {
        return false;
    }
    return (item.isFlow === true ||
        (((0, shared_1.isFunction)(item.run) || (0, shared_1.isFunction)(item.execute) || (0, shared_1.isFunction)(item.start)) &&
            !Array.isArray(item.specs) &&
            !(0, shared_1.isFunction)(item.onStart) &&
            !(0, shared_1.isFunction)(item.onbefore)));
}
function sanitizeFlowData(data) {
    if (!(0, shared_1.isObject)(data)) {
        return data;
    }
    const pojo = (0, context_1.toPOJO)(data);
    const clean = {};
    for (const k of Object.keys(pojo)) {
        if (!(0, shared_1.isReservedKey)(k)) {
            clean[k] = pojo[k];
        }
    }
    return clean;
}
function createFlowStep(flowInstance) {
    return new Step(flowInstance);
}
function flattenSteps(steps) {
    const result = [];
    for (const item of steps) {
        if (Array.isArray(item)) {
            result.push(...flattenSteps(item));
        }
        else if (isFlow(item)) {
            if (Array.isArray(item.steps)) {
                result.push(...flattenSteps(item.steps));
            }
            else {
                result.push(createFlowStep(item));
            }
        }
        else if (item) {
            result.push(item);
        }
    }
    return result;
}
function flow(...steps) {
    const flatSteps = flattenSteps(steps);
    let defaultTimeoutMs;
    let declaredVersion;
    const runFn = (param = {}, options) => {
        const effectiveOptions = {
            ...(defaultTimeoutMs !== undefined ? { timeout: defaultTimeoutMs } : {}),
            ...(declaredVersion !== undefined ? { workflowVersion: declaredVersion } : {}),
            ...options
        };
        return Step.start(flatSteps, param, effectiveOptions);
    };
    const flowObj = {
        execute: runFn,
        start: runFn,
        run: runFn,
        steps: flatSteps,
        isFlow: true,
        timeout(ms) {
            defaultTimeoutMs = ms;
            flowObj.timeoutMs = ms;
            return flowObj;
        },
        timeoutMs: undefined,
        workflowVersion: undefined,
        version(v) {
            declaredVersion = v;
            flowObj.workflowVersion = v;
            return flowObj;
        },
        toGraph() {
            return (0, graph_1.toGraph)(flowObj);
        },
        inspect() {
            return (0, graph_1.inspectGraph)(flowObj);
        },
        resume(correlationKeyOrStackId, eventPayload, options) {
            return (0, durable_1.resumeWorkflow)(flowObj, correlationKeyOrStackId, eventPayload, options);
        },
        compensate(stackId, options) {
            return compensation_1.defaultCompensationManager.runCompensations(stackId, undefined, options);
        }
    };
    return flowObj;
}
class Step {
    name;
    action;
    specs;
    onbefore;
    onskip;
    onafter;
    onfail;
    sequence;
    reducer;
    isStrict;
    cachedLast;
    cacheOptions;
    timeoutMs;
    $chainId;
    $stepId;
    func;
    isModern;
    // Phase 2
    compensationHandler;
    compensationOptions;
    idempotencyKey;
    idempotencyOptions;
    workflowNode;
    constructor(nameOrAction, action = (_parameter) => undefined, sequence = []) {
        if (isFlow(nameOrAction)) {
            const flowInstance = nameOrAction;
            this.action = async (param) => {
                const cleanParam = sanitizeFlowData(param);
                const execFn = (flowInstance.run || flowInstance.execute || flowInstance.start).bind(flowInstance);
                const raw = await execFn(cleanParam, { pojo: true });
                return sanitizeFlowData(raw);
            };
            this.name = '';
        }
        else if ((0, shared_1.isFunction)(nameOrAction)) {
            this.action = nameOrAction;
            this.name = '';
        }
        else {
            this.name = nameOrAction || '';
            this.action = action;
        }
        this.func = this.name;
        this.$chainId = (0, shared_1.generateUUID)();
        this.$stepId = this.$chainId;
        this.specs = [];
        this.onbefore = () => true;
        this.sequence = sequence || [];
        if (!this.sequence.length) {
            this.sequence.push(this);
        }
    }
    static start(steps, param = {}, options) {
        if (!steps) {
            return new executer_1.Executer().start(param, steps, options);
        }
        let effParam = param;
        let effOptions = options;
        if (options === undefined && param && (param.signal || param.namespace || param.timeout || param.timeoutMs || param.pojo)) {
            effOptions = param;
            effParam = {};
        }
        const normalizedSteps = isFlow(steps)
            ? (Array.isArray(steps.steps) ? flattenSteps(steps.steps) : [createFlowStep(steps)])
            : Array.isArray(steps)
                ? flattenSteps(steps)
                : steps;
        return new executer_1.Executer().start(effParam, normalizedSteps, effOptions);
    }
    static create(nameOrAction, action, sequence) {
        return new Step(nameOrAction, action, sequence);
    }
    static flow = flow;
    static isFlow = isFlow;
    static pipe = flow;
    static isPipeline = isFlow;
    static toPOJO = context_1.toPOJO;
    static checkpoint = storage_1.checkpoint;
    static restoreCheckpoint = storage_1.restoreCheckpoint;
    static serializeState = storage_1.serializeState;
    static hydrateState = storage_1.hydrateState;
    static useStorage = storage_1.useStorage;
    static getCheckpoint = storage_1.getCheckpoint;
    static setErrorMode = storage_1.setErrorMode;
    static getErrorMode = storage_1.getErrorMode;
    static cleanExpiredCheckpoints = storage_1.cleanExpiredCheckpoints;
    // Phase 2 static helpers
    static parallel = combinators_1.parallel;
    static all = combinators_1.all;
    static allSettled = combinators_1.allSettled;
    static race = combinators_1.race;
    static when = combinators_1.when;
    static branch = combinators_1.branch;
    static map = combinators_1.map;
    static waitForEvent = durable_1.waitForEvent;
    static wait = durable_1.wait;
    static resumeWorkflow = durable_1.resumeWorkflow;
    static toGraph = graph_1.toGraph;
    static inspectGraph = graph_1.inspectGraph;
    static validateGraph = graph_1.validateGraph;
    static assertValidGraph = graph_1.assertValidGraph;
    timeout(ms) {
        this.timeoutMs = ms;
        return this;
    }
    modern() {
        this.isModern = true;
        return this;
    }
    reduce(field) {
        this.reducer = field;
        return this;
    }
    schema(schemaObj) {
        const spec = new spec_1.default('$root$');
        spec.schema(schemaObj);
        this.specs.push(spec);
        return this;
    }
    spec(fieldOrSchema, json = {}) {
        const isFieldString = typeof fieldOrSchema === 'string';
        const field = isFieldString ? fieldOrSchema : '$root$';
        const spec = new spec_1.default(field);
        const isSchemaObj = (obj) => obj && (obj['~standard'] || typeof obj.safeParse === 'function' || typeof obj.parse === 'function');
        if (!isFieldString) {
            spec.schema(fieldOrSchema);
        }
        else if (isSchemaObj(json)) {
            spec.schema(json);
        }
        else {
            if (json.schema) {
                spec.schema(json.schema);
            }
            if (json.default !== undefined || json.defaultValue !== undefined) {
                spec.default(json.default !== undefined ? json.default : json.defaultValue);
            }
            if (json.require !== undefined) {
                spec.require(json.require, json.requireMessage);
            }
            if (json.validate || json.validator) {
                spec.validate(json.validate || json.validator);
            }
            if (json.transform || json.transformer) {
                spec.transform(json.transform || json.transformer);
            }
            if (json.translate || json.translator) {
                spec.translate(json.translate || json.translator);
            }
        }
        this.specs.push(spec);
        return this;
    }
    strict() {
        this.isStrict = true;
        return this;
    }
    onBefore(onBefore) {
        this.onbefore = onBefore;
        return this;
    }
    onSkip(onSkip) {
        this.onskip = onSkip;
        return this;
    }
    onAfter(onAfter) {
        this.onafter = onAfter;
        return this;
    }
    onStart(action) {
        this.action = action;
        return this;
    }
    onFail(onFail) {
        this.onfail = onFail;
        return this;
    }
    cache(cachedLastOrOptions) {
        if ((0, shared_1.isObject)(cachedLastOrOptions)) {
            this.cacheOptions = cachedLastOrOptions;
            this.cachedLast = cachedLastOrOptions.ttl || 1500;
        }
        else {
            this.cachedLast = cachedLastOrOptions || 1500;
        }
        return this;
    }
    compensate(handler, options) {
        this.compensationHandler = handler;
        this.compensationOptions = options;
        return this;
    }
    idempotent(keyOrFn, options) {
        this.idempotencyKey = keyOrFn || ((ctx) => ctx.idempotencyKey || ctx.id || this.name);
        this.idempotencyOptions = options;
        return this;
    }
    toGraph() {
        return (0, graph_1.toGraph)(this);
    }
    inspect() {
        return (0, graph_1.inspectGraph)(this);
    }
    execute(param, options) {
        let effParam = param;
        let effOptions = options;
        /* c8 ignore next 4 */
        if (options === undefined && param && (param.signal || param.namespace || param.timeout || param.timeoutMs || param.pojo)) {
            effOptions = param;
            effParam = {};
        }
        return Step.start(this.sequence.length ? [...this.sequence] : this, effParam, effOptions);
    }
    run(param, options) {
        return this.execute(param, options);
    }
    static config(props) {
        configurator_1.default.configure(props);
    }
}
exports.Step = Step;
// Compatibility Aliases
/** @deprecated Use `Step` instead of `Chain`. */
exports.Chain = Step;
/** @deprecated Use `flow` instead of `pipe`. */
exports.pipe = flow;
/** @deprecated Use `isFlow` instead of `isPipeline`. */
exports.isPipeline = isFlow;
exports.default = Step;
var shared_2 = require("../../shared");
Object.defineProperty(exports, "Status", { enumerable: true, get: function () { return shared_2.Status; } });
Object.defineProperty(exports, "ExecutionPhase", { enumerable: true, get: function () { return shared_2.ExecutionPhase; } });
Object.defineProperty(exports, "tagErrorPhase", { enumerable: true, get: function () { return shared_2.tagErrorPhase; } });
Object.defineProperty(exports, "isReservedKey", { enumerable: true, get: function () { return shared_2.isReservedKey; } });
Object.defineProperty(exports, "isFunction", { enumerable: true, get: function () { return shared_2.isFunction; } });
Object.defineProperty(exports, "isObject", { enumerable: true, get: function () { return shared_2.isObject; } });
//# sourceMappingURL=index.js.map