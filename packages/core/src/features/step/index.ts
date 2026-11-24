import {
    checkpoint,
    cleanExpiredCheckpoints,
    getCheckpoint,
    getErrorMode,
    hydrateState,
    restoreCheckpoint,
    serializeState,
    setErrorMode,
    useStorage,
} from '../storage';
import { Executer, RetryConfig, UnresolvableCompensationException } from '../executer';
import {
    StepExecutionHook,
    stepExecutionHookStorage,
    withStepExecutionHook,
    getStepExecutionHook,
} from '../executer/hooks';
import Spec, { SpecData } from '../spec';
import Configurator from '../configurator';
import { DurationInput, DynamicOption, generateUUID, isFunction, isObject, isReservedKey } from '../../shared';
import { toPOJO } from '../context';
import { CacheOptions } from '../cache';
import {
    ComputeStep,
    SyncStepAction,
    SyncValue,
    SyncSpec,
    SyncSpecData,
    runSpecsSync,
    ComputeCache,
    ComputeCacheOptions,
    clearComputeCaches,
    COMPUTE_NETWORK_POLICY,
    executeComputeStepSync,
} from './compute';

// Phase 2 imports
import {
    assertValidGraph,
    BranchNode,
    DotExportOptions,
    GraphInspectionEdge,
    GraphInspectionResult,
    GraphValidationResult,
    inspectGraph,
    isWorkflowNode,
    MapNode,
    MermaidExportOptions,
    ParallelNode,
    SequenceNode,
    StepNode,
    toDot,
    toGraph,
    toJSON,
    toMermaid,
    validateGraph,
    WaitNode,
    WorkflowNode,
    WorkflowNodeType,
} from '../graph';

import {
    buildIdempotencyKey,
    defaultIdempotencyStore,
    IdempotencyClaimStatus,
    IdempotencyOptions,
    IdempotencyRecord,
    IdempotencyStore,
    InMemoryIdempotencyStore,
    isPermanentBusinessError,
} from '../idempotency';

import {
    clearCompensationHandlers,
    CompensationHandler,
    CompensationManager,
    CompensationOptions,
    CompensationRecord,
    CompensationRunOptions,
    CompensationRunResult,
    defaultCompensationManager,
    getCompensationHandler,
    hasCompensationHandler,
    reconcileAbandonedStacks,
    registerCompensationHandler,
    unregisterCompensationHandler,
} from '../compensation';

import {
    all,
    allSettled,
    branch,
    BranchExecutionSummary,
    BranchPredicate,
    BranchSelector,
    map,
    MapItemAccessor,
    MapOptions,
    parallel,
    ParallelMergeStrategy,
    ParallelMode,
    ParallelOptions,
    race,
    when,
} from '../combinators';

import {
    defaultDurableManager,
    DurableManager,
    parseDuration,
    ResumeOptions,
    resumeWorkflow,
    StateMigrationFn,
    validateWorkflowVersion,
    wait,
    waitForEvent,
    WaitForEventOptions,
    WaitForEventResult,
    WaitRecordStatus,
    WaitingWorkflowRecord,
    isWorkflowSuspended,
    WaitTimerResult,
    WorkflowSuspensionResult,
} from '../durable';

import {
    defaultWorkflowEventEmitter,
    emitMonitoringEvent,
    getDefaultMonitor,
    redactEvent,
    RedactionOptions,
    redactValue,
    setDefaultMonitor,
    WorkflowEventEmitter,
    WorkflowExecutionEvent,
    WorkflowExecutionEventMap,
    WorkflowExecutionEventType,
} from '../events';

import {
    ActiveNetworkPolicyContext,
    EffectiveNetworkPolicy,
    ensureNetworkInterceptorsInstalled,
    HostPattern,
    installNetworkInterceptors,
    isHostAllowed,
    isLocalhost,
    isNetworkInterceptorsInstalled,
    isPrivateOrRestrictedIP,
    isUnixSocket,
    isUnixSocketAllowed,
    NetworkPolicyConfig,
    networkPolicyStorage,
    normalizeIP,
    resolveEffectiveNetworkPolicy,
    uninstallNetworkInterceptors,
    validateAndPinTarget,
} from '../network';

export {
    SigloError,
    RivuletError,
    ExecutionErrorMetadata,
    StepTimeoutException,
    FlowTimeoutException,
    CancellationException,
    ValidationException,
    ValidationErrorDetail,
    StorageAdapterException,
    CheckpointConflictException,
    OptimisticLockException,
    WorkflowAlreadyResumedException,
    NamespaceMismatchException,
    CheckpointVersionException,
    FieldCollisionException,
    CollisionDetail,
    IdempotencyConflictException,
    CompensationException,
    CompensationErrorDetail,
    UnresolvableCompensationException,
    WorkflowSuspendedException,
    DuplicateEventException,
    ExpiredWaitException,
    WorkflowVersionMismatchException,
    GraphValidationException,
    NetworkPolicyViolationException,
    normalizeError,
    RetryConfig,
    RetryPredicate,
} from '../executer';
export {
    StepExecutionContext,
    StepExecutionHook,
    stepExecutionHookStorage,
    withStepExecutionHook,
    getStepExecutionHook,
} from '../executer/hooks';

export {
    SerializedExecutionStack,
    SerializedStorageState,
    StorageAdapter,
    ContextChangeEvent,
    CacheEvent,
    StorageErrorMode,
    CheckpointOptions,
} from '../storage';

export { CacheOptions } from '../cache';
export { toPOJO } from '../context/proxy';
export {
    ComputeStep,
    SyncStepAction,
    SyncValue,
    SyncSpec,
    SyncSpecData,
    runSpecsSync,
    ComputeCache,
    ComputeCacheOptions,
    clearComputeCaches,
    COMPUTE_NETWORK_POLICY,
    executeComputeStepSync,
};

// Phase 2 & 4 Graph Re-exports
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
    isWorkflowNode,
    validateGraph,
    assertValidGraph,
    inspectGraph,
    toMermaid,
    toJSON,
    toDot,
    MermaidExportOptions,
    DotExportOptions,
};

export {
    IdempotencyStore,
    IdempotencyClaimStatus,
    IdempotencyRecord,
    IdempotencyOptions,
    InMemoryIdempotencyStore,
    defaultIdempotencyStore,
    buildIdempotencyKey,
    isPermanentBusinessError,
};

export {
    CompensationHandler,
    CompensationOptions,
    CompensationRecord,
    CompensationRunResult,
    CompensationManager,
    defaultCompensationManager,
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
    MapItemAccessor,
};

export {
    WaitForEventOptions,
    WaitForEventResult,
    WaitRecordStatus,
    WaitingWorkflowRecord,
    isWorkflowSuspended,
    WaitTimerResult,
    WorkflowSuspensionResult,
    StateMigrationFn,
    ResumeOptions,
    parseDuration,
    waitForEvent,
    wait,
    DurableManager,
    defaultDurableManager,
    validateWorkflowVersion,
    resumeWorkflow,
};

export {
    WorkflowExecutionEvent,
    WorkflowExecutionEventType,
    WorkflowExecutionEventMap,
    WorkflowEventEmitter,
    defaultWorkflowEventEmitter,
    setDefaultMonitor,
    getDefaultMonitor,
    emitMonitoringEvent,
    redactEvent,
    redactValue,
    RedactionOptions,
};

export {
    NetworkPolicyConfig,
    EffectiveNetworkPolicy,
    HostPattern,
    ActiveNetworkPolicyContext,
    resolveEffectiveNetworkPolicy,
    networkPolicyStorage,
    installNetworkInterceptors,
    uninstallNetworkInterceptors,
    isNetworkInterceptorsInstalled,
    ensureNetworkInterceptorsInstalled,
    isHostAllowed,
    isLocalhost,
    isPrivateOrRestrictedIP,
    normalizeIP,
    validateAndPinTarget,
    isUnixSocket,
    isUnixSocketAllowed,
};

export interface ExecutionOptions<TContext = any> {
    signal?: AbortSignal;
    pojo?: boolean;
    mode?: 'pojo' | 'wrapped';
    namespace?: string;
    timeout?: DurationInput;
    timeoutMs?: DurationInput;
    workflowId?: string;
    checkpoint?: boolean;
    // Phase 2
    durable?: boolean;
    workflowVersion?: string | number;
    idempotencyKey?: DynamicOption<string, TContext>;
    idempotencyStore?: IdempotencyStore;
    idempotencyTtlMs?: DurationInput;
    settleTimeoutMs?: number;
    pollIntervalMs?: number;
    isPermanentError?: (err: unknown) => boolean;
    migrations?: Record<string, StateMigrationFn> | StateMigrationFn;
    stackId?: string;
    isResume?: boolean;
    // Phase 4 Dependency Injection
    services?: Record<string, any>;
    dependencies?: Record<string, any>;
    // Network Policy
    networkPolicy?: NetworkPolicyConfig;
    // Live Monitoring
    monitor?: WorkflowEventEmitter | ((event: WorkflowExecutionEvent) => void);
    ast?: WorkflowNode;
    stepExecutionHook?: StepExecutionHook;
    /** Local tooling observer of resolved step data, including after hooks. Not redacted telemetry. */
    onStepResult?: (stepName: string, output: unknown) => void;
}

export type StepAction<TInput = any, TOutput = any> = (
    parameter: TInput,
    current?: any,
    index?: number,
) => TOutput | Promise<TOutput>;
export type OnBeforeAction<TInput = any> = (parameter: TInput) => boolean | Promise<boolean>;
export type OnSkipAction<TInput = any, TFallback = any> = (parameter: TInput) => TFallback | Promise<TFallback>;
export type OnAfterAction<TOutput = any, TInput = any> = (output: TOutput, parameter: TInput) => any | Promise<any>;
export type OnFailAction =
    ((error: any, retry: (fallback?: any) => void, reject: (err?: any) => void) => any) | RetryConfig;

export interface Flow<TInput = any, TOutput = any> {
    run: {
        (
            param: TInput | undefined,
            options: ExecutionOptions & { durable: true },
        ): Promise<TOutput | WorkflowSuspensionResult>;
        (param?: TInput, options?: ExecutionOptions): Promise<TOutput>;
    };
    steps: (Step<any, any, any> | ComputeStep<any, any, any>)[];
    readonly isFlow?: boolean;
    timeout: (ms: DurationInput) => Flow<TInput, TOutput>;
    timeoutMs?: number;
    workflowVersion?: string | number;
    version: (v: string | number) => Flow<TInput, TOutput>;
    toGraph: () => WorkflowNode;
    inspect: () => GraphInspectionResult;
    toMermaid: (options?: MermaidExportOptions) => string;
    toJSON: () => string;
    toDot: (options?: DotExportOptions) => string;
    resume: (correlationKeyOrStackId: string, eventPayload?: any, options?: ResumeOptions) => Promise<any>;
    compensate: (stackId: string, options?: CompensationRunOptions) => Promise<CompensationRunResult>;
    networkPolicy: (policy?: NetworkPolicyConfig) => Flow<TInput, TOutput>;
    networkPolicyConfig?: NetworkPolicyConfig;
    monitor: (emitter: WorkflowEventEmitter | ((event: WorkflowExecutionEvent) => void)) => Flow<TInput, TOutput>;
    monitorEmitter?: WorkflowEventEmitter | ((event: WorkflowExecutionEvent) => void);
    hook: (h: StepExecutionHook) => Flow<TInput, TOutput>;
    stepExecutionHook?: StepExecutionHook;
}

export type FlowItem<TIn = any, TOut = any> = Step<TIn, TOut, any> | ComputeStep<TIn, TOut, any> | Flow<TIn, TOut>;

export type FlowArg<TIn = any, TOut = any> = FlowItem<TIn, TOut> | FlowArg<TIn, TOut>[];

export function isFlow(item: any): item is Flow {
    if (!isObject(item)) {
        return false;
    }
    if (item instanceof Step || item instanceof ComputeStep || item.isCompute === true) {
        return false;
    }
    return item.isFlow === true || (isFunction(item.run) && !Array.isArray(item.specs) && !isFunction(item.onbefore));
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

function createFlowStep(flowInstance: Flow<any, any>): Step<any, any, any> {
    return new Step(flowInstance);
}

export function flattenSteps(steps: any[]): (Step<any, any, any> | ComputeStep<any, any, any>)[] {
    const result: (Step<any, any, any> | ComputeStep<any, any, any>)[] = [];
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

// Phase 4 Accumulated Context Inference Type Helpers
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsNever<T> = [T] extends [never] ? true : false;

export type MergeStepContext<TAcc, TOut> =
    IsAny<TOut> extends true
        ? TAcc & Record<string, any>
        : IsNever<TOut> extends true
          ? TAcc
          : [TOut] extends [void | undefined]
            ? TAcc
            : [TOut] extends [object]
              ? Omit<TAcc, keyof TOut> & TOut
              : TAcc;

export type FlowContextResult<TContext, THistory = Record<string, any>> = TContext & {
    $steps: THistory & Record<number, any>;
};

// Flow overloads with Accumulated Context Inference & Typed Step History
export type NamedFlowStep<TIn = any, TOut = any, TName extends string = string> =
    Step<TIn, TOut, TName> | ComputeStep<TIn, TOut, TName>;

export function flow<TIn, T1Out, N1 extends string>(
    s1: NamedFlowStep<any, T1Out, N1>,
): Flow<TIn, FlowContextResult<MergeStepContext<TIn, T1Out>, Record<N1, T1Out>>>;

export function flow<TIn, T1Out, N1 extends string, T2Out, N2 extends string>(
    s1: NamedFlowStep<any, T1Out, N1>,
    s2: NamedFlowStep<any, T2Out, N2>,
): Flow<
    TIn,
    FlowContextResult<MergeStepContext<MergeStepContext<TIn, T1Out>, T2Out>, Record<N1, T1Out> & Record<N2, T2Out>>
>;

export function flow<TIn, T1Out, N1 extends string, T2Out, N2 extends string, T3Out, N3 extends string>(
    s1: NamedFlowStep<any, T1Out, N1>,
    s2: NamedFlowStep<any, T2Out, N2>,
    s3: NamedFlowStep<any, T3Out, N3>,
): Flow<
    TIn,
    FlowContextResult<
        MergeStepContext<MergeStepContext<MergeStepContext<TIn, T1Out>, T2Out>, T3Out>,
        Record<N1, T1Out> & Record<N2, T2Out> & Record<N3, T3Out>
    >
>;

export function flow<
    TIn,
    T1Out,
    N1 extends string,
    T2Out,
    N2 extends string,
    T3Out,
    N3 extends string,
    T4Out,
    N4 extends string,
>(
    s1: NamedFlowStep<any, T1Out, N1>,
    s2: NamedFlowStep<any, T2Out, N2>,
    s3: NamedFlowStep<any, T3Out, N3>,
    s4: NamedFlowStep<any, T4Out, N4>,
): Flow<
    TIn,
    FlowContextResult<
        MergeStepContext<MergeStepContext<MergeStepContext<MergeStepContext<TIn, T1Out>, T2Out>, T3Out>, T4Out>,
        Record<N1, T1Out> & Record<N2, T2Out> & Record<N3, T3Out> & Record<N4, T4Out>
    >
>;

export function flow<
    TIn,
    T1Out,
    N1 extends string,
    T2Out,
    N2 extends string,
    T3Out,
    N3 extends string,
    T4Out,
    N4 extends string,
    T5Out,
    N5 extends string,
>(
    s1: NamedFlowStep<any, T1Out, N1>,
    s2: NamedFlowStep<any, T2Out, N2>,
    s3: NamedFlowStep<any, T3Out, N3>,
    s4: NamedFlowStep<any, T4Out, N4>,
    s5: NamedFlowStep<any, T5Out, N5>,
): Flow<
    TIn,
    FlowContextResult<
        MergeStepContext<
            MergeStepContext<MergeStepContext<MergeStepContext<MergeStepContext<TIn, T1Out>, T2Out>, T3Out>, T4Out>,
            T5Out
        >,
        Record<N1, T1Out> & Record<N2, T2Out> & Record<N3, T3Out> & Record<N4, T4Out> & Record<N5, T5Out>
    >
>;

export function flow<TInput = any, TOutput = any>(...steps: FlowArg[]): Flow<TInput, TOutput>;

export function flow<TInput = any, TOutput = any>(...steps: FlowArg[]): Flow<TInput, TOutput> {
    const flatSteps = flattenSteps(steps);
    let defaultTimeoutMs: number | undefined;
    let declaredVersion: string | number | undefined;
    let flowPolicyConfig: NetworkPolicyConfig | undefined;
    let flowMonitor: WorkflowEventEmitter | ((event: WorkflowExecutionEvent) => void) | undefined;
    let flowHook: StepExecutionHook | undefined;

    const runFn = (param: any = {}, options?: ExecutionOptions): Promise<any> => {
        let resolvedNetworkPolicy = options?.networkPolicy;
        if (flowPolicyConfig) {
            resolvedNetworkPolicy = options?.networkPolicy
                ? resolveEffectiveNetworkPolicy(options.networkPolicy, flowPolicyConfig)
                : flowPolicyConfig;
        }
        const effectiveOptions: ExecutionOptions = {
            ...(defaultTimeoutMs !== undefined ? { timeout: defaultTimeoutMs } : {}),
            ...(declaredVersion !== undefined ? { workflowVersion: declaredVersion } : {}),
            ...(flowMonitor !== undefined ? { monitor: flowMonitor } : {}),
            ...(flowHook !== undefined ? { stepExecutionHook: flowHook } : {}),
            ast: flowObj.toGraph(),
            ...options,
            ...(resolvedNetworkPolicy !== undefined ? { networkPolicy: resolvedNetworkPolicy } : {}),
        };
        if (effectiveOptions.stepExecutionHook && !stepExecutionHookStorage.getStore()) {
            return withStepExecutionHook(
                effectiveOptions.stepExecutionHook,
                () => Step.start(flatSteps, param, effectiveOptions) as Promise<TOutput>,
            );
        }
        return Step.start(flatSteps, param, effectiveOptions) as Promise<TOutput>;
    };

    const flowObj: Flow<TInput, TOutput> = {
        run: runFn as Flow<TInput, TOutput>['run'],
        steps: flatSteps,
        isFlow: true,
        timeout(ms: DurationInput) {
            const parsed = parseDuration(ms);
            defaultTimeoutMs = parsed;
            flowObj.timeoutMs = parsed;
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
        toMermaid(options?: MermaidExportOptions) {
            return toMermaid(flowObj, options);
        },
        toJSON() {
            return toJSON(flowObj);
        },
        toDot(options?: DotExportOptions) {
            return toDot(flowObj, options);
        },
        resume(correlationKeyOrStackId: string, eventPayload?: any, options?: ResumeOptions) {
            return resumeWorkflow(flowObj, correlationKeyOrStackId, eventPayload, options);
        },
        async compensate(stackId: string, options?: CompensationRunOptions) {
            const existing = defaultCompensationManager.getCompensations(stackId);
            if (!existing || existing.length === 0) {
                try {
                    const cp = await getCheckpoint(stackId);
                    const serializedCompensations = cp?.metadata?.compensations;
                    if (Array.isArray(serializedCompensations) && serializedCompensations.length > 0) {
                        const allSteps = flattenSteps(flowObj.steps || []);
                        for (const record of serializedCompensations) {
                            let handler = record.handler;
                            if (!handler && record.handlerName) {
                                handler = getCompensationHandler(record.handlerName);
                            }
                            const matchingStep: any = allSteps.find(
                                (s: any) =>
                                    (s?.name && s.name === record.stepName) ||
                                    (s?.func && s.func === record.stepName) ||
                                    (s?.$stepId && s.$stepId === record.stepId),
                            );
                            if (!handler) {
                                if (matchingStep?.compensationHandler) {
                                    handler = matchingStep.compensationHandler;
                                } else if (matchingStep?.compensationHandlerName) {
                                    handler = getCompensationHandler(matchingStep.compensationHandlerName);
                                }
                            }
                            const recordPolicy =
                                record.networkPolicy ||
                                resolveEffectiveNetworkPolicy(matchingStep?.networkPolicyConfig, flowPolicyConfig);

                            if (!handler && !record.handlerName) {
                                throw new UnresolvableCompensationException(record.stepName, undefined, { stackId });
                            }

                            defaultCompensationManager.registerCompensation(stackId, {
                                stepId: record.stepId,
                                stepName: record.stepName,
                                output: record.output,
                                input: record.input,
                                handler,
                                handlerName: record.handlerName,
                                payload: record.payload,
                                options: record.options,
                                networkPolicy: recordPolicy,
                                status: record.status,
                                completedAt: record.completedAt,
                            });
                        }
                    }
                } catch (err: unknown) {
                    if (err instanceof UnresolvableCompensationException) {
                        throw err;
                    }
                    // best-effort checkpoint hydration
                }
            }
            const resolvedNetworkPolicy = flowPolicyConfig
                ? options?.networkPolicy
                    ? resolveEffectiveNetworkPolicy(options.networkPolicy, flowPolicyConfig)
                    : flowPolicyConfig
                : options?.networkPolicy;
            const effectiveOptions = resolvedNetworkPolicy
                ? { ...options, networkPolicy: resolvedNetworkPolicy }
                : options;
            return defaultCompensationManager.runCompensations(stackId, undefined, effectiveOptions);
        },
        networkPolicy(policy?: NetworkPolicyConfig) {
            flowPolicyConfig = {
                enabled: policy?.enabled ?? true,
                defaultPolicy: policy?.defaultPolicy ?? 'deny',
                allowedHosts: policy?.allowedHosts ? [...policy.allowedHosts] : [],
                allowLocalhost: policy?.allowLocalhost ?? false,
                ...(policy?.allowUnixSockets ? { allowUnixSockets: [...policy.allowUnixSockets] } : {}),
            };
            flowObj.networkPolicyConfig = flowPolicyConfig;
            return flowObj;
        },
        networkPolicyConfig: undefined,
        monitor(emitter: WorkflowEventEmitter | ((event: WorkflowExecutionEvent) => void)) {
            flowMonitor = emitter;
            flowObj.monitorEmitter = emitter;
            return flowObj;
        },
        monitorEmitter: undefined,
        hook(h: StepExecutionHook) {
            flowHook = h;
            flowObj.stepExecutionHook = h;
            return flowObj;
        },
        stepExecutionHook: undefined,
    };
    return flowObj;
}

export class Step<TInput = any, TOutput = any, TName extends string = string> {
    name: TName;
    action: StepAction<TInput, TOutput>;
    specs: Spec[];
    onbefore: OnBeforeAction<TInput>;
    onskip?: OnSkipAction<TInput>;
    onafter?: OnAfterAction<any, TInput>;
    onfail?: OnFailAction;
    sequence: Step<any, any, any>[];
    reducer?: string;
    isStrict?: boolean;
    cachedLast?: number;
    cacheOptions?: CacheOptions;
    timeoutMs?: number;
    $stepId?: string;
    func?: string;
    // Phase 2
    compensationHandler?: CompensationHandler;
    compensationHandlerName?: string;
    compensationPayloadMapper?: (output: any, input: any) => any;
    compensationOptions?: CompensationOptions;
    idempotencyKey?: DynamicOption<string>;
    idempotencyOptions?: IdempotencyOptions;
    workflowNode?: WorkflowNode;
    // Phase 4
    dependencies?: Record<string, any>;
    networkPolicyConfig?: NetworkPolicyConfig;

    constructor(
        nameOrAction?: TName | StepAction<TInput, TOutput> | Flow<TInput, TOutput>,
        action: StepAction<TInput, TOutput> = (_parameter: any) => undefined as any,
        sequence: Step<any, any, any>[] = [],
    ) {
        if (isFlow(nameOrAction)) {
            const flowInstance = nameOrAction;
            this.action = async (param: any) => {
                const cleanParam = sanitizeFlowData(param);
                const execFn = flowInstance.run.bind(flowInstance);
                const raw = await execFn(cleanParam, { pojo: true });
                return sanitizeFlowData(raw);
            };
            this.name = '' as TName;
        } else if (isFunction(nameOrAction)) {
            this.action = nameOrAction;
            this.name = '' as TName;
        } else {
            this.name = (nameOrAction as TName) || ('' as TName);
            this.action = action;
        }
        this.func = this.name as string;
        this.$stepId = generateUUID();
        this.specs = [];
        this.onbefore = () => true;
        this.sequence = sequence || [];
        if (!this.sequence.length) {
            this.sequence.push(this);
        }
    }

    static start<TOut = any>(steps: FlowItem | FlowItem[], param?: any, options?: ExecutionOptions): Promise<TOut>;
    static start(steps?: undefined, param?: any, options?: ExecutionOptions): undefined;
    static start(steps?: any, param: any = {}, options?: ExecutionOptions): any {
        if (!steps) {
            return new Executer().start(param, steps, options);
        }
        const normalizedSteps = isFlow(steps)
            ? Array.isArray(steps.steps)
                ? flattenSteps(steps.steps)
                : [createFlowStep(steps)]
            : Array.isArray(steps)
              ? flattenSteps(steps)
              : steps;
        const effOptions =
            options && !options.ast ? Object.assign({}, options, { ast: toGraph(normalizedSteps) }) : options;
        return new Executer().start(param, normalizedSteps, effOptions);
    }

    static create<TName extends string, TIn = any, TOut = any>(
        name: TName,
        action?: StepAction<TIn, TOut>,
        sequence?: Step<any, any, any>[],
    ): Step<TIn, TOut, TName>;
    static create<TIn = any, TOut = any>(action: StepAction<TIn, TOut> | Flow<TIn, TOut>): Step<TIn, TOut, string>;
    static create<TIn, TOut, TName extends string>(
        name: TName,
        action: StepAction<TIn, TOut>,
        sequence?: Step<any, any, any>[],
    ): Step<TIn, TOut, TName>;
    static create<TIn = any, TOut = any>(
        nameOrAction?: string | StepAction<TIn, TOut> | Flow<TIn, TOut>,
        action?: StepAction<TIn, TOut>,
        sequence?: Step<any, any, any>[],
    ): Step<TIn, TOut, any> {
        return new Step<TIn, TOut, any>(nameOrAction as any, action, sequence);
    }

    static compute<TName extends string, TIn = any, TOut = any>(
        name: TName,
        action: SyncStepAction<TIn, TOut>,
    ): ComputeStep<TIn, TOut, TName>;
    static compute<TIn = any, TOut = any>(action: SyncStepAction<TIn, TOut>): ComputeStep<TIn, TOut, string>;
    static compute<TIn = any, TOut = any>(
        nameOrAction: string | SyncStepAction<TIn, TOut>,
        action?: SyncStepAction<TIn, TOut>,
    ): ComputeStep<TIn, TOut, any> {
        return new ComputeStep<TIn, TOut, any>(nameOrAction as any, action);
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
    static withStepExecutionHook = withStepExecutionHook;
    static getStepExecutionHook = getStepExecutionHook;
    static stepExecutionHookStorage = stepExecutionHookStorage;

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

    // Phase 4 static helpers
    static toMermaid = toMermaid;
    static toJSON = toJSON;
    static toDot = toDot;

    // Phase 4 Saga & Compensation Helpers
    static registerCompensationHandler = registerCompensationHandler;
    static getCompensationHandler = getCompensationHandler;
    static unregisterCompensationHandler = unregisterCompensationHandler;
    static clearCompensationHandlers = clearCompensationHandlers;
    static reconcileAbandonedStacks = reconcileAbandonedStacks;

    // Network Interceptor Helpers
    static installNetworkInterceptors = installNetworkInterceptors;
    static uninstallNetworkInterceptors = uninstallNetworkInterceptors;

    // Live Monitoring Helpers
    static setDefaultMonitor = setDefaultMonitor;
    static getDefaultMonitor = getDefaultMonitor;

    allowNetwork(hosts: HostPattern | HostPattern[]): this {
        const list = Array.isArray(hosts) ? hosts : [hosts];
        this.networkPolicyConfig = {
            enabled: true,
            defaultPolicy: 'deny',
            allowedHosts: list,
            allowLocalhost: this.networkPolicyConfig?.allowLocalhost ?? false,
            ...(this.networkPolicyConfig?.allowUnixSockets
                ? { allowUnixSockets: this.networkPolicyConfig.allowUnixSockets }
                : {}),
        };
        return this;
    }

    allowUnixSockets(sockets: string | string[]): this {
        const list = Array.isArray(sockets) ? sockets : [sockets];
        this.networkPolicyConfig = {
            enabled: true,
            defaultPolicy: this.networkPolicyConfig?.defaultPolicy ?? 'deny',
            allowedHosts: this.networkPolicyConfig?.allowedHosts || [],
            allowLocalhost: this.networkPolicyConfig?.allowLocalhost ?? false,
            allowUnixSockets: list,
        };
        return this;
    }

    denyNetwork(): this {
        return this.allowNetwork([]);
    }

    networkPolicy(): NetworkPolicyConfig | undefined;
    networkPolicy(policy: NetworkPolicyConfig): this;
    networkPolicy(policy?: NetworkPolicyConfig): this | NetworkPolicyConfig | undefined {
        if (policy === undefined) {
            return this.networkPolicyConfig;
        }
        this.networkPolicyConfig = {
            enabled: policy.enabled ?? true,
            defaultPolicy: policy.defaultPolicy ?? 'deny',
            allowedHosts: policy.allowedHosts ? [...policy.allowedHosts] : [],
            allowLocalhost: policy.allowLocalhost ?? false,
            ...(policy.allowUnixSockets ? { allowUnixSockets: [...policy.allowUnixSockets] } : {}),
        };
        return this;
    }

    timeout(ms: DurationInput): Step<TInput, TOutput, TName> {
        this.timeoutMs = parseDuration(ms);
        return this;
    }

    reduce<TField extends string>(field: TField): Step<Record<TField, TInput[]> & Record<string, any>, TOutput, TName> {
        this.reducer = field;
        return this as any;
    }

    withDependencies(dependencies: Record<string, any>): this {
        this.dependencies = Object.assign({}, this.dependencies, dependencies);
        return this;
    }

    requireDependency<T = any>(key: string): T {
        const val = this.dependencies?.[key];
        if (val === undefined) {
            throw new Error(`Missing required dependency '${key}' for step '${(this.name as string) || 'anonymous'}'`);
        }
        return val as T;
    }

    schema<TSchema = any>(schemaObj: TSchema): Step<TInput, TOutput, TName> {
        const spec = new Spec('$root$');
        spec.schema(schemaObj);
        this.specs.push(spec);
        return this;
    }

    spec<TKey extends keyof TInput & string>(
        field: TKey,
        json: SpecData<TInput[TKey], TInput> | Record<string, any>,
    ): Step<TInput, TOutput, TName>;
    spec(fieldOrSchema: string | any, json?: SpecData<any, TInput> | any): Step<TInput, TOutput, TName>;
    spec(fieldOrSchema: string | any, json: SpecData | any = {}): Step<TInput, TOutput, TName> {
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

    strict(): Step<TInput, TOutput, TName> {
        this.isStrict = true;
        return this;
    }

    onBefore(onBefore: OnBeforeAction<TInput>): Step<TInput, TOutput, TName> {
        this.onbefore = onBefore;
        return this;
    }

    onSkip(onSkip: OnSkipAction<TInput>): Step<TInput, TOutput, TName> {
        this.onskip = onSkip;
        return this;
    }

    onAfter(onAfter: OnAfterAction<TOutput, TInput>): Step<TInput, TOutput, TName> {
        this.onafter = onAfter;
        return this;
    }

    onFail(onFail: OnFailAction): Step<TInput, TOutput, TName> {
        this.onfail = onFail;
        return this;
    }

    cache(cachedLastOrOptions?: DurationInput | CacheOptions): Step<TInput, TOutput, TName> {
        if (isObject(cachedLastOrOptions)) {
            this.cacheOptions = cachedLastOrOptions;
            this.cachedLast = parseDuration(cachedLastOrOptions.ttl) ?? 1500;
        } else {
            this.cachedLast = parseDuration(cachedLastOrOptions) ?? 1500;
        }
        return this;
    }

    compensate(
        handlerOrName: string | CompensationHandler,
        payloadMapperOrOptions?: ((output: any, input: any) => any) | CompensationOptions,
        options?: CompensationOptions,
    ): Step<TInput, TOutput, TName> {
        if (typeof handlerOrName === 'string') {
            this.compensationHandlerName = handlerOrName;
            if (typeof payloadMapperOrOptions === 'function') {
                this.compensationPayloadMapper = payloadMapperOrOptions;
                this.compensationOptions = options;
            } else if (payloadMapperOrOptions && typeof payloadMapperOrOptions === 'object') {
                this.compensationOptions = payloadMapperOrOptions as CompensationOptions;
            }
        } else {
            this.compensationHandler = handlerOrName;
            this.compensationOptions = payloadMapperOrOptions as CompensationOptions;
        }
        return this;
    }

    idempotent(
        keyOrFnOrOptions?: DynamicOption<string> | IdempotencyOptions,
        options?: IdempotencyOptions,
    ): Step<TInput, TOutput, TName> {
        if (isObject(keyOrFnOrOptions) && !isFunction(keyOrFnOrOptions)) {
            const idempOpts = keyOrFnOrOptions as IdempotencyOptions;
            this.idempotencyOptions = idempOpts;
            this.idempotencyKey = idempOpts.key ?? ((ctx: any) => ctx.idempotencyKey ?? ctx.id ?? this.name);
        } else {
            this.idempotencyKey =
                keyOrFnOrOptions ?? options?.key ?? ((ctx: any) => ctx.idempotencyKey ?? ctx.id ?? this.name);
            this.idempotencyOptions = options;
        }
        return this;
    }

    toGraph(): WorkflowNode {
        return toGraph(this);
    }

    inspect(): GraphInspectionResult {
        return inspectGraph(this);
    }

    execute(param?: TInput, options?: ExecutionOptions): Promise<TOutput> {
        return Step.start<TOutput>(this.sequence.length ? [...this.sequence] : this, param, options);
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
export const Func = Step;
export type Func<TIn = any, TOut = any> = Step<TIn, TOut, any>;
export const Chain = Step;
export type Chain<TIn = any, TOut = any> = Step<TIn, TOut, any>;

/** @deprecated Use `flow` instead of `pipe`. */
export const pipe = flow;

/** @deprecated Use `Flow` instead of `Pipeline`. */
export type Pipeline<TIn = any, TOut = any> = Flow<TIn, TOut>;
export type PipeItem<TIn = any, TOut = any> = FlowItem<TIn, TOut>;
export type PipeArg<TIn = any, TOut = any> = FlowArg<TIn, TOut>;

/** @deprecated Use `isFlow` instead of `isPipeline`. */
export const isPipeline = isFlow;

export {
    registerCompensationHandler,
    getCompensationHandler,
    hasCompensationHandler,
    unregisterCompensationHandler,
    clearCompensationHandlers,
    reconcileAbandonedStacks,
};

export type {
    CompensationRunOptions,
    CompensationDeadLetterQueue,
    ReconcilerOptions,
    ReconcileReport,
} from '../compensation';
export {
    Status,
    ExecutionPhase,
    tagErrorPhase,
    isReservedKey,
    isFunction,
    isObject,
    isPlainObject,
    assertNever,
    getErrorMessage,
    getErrorName,
    resolveDynamic,
} from '../../shared';
export type { DynamicOption, DurationInput, DynamicDuration } from '../../shared';
