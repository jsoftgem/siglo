"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPipeline = exports.pipe = exports.Step = exports.toPOJO = exports.FlowTimeoutException = exports.StepTimeoutException = void 0;
exports.isFlow = isFlow;
exports.flattenSteps = flattenSteps;
exports.flow = flow;
const storage_1 = require("../storage");
const executer_1 = require("../executer");
const spec_1 = __importDefault(require("../spec"));
const configurator_1 = __importDefault(require("../configurator"));
const shared_1 = require("../../shared");
const context_1 = require("../context");
var executer_2 = require("../executer");
Object.defineProperty(exports, "StepTimeoutException", { enumerable: true, get: function () { return executer_2.StepTimeoutException; } });
Object.defineProperty(exports, "FlowTimeoutException", { enumerable: true, get: function () { return executer_2.FlowTimeoutException; } });
var proxy_1 = require("../context/proxy");
Object.defineProperty(exports, "toPOJO", { enumerable: true, get: function () { return proxy_1.toPOJO; } });
function isFlow(item) {
    if (!item || typeof item !== 'object') {
        return false;
    }
    if (item instanceof Step) {
        return false;
    }
    return (item.isFlow === true ||
        ((typeof item.run === 'function' || typeof item.execute === 'function' || typeof item.start === 'function') &&
            !Array.isArray(item.specs) &&
            typeof item.onStart !== 'function' &&
            typeof item.onbefore !== 'function'));
}
function sanitizeFlowData(data) {
    if (!data || typeof data !== 'object') {
        return data;
    }
    const pojo = (0, context_1.toPOJO)(data);
    const clean = {};
    for (const k of Object.keys(pojo)) {
        if (k !== '$chainId' && k !== '$stepId' && k !== '$stackId' && k !== '$tenantId' && k !== '$$$validators' && k !== '$steps' && k !== '$history') {
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
    const runFn = (param = {}, options) => {
        const effectiveOptions = {
            ...(defaultTimeoutMs !== undefined ? { timeout: defaultTimeoutMs } : {}),
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
        timeoutMs: undefined
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
    timeoutMs;
    $chainId;
    $stepId;
    func;
    isModern;
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
        else if (typeof nameOrAction === 'function') {
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
        if (options === undefined && param && (param.signal || param.tenantId || param.timeout || param.timeoutMs || param.pojo)) {
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
    static create(nameOrAction, action) {
        return new Step(nameOrAction, action);
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
    cache(cachedLast) {
        this.cachedLast = cachedLast || 1500;
        return this;
    }
    execute(param, options) {
        let effParam = param;
        let effOptions = options;
        /* c8 ignore next 4 */
        if (options === undefined && param && (param.signal || param.tenantId || param.timeout || param.timeoutMs || param.pojo)) {
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
// Aliases
exports.pipe = flow;
exports.isPipeline = isFlow;
exports.default = Step;
//# sourceMappingURL=index.js.map