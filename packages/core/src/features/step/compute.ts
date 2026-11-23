import {
    DurationInput,
    ExecutionPhase,
    HISTORY,
    NAMESPACE,
    NAMESPACE_KEY,
    SIGNAL,
    SIGNAL_KEY,
    STACK_ID,
    STACK_ID_KEY,
    STEPS,
    generateUUID,
    isObject,
    parseDuration,
    tagErrorPhase,
} from '../../shared';
import { ComputeCache, ComputeCacheOptions, DEFAULT_COMPUTE_CACHE_TTL_MS, clearComputeCaches } from '../cache/compute';
import { toPOJO } from '../context/proxy';
import { emitMonitoringEvent } from '../events/emitter';
import { Executer } from '../executer';
import { CancellationException, NetworkPolicyViolationException, SigloError } from '../executer/exceptions';
import { StepExecutionContext, stepExecutionHookStorage } from '../executer/hooks';
import { toGraph } from '../graph';
import { HostPattern, NetworkPolicyConfig, ensureNetworkInterceptorsInstalled, networkPolicyStorage } from '../network';
import { SyncSpec, SyncSpecData, SyncValue, isThenable, runSpecsSync } from '../spec/sync';
import { defaultStorageManager } from '../storage';
import type { ExecutionOptions } from './index';

export {
    ComputeCache,
    ComputeCacheOptions,
    SyncSpec,
    SyncSpecData,
    SyncValue,
    clearComputeCaches,
    isThenable,
    runSpecsSync,
};

export type SyncStepAction<TInput = any, TOutput = any> = (parameter: TInput) => SyncValue<TOutput>;

export const COMPUTE_NETWORK_POLICY: Readonly<NetworkPolicyConfig> = Object.freeze({
    enabled: true,
    defaultPolicy: 'deny' as const,
    allowedHosts: Object.freeze([]) as unknown as HostPattern[],
    allowLocalhost: false,
});

function isSchemaObject(obj: any): boolean {
    return Boolean(obj && (obj['~standard'] || typeof obj.safeParse === 'function' || typeof obj.parse === 'function'));
}

function unwrapComputeInput(rawInput: any): any {
    if (!isObject(rawInput) || Array.isArray(rawInput)) {
        return rawInput;
    }
    const pojo = toPOJO(rawInput);
    const clean: Record<string, any> = {};
    for (const key of Object.keys(pojo)) {
        if (
            key === SIGNAL ||
            key === SIGNAL_KEY ||
            key === NAMESPACE ||
            key === NAMESPACE_KEY ||
            key === STACK_ID ||
            key === STACK_ID_KEY
        ) {
            continue;
        }
        clean[key] = (pojo as any)[key];
    }
    if (rawInput[STEPS] || rawInput.$steps) {
        const stepsFn = rawInput[STEPS] || rawInput.$steps;
        clean[STEPS] = stepsFn;
        clean[HISTORY] = rawInput[HISTORY] || rawInput.$history || stepsFn;
    }
    return clean;
}

export class ComputeStep<TInput = any, TOutput = any, TName extends string = string> {
    readonly isCompute = true as const;
    readonly name: TName;
    readonly func: string;
    readonly $stepId: string;
    readonly action: SyncStepAction<TInput, TOutput>;
    readonly specs: SyncSpec[];
    readonly networkPolicyConfig: Readonly<NetworkPolicyConfig> = COMPUTE_NETWORK_POLICY;
    cachedLast?: number;
    cacheOptions?: ComputeCacheOptions;
    /** @internal */
    _computeCache?: ComputeCache;

    constructor(nameOrAction: TName | SyncStepAction<TInput, TOutput>, action?: SyncStepAction<TInput, TOutput>) {
        if (typeof nameOrAction === 'function') {
            this.name = '' as TName;
            this.action = nameOrAction;
        } else {
            this.name = (nameOrAction || '') as TName;
            if (typeof action !== 'function') {
                throw new Error(`Step.compute '${this.name || 'anonymous'}' requires a synchronous action function.`);
            }
            this.action = action;
        }
        this.func = this.name as string;
        this.$stepId = generateUUID();
        this.specs = [];
    }

    spec(fieldOrSchema: string | any, json: SyncSpecData | any = {}): ComputeStep<TInput, TOutput, TName> {
        const isFieldString = typeof fieldOrSchema === 'string';
        const field = isFieldString ? fieldOrSchema : '$root$';
        const spec = new SyncSpec(field);

        if (!isFieldString) {
            spec.schema(fieldOrSchema);
        } else if (isSchemaObject(json)) {
            spec.schema(json);
        } else {
            // Preserve exact evaluation order: default -> require -> validate -> transform -> translate -> schema
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
            if (json.schema) {
                spec.schema(json.schema);
            }
        }

        this.specs.push(spec);
        return this;
    }

    cache(ttlOrOptions?: DurationInput | ComputeCacheOptions): ComputeStep<TInput, TOutput, TName> {
        if (isObject(ttlOrOptions)) {
            this.cacheOptions = ttlOrOptions;
            this.cachedLast = parseDuration(ttlOrOptions.ttl) || DEFAULT_COMPUTE_CACHE_TTL_MS;
            this._computeCache = new ComputeCache({
                ...ttlOrOptions,
                ttl: this.cachedLast,
            });
        } else {
            this.cachedLast = parseDuration(ttlOrOptions) || DEFAULT_COMPUTE_CACHE_TTL_MS;
            this.cacheOptions = undefined;
            this._computeCache = new ComputeCache({ ttl: this.cachedLast });
        }
        return this;
    }

    run(param?: TInput, options?: ExecutionOptions): Promise<TOutput> {
        const effOptions = options && !options.ast ? { ...options, ast: toGraph(this) } : options;
        return new Executer().start(param === undefined ? {} : param, this, effOptions) as Promise<TOutput>;
    }
    /* c8 ignore next */
}

export function executeComputeStepSync(step: ComputeStep<any, any, any>, rawInput: any, options?: any): any {
    const stepName = step.name || step.func || 'compute';
    const stepId = step.$stepId || stepName;
    const stackId = options?.stackId || '';
    const namespace = options?.namespace;

    // 1. Cooperative Cancellation Check
    if (options?.signal?.aborted) {
        throw (
            options.signal.reason ||
            new CancellationException('This operation was aborted', {
                stackId: stackId || undefined,
                stepName,
                namespace,
            })
        );
    }

    const stepStartTime = Date.now();

    // 2. Monitoring: step:start
    emitMonitoringEvent(options, {
        type: 'step:start',
        stackId,
        stepId,
        stepName,
        attempt: 1,
        timestamp: stepStartTime,
        namespace,
    });

    // 3. Always-deny network perimeter
    ensureNetworkInterceptorsInstalled();
    const policyContext = {
        enabled: true,
        defaultPolicy: 'deny' as const,
        allowedHosts: [] as HostPattern[],
        allowLocalhost: false,
        stepName,
        throwSync: true,
    };

    const emitErrorAndRethrow = (err: any): never => {
        const isNetworkErr =
            err instanceof NetworkPolicyViolationException || err?.name === 'NetworkPolicyViolationException';
        if (!isNetworkErr && err?.phase !== ExecutionPhase.VALIDATION) {
            tagErrorPhase(err, ExecutionPhase.ACTION, stepName);
        }
        emitMonitoringEvent(options, {
            type: 'step:error',
            stackId,
            stepId,
            stepName,
            attempt: 1,
            error: {
                message: err?.message || String(err),
                code: err?.code,
                stack: err?.stack,
            },
            timestamp: Date.now(),
            namespace,
        });
        throw err;
    };

    const emitComplete = (output: any): any => {
        emitMonitoringEvent(options, {
            type: 'step:complete',
            stackId,
            stepId,
            stepName,
            durationMs: Math.max(0, Date.now() - stepStartTime),
            outputSummary: output,
            timestamp: Date.now(),
            namespace,
        });
        options?.onStepResult?.(stepName, output);
        return output;
    };

    const activeHook =
        options?.stepExecutionHook || stepExecutionHookStorage.getStore() || (step as any).stepExecutionHook;
    const stepContext: StepExecutionContext = {
        step,
        stepName,
        stepId,
        stackId,
        attempt: 1,
        namespace,
        param: rawInput,
        options,
    };

    const executeCore = () => {
        // 4. Sync Spec Validation (inside always-deny network perimeter)
        const cleanInput = unwrapComputeInput(rawInput);
        let validatedInput = cleanInput;
        if (step.specs.length > 0) {
            try {
                validatedInput = networkPolicyStorage.run(policyContext, () =>
                    runSpecsSync(step.specs, cleanInput, stepName),
                );
            } catch (specErr: any) {
                tagErrorPhase(specErr, ExecutionPhase.VALIDATION, stepName);
                throw specErr;
            }
        }
        stepContext.param = validatedInput;

        // 5. In-Memory LRU/TTL Cache Lookup (post-.spec() normalized input)
        const computeCache = step._computeCache;
        const cacheStepId = step.name || stepId;
        let cacheKey: string | undefined;

        if (computeCache) {
            cacheKey = networkPolicyStorage.run(policyContext, () =>
                computeCache.buildKey(cacheStepId, validatedInput, namespace),
            );
            const lookup = computeCache.get(cacheKey);
            if (lookup.hit) {
                stepContext.cacheHit = true;
                defaultStorageManager.emitCacheEvent({
                    type: 'hit',
                    key: cacheKey,
                    stepId,
                    stackId: stackId || undefined,
                    namespace,
                    timestamp: Date.now(),
                });
                return lookup.value;
            }
        }

        // 6. Execute synchronous action under always-deny network perimeter
        const result = networkPolicyStorage.run(policyContext, () => step.action(validatedInput));

        // 7. Runtime Thenable Guard
        if (isThenable(result)) {
            if (result instanceof Promise) {
                result.catch(() => {});
            }
            throw new SigloError(
                `Step.compute '${stepName}' must be synchronous and cannot return a Promise. Use Step.create for async or I/O operations.`,
                {
                    stepName,
                    phase: ExecutionPhase.ACTION,
                    retryable: false,
                    stackId: stackId || undefined,
                    namespace,
                },
            );
        }

        // 8. Store in step-local LRU/TTL cache on miss
        if (computeCache && cacheKey !== undefined) {
            computeCache.set(cacheKey, result);
            stepContext.cacheHit = false;
            defaultStorageManager.emitCacheEvent({
                type: 'miss',
                key: cacheKey,
                stepId,
                stackId: stackId || undefined,
                namespace,
                timestamp: Date.now(),
            });
        }

        return result;
    };

    let rawResult: any;
    try {
        rawResult = activeHook ? activeHook(stepContext, executeCore) : executeCore();
    } catch (err: any) {
        emitErrorAndRethrow(err);
    }

    // Gracefully support third-party async stepExecutionHook without breaking sync fast path
    if (isThenable(rawResult)) {
        return (rawResult as Promise<any>).then(
            (val: any) => emitComplete(val),
            (err: any) => emitErrorAndRethrow(err),
        );
    }

    return emitComplete(rawResult);
}
