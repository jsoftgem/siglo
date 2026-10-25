import {
    checkpoint,
    restoreCheckpoint,
    serializeState,
    hydrateState,
    useStorage,
    getCheckpoint,
    setErrorMode,
    getErrorMode,
    cleanExpiredCheckpoints
} from '../storage';
import { Executer } from '../executer';
import Spec, { SpecData } from '../spec';
import Configurator from '../configurator';
import { generateUUID, isReservedKey, isFunction, isObject } from '../../shared';
import { toPOJO } from '../context';
import { RetryConfig } from '../executer';
import { CacheOptions } from '../cache';

// Phase 2 imports
import {
    WorkflowNode,
    WorkflowNodeType,
    StepNode,
    SequenceNode,
    ParallelNode,
    BranchNode,
    WaitNode,
    MapNode,
    GraphValidationResult,
    GraphInspectionResult,
    GraphInspectionEdge,
    toGraph,
    validateGraph,
    assertValidGraph,
    inspectGraph
} from '../graph';

import {
    IdempotencyStore,
    IdempotencyClaimStatus,
    IdempotencyRecord,
    IdempotencyOptions,
    InMemoryIdempotencyStore,
    defaultIdempotencyStore,
    buildIdempotencyKey
} from '../idempotency';

import {
    CompensationHandler,
    CompensationOptions,
    CompensationRecord,
    CompensationRunResult,
    CompensationManager,
    defaultCompensationManager
} from '../compensation';

import {
    parallel,
    all,
    allSettled,
    race,
    when,
    branch,
    map,
    ParallelOptions,
    ParallelMergeStrategy,
    ParallelMode,
    BranchExecutionSummary,
    BranchPredicate,
    BranchSelector,
    MapOptions,
    MapItemAccessor
} from '../combinators';

import {
    WaitForEventOptions,
    WaitingWorkflowRecord,
    StateMigrationFn,
    ResumeOptions,
    parseDuration,
    waitForEvent,
    wait,
    DurableManager,
    defaultDurableManager,
    validateWorkflowVersion,
    resumeWorkflow
} from '../durable';

export {
    FluidFuncError,
    ExecutionErrorMetadata,
    StepTimeoutException,
    FlowTimeoutException,
    CancellationException,
    ValidationException,
    ValidationErrorDetail,
    StorageAdapterException,
    CheckpointConflictException,
    NamespaceMismatchException,
    CheckpointVersionException,
    FieldCollisionException,
    CollisionDetail,
    IdempotencyConflictException,
    CompensationException,
    CompensationErrorDetail,
    WorkflowSuspendedException,
    DuplicateEventException,
    ExpiredWaitException,
    WorkflowVersionMismatchException,
    GraphValidationException,
    normalizeError,
    RetryConfig,
    RetryPredicate
} from '../executer';

export {
    SerializedExecutionStack,
    SerializedStorageState,
    StorageAdapter,
    ContextChangeEvent,
    CacheEvent,
    StorageErrorMode,
    CheckpointOptions
} from '../storage';

export { CacheOptions } from '../cache';
export { toPOJO } from '../context/proxy';

// Phase 2 Re-exports
export {
    WorkflowNode,
    WorkflowNodeType,
    StepNode,
    SequenceNode,
    ParallelNode,
    BranchNode,
    WaitNode,
    MapNode,
    GraphValidationResult,
    GraphInspectionResult,
    GraphInspectionEdge,
    toGraph,
    validateGraph,
    assertValidGraph,
    inspectGraph
};

export {
    IdempotencyStore,
    IdempotencyClaimStatus,
    IdempotencyRecord,
    IdempotencyOptions,
    InMemoryIdempotencyStore,
    defaultIdempotencyStore,
    buildIdempotencyKey
};

export {
    CompensationHandler,
    CompensationOptions,
    CompensationRecord,
    CompensationRunResult,
    CompensationManager,
    defaultCompensationManager
};

export {
    parallel,
    all,
    allSettled,
    race,
    when,
    branch,
    map,
    ParallelOptions,
    ParallelMergeStrategy,
    ParallelMode,
    BranchExecutionSummary,
    BranchPredicate,
    BranchSelector,
    MapOptions,
    MapItemAccessor
};

export {
    WaitForEventOptions,
    WaitingWorkflowRecord,
    StateMigrationFn,
    ResumeOptions,
    parseDuration,
    waitForEvent,
    wait,
    DurableManager,
    defaultDurableManager,
    validateWorkflowVersion,
    resumeWorkflow
};

export interface ExecutionOptions {
    signal?: AbortSignal;
    pojo?: boolean;
    mode?: 'pojo' | 'wrapped';
    namespace?: string;
    timeout?: number;
    timeoutMs?: number;
    workflowId?: string;
    checkpoint?: boolean;
    // Phase 2
    durable?: boolean;
    workflowVersion?: string | number;
    idempotencyKey?: string | ((ctx: any) => string);
    idempotencyStore?: IdempotencyStore;
    idempotencyTtlMs?: number;
    migrations?: any;
    stackId?: string;
}

export type StepAction<TInput = any, TOutput = any> = (parameter: TInput, current?: any, index?: number) => TOutput | Promise<TOutput>;
export type OnBeforeAction<TInput = any> = (parameter: TInput) => boolean | Promise<boolean>;
export type OnSkipAction<TInput = any, TFallback = any> = (parameter: TInput) => TFallback | Promise<TFallback>;
export type OnAfterAction<TOutput = any, TInput = any> = (output: TOutput, parameter: TInput) => any | Promise<any>;
export type OnFailAction = ((error: any, retry: (fallback?: any) => void, reject: (err?: any) => void) => any) | RetryConfig;

export interface Flow<TInput = any, TOutput = any> {
    execute: (param?: TInput, options?: ExecutionOptions) => Promise<TOutput>;
    start: (param?: TInput, options?: ExecutionOptions) => Promise<TOutput>;
    run: (param?: TInput, options?: ExecutionOptions) => Promise<TOutput>;
    steps: Step<any, any>[];
    readonly isFlow?: boolean;
    timeout: (ms: number) => Flow<TInput, TOutput>;
    timeoutMs?: number;
    workflowVersion?: string | number;
    version: (v: string | number) => Flow<TInput, TOutput>;
    toGraph: () => WorkflowNode;
    inspect: () => GraphInspectionResult;
    resume: (correlationKeyOrStackId: string, eventPayload?: any, options?: ExecutionOptions) => Promise<any>;
    compensate: (stackId: string, options?: any) => Promise<any>;
}

export type FlowItem<TIn = any, TOut = any> =
    | Step<TIn, TOut>
    | Flow<TIn, TOut>;

export type FlowArg<TIn = any, TOut = any> =
    | FlowItem<TIn, TOut>
    | FlowArg<TIn, TOut>[];

export function isFlow(item: any): item is Flow {
    if (!isObject(item)) {
        return false;
    }
    if (item instanceof Step) {
        return false;
    }
    return (
        item.isFlow === true ||
        ((isFunction(item.run) || isFunction(item.execute) || isFunction(item.start)) &&
            !Array.isArray(item.specs) &&
            !isFunction(item.onStart) &&
            !isFunction(item.onbefore))
    );
}

function sanitizeFlowData(data: any): any {
    if (!isObject(data)) {
        return data;
    }
    const pojo = toPOJO(data);
    const clean: Record<string, any> = {};
    for (const k of Object.keys(pojo)) {
        if (!isReservedKey(k)) {
            clean[k] = (pojo as any)[k];
        }
    }
    return clean;
}

function createFlowStep(flowInstance: Flow<any, any>): Step<any, any> {
    return new Step(flowInstance);
}

export function flattenSteps(
    steps: any[]
): Step<any, any>[] {
    const result: Step<any, any>[] = [];
    for (const item of steps) {
        if (Array.isArray(item)) {
            result.push(...flattenSteps(item));
        } else if (isFlow(item)) {
            if (Array.isArray(item.steps)) {
                result.push(...flattenSteps(item.steps));
            } else {
                result.push(createFlowStep(item));
            }
        } else if (item) {
            result.push(item);
        }
    }
    return result;
}

export function flow<TInput = any, TOutput = any>(
    ...steps: FlowArg[]
): Flow<TInput, TOutput> {
    const flatSteps = flattenSteps(steps);
    let defaultTimeoutMs: number | undefined;
    let declaredVersion: string | number | undefined;

    const runFn = (param: any = {}, options?: ExecutionOptions) => {
        const effectiveOptions: ExecutionOptions = {
            ...(defaultTimeoutMs !== undefined ? { timeout: defaultTimeoutMs } : {}),
            ...(declaredVersion !== undefined ? { workflowVersion: declaredVersion } : {}),
            ...options
        };
        return Step.start(flatSteps, param, effectiveOptions) as Promise<TOutput>;
    };

    const flowObj: Flow<TInput, TOutput> = {
        execute: runFn,
        start: runFn,
        run: runFn,
        steps: flatSteps,
        isFlow: true,
        timeout(ms: number) {
            defaultTimeoutMs = ms;
            flowObj.timeoutMs = ms;
            return flowObj;
        },
        timeoutMs: undefined,
        workflowVersion: undefined,
        version(v: string | number) {
            declaredVersion = v;
            flowObj.workflowVersion = v;
            return flowObj;
        },
        toGraph() {
            return toGraph(flowObj);
        },
        inspect() {
            return inspectGraph(flowObj);
        },
        resume(correlationKeyOrStackId: string, eventPayload?: any, options?: ExecutionOptions) {
            return resumeWorkflow(flowObj, correlationKeyOrStackId, eventPayload, options);
        },
        compensate(stackId: string, options?: any) {
            return defaultCompensationManager.runCompensations(stackId, undefined, options);
        }
    };
    return flowObj;
}

export class Step<TInput = any, TOutput = any> {
    name: string;
    action: StepAction<TInput, TOutput>;
    specs: Spec[];
    onbefore: OnBeforeAction<TInput>;
    onskip?: OnSkipAction<TInput>;
    onafter?: OnAfterAction<TOutput, TInput>;
    onfail?: OnFailAction;
    sequence: Step<any, any>[];
    reducer?: string;
    isStrict?: boolean;
    cachedLast?: number;
    cacheOptions?: CacheOptions;
    timeoutMs?: number;
    $chainId?: string;
    $stepId?: string;
    func?: string;
    isModern?: boolean;
    // Phase 2
    compensationHandler?: any;
    compensationOptions?: CompensationOptions;
    idempotencyKey?: string | ((ctx: any) => string);
    idempotencyOptions?: { ttlMs?: number; store?: IdempotencyStore };
    workflowNode?: WorkflowNode;

    constructor(
        nameOrAction?: string | StepAction<TInput, TOutput> | Flow<TInput, TOutput>,
        action: StepAction<TInput, TOutput> = (_parameter: any) => undefined as any,
        sequence: Step<any, any>[] = []
    ) {
        if (isFlow(nameOrAction)) {
            const flowInstance = nameOrAction;
            this.action = async (param: any) => {
                const cleanParam = sanitizeFlowData(param);
                const execFn = (flowInstance.run || flowInstance.execute || flowInstance.start).bind(flowInstance);
                const raw = await execFn(cleanParam, { pojo: true });
                return sanitizeFlowData(raw);
            };
            this.name = '';
        } else if (isFunction(nameOrAction)) {
            this.action = nameOrAction;
            this.name = '';
        } else {
            this.name = (nameOrAction as string) || '';
            this.action = action;
        }
        this.func = this.name;
        this.$chainId = generateUUID();
        this.$stepId = this.$chainId;
        this.specs = [];
        this.onbefore = () => true;
        this.sequence = sequence || [];
        if (!this.sequence.length) {
            this.sequence.push(this);
        }
    }

    static start<TOut = any>(
        steps: Step | Step[] | Flow | (Step | Flow)[],
        param?: any,
        options?: ExecutionOptions
    ): Promise<TOut>;
    static start(steps?: undefined, param?: any, options?: ExecutionOptions): undefined;
    static start(steps?: any, param: any = {}, options?: ExecutionOptions): any {
        if (!steps) {
            return new Executer().start(param, steps, options);
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
        return new Executer().start(effParam, normalizedSteps, effOptions);
    }

    static create<TIn = any, TOut = any>(
        nameOrAction?: string | StepAction<TIn, TOut> | Flow<TIn, TOut>,
        action?: StepAction<TIn, TOut>,
        sequence?: Step<any, any>[]
    ): Step<TIn, TOut> {
        return new Step<TIn, TOut>(nameOrAction as any, action, sequence);
    }

    static flow = flow;
    static isFlow = isFlow;
    static pipe = flow;
    static isPipeline = isFlow;
    static toPOJO = toPOJO;
    static checkpoint = checkpoint;
    static restoreCheckpoint = restoreCheckpoint;
    static serializeState = serializeState;
    static hydrateState = hydrateState;
    static useStorage = useStorage;
    static getCheckpoint = getCheckpoint;
    static setErrorMode = setErrorMode;
    static getErrorMode = getErrorMode;
    static cleanExpiredCheckpoints = cleanExpiredCheckpoints;

    // Phase 2 static helpers
    static parallel = parallel;
    static all = all;
    static allSettled = allSettled;
    static race = race;
    static when = when;
    static branch = branch;
    static map = map;
    static waitForEvent = waitForEvent;
    static wait = wait;
    static resumeWorkflow = resumeWorkflow;
    static toGraph = toGraph;
    static inspectGraph = inspectGraph;
    static validateGraph = validateGraph;
    static assertValidGraph = assertValidGraph;

    timeout(ms: number): Step<TInput, TOutput> {
        this.timeoutMs = ms;
        return this;
    }

    modern(): Step<TInput, TOutput> {
        this.isModern = true;
        return this;
    }

    reduce(field: string): Step<TInput, TOutput> {
        this.reducer = field;
        return this;
    }

    schema<TSchema = any>(schemaObj: TSchema): Step<TInput, TOutput> {
        const spec = new Spec('$root$');
        spec.schema(schemaObj);
        this.specs.push(spec);
        return this;
    }

    spec(fieldOrSchema: string | any, json: SpecData | any = {}): Step<TInput, TOutput> {
        const isFieldString = typeof fieldOrSchema === 'string';
        const field = isFieldString ? fieldOrSchema : '$root$';
        const spec = new Spec(field);
        const isSchemaObj = (obj: any) =>
            obj && (obj['~standard'] || typeof obj.safeParse === 'function' || typeof obj.parse === 'function');

        if (!isFieldString) {
            spec.schema(fieldOrSchema);
        } else if (isSchemaObj(json)) {
            spec.schema(json);
        } else {
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

    strict(): Step<TInput, TOutput> {
        this.isStrict = true;
        return this;
    }

    onBefore(onBefore: OnBeforeAction<TInput>): Step<TInput, TOutput> {
        this.onbefore = onBefore;
        return this;
    }

    onSkip(onSkip: OnSkipAction<TInput>): Step<TInput, TOutput> {
        this.onskip = onSkip;
        return this;
    }

    onAfter(onAfter: OnAfterAction<TOutput, TInput>): Step<TInput, TOutput> {
        this.onafter = onAfter;
        return this;
    }

    onStart(action: StepAction<TInput, TOutput>): Step<TInput, TOutput> {
        this.action = action;
        return this;
    }

    onFail(onFail: OnFailAction): Step<TInput, TOutput> {
        this.onfail = onFail;
        return this;
    }

    cache(cachedLastOrOptions?: number | CacheOptions): Step<TInput, TOutput> {
        if (isObject(cachedLastOrOptions)) {
            this.cacheOptions = cachedLastOrOptions;
            this.cachedLast = cachedLastOrOptions.ttl || 1500;
        } else {
            this.cachedLast = cachedLastOrOptions || 1500;
        }
        return this;
    }

    compensate(handler: any, options?: CompensationOptions): Step<TInput, TOutput> {
        this.compensationHandler = handler;
        this.compensationOptions = options;
        return this;
    }

    idempotent(keyOrFn?: string | ((ctx: any) => string), options?: { ttlMs?: number; store?: IdempotencyStore }): Step<TInput, TOutput> {
        this.idempotencyKey = keyOrFn || ((ctx: any) => ctx.idempotencyKey || ctx.id || this.name);
        this.idempotencyOptions = options;
        return this;
    }

    toGraph(): WorkflowNode {
        return toGraph(this);
    }

    inspect(): GraphInspectionResult {
        return inspectGraph(this);
    }

    execute(param?: TInput, options?: ExecutionOptions): Promise<TOutput> {
        let effParam = param;
        let effOptions = options;
        /* c8 ignore next 4 */
        if (options === undefined && param && ((param as any).signal || (param as any).namespace || (param as any).timeout || (param as any).timeoutMs || (param as any).pojo)) {
            effOptions = param as any;
            effParam = {} as any;
        }
        return Step.start<TOutput>(this.sequence.length ? [...this.sequence] : this, effParam, effOptions);
    }

    run(param?: TInput, options?: ExecutionOptions): Promise<TOutput> {
        return this.execute(param, options);
    }

    static config(props: Record<string, any>): void {
        Configurator.configure(props);
    }
/* c8 ignore next */
}

// Compatibility Aliases
/** @deprecated Use `Step` instead of `Chain`. */
export const Chain = Step;
export type Chain<TIn = any, TOut = any> = Step<TIn, TOut>;

/** @deprecated Use `flow` instead of `pipe`. */
export const pipe = flow;

/** @deprecated Use `Flow` instead of `Pipeline`. */
export type Pipeline<TIn = any, TOut = any> = Flow<TIn, TOut>;
export type PipeItem<TIn = any, TOut = any> = FlowItem<TIn, TOut>;
export type PipeArg<TIn = any, TOut = any> = FlowArg<TIn, TOut>;

/** @deprecated Use `isFlow` instead of `isPipeline`. */
export const isPipeline = isFlow;

export default Step;

export { Status, ExecutionPhase, tagErrorPhase, isReservedKey, isFunction, isObject } from '../../shared';
