import { stepInspectionStorage } from '../../events/inspection';
import AddSpecToContext from './Helpers/AddSpecToContext';
import AddInitialParam from './Helpers/AddInitialParam';
import ConvertParamFromSpec from './Helpers/ConvertParamFromSpec';
import SetResolvedContexts from './Helpers/SetResolvedContexts';
import OnAfter from './LifeCycle/OnAfter';
import OnBefore from './LifeCycle/OnBefore';
import OnFail from './LifeCycle/OnFail';
import ResolveChain from './Helpers/ResolveChain';
import { toPOJO } from '../../context';
import {
    generateUUID,
    Status,
    isFunction,
    tagErrorPhase,
    ExecutionPhase,
    SIGNAL,
    SIGNAL_KEY,
    NAMESPACE,
    NAMESPACE_KEY,
    ATTEMPT,
    RETRY_DELAY,
    STEPS,
    HISTORY,
    IS_DURABLE,
    STACK_ID,
    STACK_ID_KEY,
    SERVICES,
    DEPENDENCIES,
    DEPS
} from '../../../shared';
import { StepTimeoutException, IdempotencyConflictException, NetworkPolicyViolationException } from '../exceptions';
import { combineAbortSignals } from '../signals';
import { defaultCompensationManager } from '../../compensation';
import { defaultIdempotencyStore, buildIdempotencyKey, isPermanentBusinessError } from '../../idempotency';
import { resolveEffectiveNetworkPolicy, networkPolicyStorage, ensureNetworkInterceptorsInstalled } from '../../network';
import { emitMonitoringEvent } from '../../events/emitter';

function extractNetworkViolation(err: any, seen: Set<any> = new Set()): any {
    if (!err || seen.has(err)) return undefined;
    seen.add(err);
    if (err instanceof NetworkPolicyViolationException || err?.name === 'NetworkPolicyViolationException') {
        return err;
    }
    if (Array.isArray(err)) {
        for (const item of err) {
            const found = extractNetworkViolation(item?.error || item, seen);
            if (found) return found;
        }
    }
    if (typeof err === 'object' && err.error && err.error !== err) {
        return extractNetworkViolation(err.error, seen);
    }
    return undefined;
}

export default class StartChain {
    start: (initialParam: any, chains: any, options?: any) => Promise<any>;
    stackId: string;

    constructor(
        getChain: (name: any) => any,
        Context: any,
        propertyToContext: (context: any, chainReturn: any) => void,
        Reducer: any,
        addChainToStack: (stackId: string, stepId: string) => void,
        stackId: string,
        cache: any,
        logInfo: (source: string, message: any) => void,
        logError: (source: string, error: any) => void,
        executeAfter: (chain: string, context: any) => Promise<any>,
        executeBefore: (chain: string, context: any) => Promise<any>
    ) {
        this.stackId = stackId;
        this.start = (initialParam: any, chains: any, options?: any) => {
            options = Object.assign({ stackId }, options);
            logInfo('SingleChain', {
                chain: chains,
                message: 'Starting',
                initialParam
            });

            return new Promise((resolve, reject) => {
                if (options?.signal?.aborted) {
                    reject(options.signal.reason || new Error('This operation was aborted'));
                    return;
                }

                let initTimer: any;
                let cleanupAbort: (() => void) | undefined;
                if (options?.signal) {
                    const onAbort = () => {
                        if (initTimer !== undefined) {
                            clearTimeout(initTimer);
                        }
                        reject(options.signal.reason || new Error('This operation was aborted'));
                    };
                    options.signal.addEventListener('abort', onAbort, { once: true });
                    cleanupAbort = () => {
                        if (initTimer !== undefined) {
                            clearTimeout(initTimer);
                        }
                        options.signal.removeEventListener('abort', onAbort);
                    };
                }

                const safeResolve = (val: any) => {
                    cleanupAbort?.();
                    resolve(val);
                };

                const safeReject = (err: any) => {
                    cleanupAbort?.();
                    reject(err);
                };

                initTimer = setTimeout(() => {
                    const chain = (chains && typeof chains === 'object')
                        ? Object.assign({}, chains, {
                            $stepId: chains.$stepId || generateUUID(),
                            func: chains.func || chains.name || ''
                        })
                        : getChain(chains);
                    const chainName = chain.func || (typeof chains === 'string' ? chains : (chain.name || ''));

                    const stepTimeoutMs = chain.timeoutMs || (typeof chain.timeout === 'number' ? chain.timeout : undefined);
                    let stepController: AbortController | undefined;
                    let stepTimer: any;
                    let stepSignalCleanup: () => void = () => {};
                    let stepEffectiveSignal = options?.signal;
                    let stepOptions = options;

                    if (stepTimeoutMs && stepTimeoutMs > 0) {
                        stepController = new AbortController();
                        const stepStartTime = Date.now();
                        stepTimer = setTimeout(() => {
                            const elapsed = Date.now() - stepStartTime;
                            stepController!.abort(new StepTimeoutException(chainName, stepTimeoutMs, elapsed));
                        }, stepTimeoutMs);
                        const combined = combineAbortSignals([options?.signal, stepController.signal]);
                        stepEffectiveSignal = combined.signal;
                        stepSignalCleanup = combined.cleanup;
                        stepOptions = Object.assign({}, options, {
                            signal: stepEffectiveSignal,
                            outerSignal: options?.signal
                        });
                    }

                    const clearStepTimeout = () => {
                        if (stepTimer !== undefined) {
                            clearTimeout(stepTimer);
                        }
                        stepSignalCleanup();
                    };

                    try {
                        const effectiveNetworkPolicy = resolveEffectiveNetworkPolicy(
                            chain.networkPolicy || chain.networkPolicyConfig,
                            options?.networkPolicy
                        );
                        // Include validation and before hooks in the same runtime identity
                        // as the action so rejected ecosystem inputs remain observable.
                        const executeInspectedStep = () => stepInspectionStorage.run({
                            stackId, stepId: chain.$stepId || chainName, stepName: chainName,
                            namespace: options?.namespace, monitor: options?.monitor,
                            attempt: (initialParam?.[ATTEMPT] ? (typeof initialParam[ATTEMPT] === 'function' ? initialParam[ATTEMPT]() : initialParam[ATTEMPT]) : 0) + 1
                        }, executeStep);

                        if (effectiveNetworkPolicy?.enabled) {
                            ensureNetworkInterceptorsInstalled();
                        }

                        const executeStep = () => {
                            const stepExecutionStartTime = Date.now();
                            addChainToStack(stackId, chain.$stepId);
                            /* c8 ignore next 3 */
                            const contextStepId = typeof initialParam?.$stepId === 'function'
                                ? initialParam.$stepId()
                                : (initialParam?.$stepId || chain.$stepId);
                            const paramAsContext = new Context(contextStepId, stackId, options?.namespace);
                            new AddSpecToContext(chain.specs, paramAsContext);
                            new AddInitialParam(initialParam, paramAsContext);

                            const raceWithSignal = <T>(promise: Promise<T>): Promise<T> => {
                                if (!stepEffectiveSignal || !stepTimeoutMs) {
                                    return promise;
                                }
                                /* c8 ignore next 3 */
                                if (stepEffectiveSignal.aborted) {
                                    return Promise.reject(stepEffectiveSignal.reason);
                                }
                                return Promise.race([
                                    promise,
                                    new Promise<T>((_, rejectSignal) => {
                                        stepEffectiveSignal.addEventListener('abort', () => {
                                            rejectSignal(stepEffectiveSignal.reason);
                                        }, { once: true });
                                    })
                                ]);
                            };

                            raceWithSignal(paramAsContext.runSpecs()).then(() => {
                                const initialData = paramAsContext.getData();
                                let param = new ConvertParamFromSpec(Object.assign({}, initialParam, initialData), chain).getParam();
                                const mergedServices = {
                                    ...(options?.services || options?.dependencies || {}),
                                    ...(chain.dependencies || {})
                                };
                                const svcFn = () => mergedServices;
                                (svcFn as any).val = mergedServices;
                                param[SERVICES] = svcFn;
                                param[DEPENDENCIES] = svcFn;
                                param[DEPS] = svcFn;

                                if (stepEffectiveSignal) {
                                    const sigFn = () => stepEffectiveSignal;
                                    (sigFn as any).val = stepEffectiveSignal;
                                    param[SIGNAL] = sigFn;
                                    param[SIGNAL_KEY] = sigFn;
                                }
                                if (options?.namespace) {
                                    const nsFn = () => options.namespace;
                                    (nsFn as any).val = options.namespace;
                                    param[NAMESPACE] = nsFn;
                                    param[NAMESPACE_KEY] = nsFn;
                                }
                                if (initialParam?.[ATTEMPT]) {
                                    param[ATTEMPT] = initialParam[ATTEMPT];
                                }
                                if (initialParam?.[RETRY_DELAY]) {
                                    param[RETRY_DELAY] = initialParam[RETRY_DELAY];
                                }
                                if (initialParam?.[STEPS] || (initialParam as any)?.$steps) {
                                    const stpFn = initialParam[STEPS] || (initialParam as any).$steps;
                                    param[STEPS] = stpFn;
                                    param[HISTORY] = initialParam[HISTORY] || (initialParam as any).$history || stpFn;
                                    param.$steps = stpFn;
                                    param.$history = param[HISTORY];
                                }
                                if (initialParam?.[IS_DURABLE]) {
                                    param[IS_DURABLE] = initialParam[IS_DURABLE];
                                }
                                raceWithSignal(executeBefore(chain.func, param))
                                    .then(resolvedPluginData => {
                                        const newContext = new Context('_before_temp', stackId, options?.namespace);
                                        new SetResolvedContexts(resolvedPluginData, newContext);
                                        param = Object.assign({}, param, newContext.getData());
                                        param[SERVICES] = svcFn;
                                        param[DEPENDENCIES] = svcFn;
                                        param[DEPS] = svcFn;
                                        if (initialParam?.[STEPS] || (initialParam as any)?.$steps) {
                                            const stpFn = initialParam[STEPS] || (initialParam as any).$steps;
                                            param[STEPS] = stpFn;
                                            param[HISTORY] = initialParam[HISTORY] || (initialParam as any).$history || stpFn;
                                            param.$steps = stpFn;
                                            param.$history = param[HISTORY];
                                        }
                                        if (stepEffectiveSignal) {
                                            const sigFn = () => stepEffectiveSignal;
                                            (sigFn as any).val = stepEffectiveSignal;
                                            param[SIGNAL] = sigFn;
                                            param[SIGNAL_KEY] = sigFn;
                                        }
                                        if (options?.namespace) {
                                            const nsFn = () => options.namespace;
                                            (nsFn as any).val = options.namespace;
                                            param[NAMESPACE] = nsFn;
                                            param[NAMESPACE_KEY] = nsFn;
                                        }
                                        if (initialParam?.[ATTEMPT]) {
                                            param[ATTEMPT] = initialParam[ATTEMPT];
                                        }
                                        if (initialParam?.[RETRY_DELAY]) {
                                            param[RETRY_DELAY] = initialParam[RETRY_DELAY];
                                        }
                                        if (initialParam?.[STEPS]) {
                                            param[STEPS] = initialParam[STEPS];
                                            param[HISTORY] = initialParam[HISTORY] || initialParam[STEPS];
                                        }
                                        if (initialParam?.[IS_DURABLE]) {
                                            param[IS_DURABLE] = initialParam[IS_DURABLE];
                                        }

                                        const executeStepLifecycle = () => {
                                            const stepAttempt = (initialParam?.[ATTEMPT] ? (typeof initialParam[ATTEMPT] === 'function' ? initialParam[ATTEMPT]() : initialParam[ATTEMPT]) : 0) + 1;
                                            const stepId = chain.$stepId || chainName;
                                            const stepStartTime = stepExecutionStartTime;

                                            emitMonitoringEvent(options, {
                                                type: 'step:start',
                                                stackId,
                                                stepId,
                                                stepName: chainName,
                                                attempt: stepAttempt,
                                                timestamp: stepStartTime,
                                                namespace: options?.namespace
                                            });

                                            new OnBefore(chain, param, (val) => {
                                                clearStepTimeout();
                                                safeResolve(val);
                                            }, (err: any) => {
                                                clearStepTimeout();
                                                tagErrorPhase(err, ExecutionPhase.BEFORE, chainName);
                                                new OnFail(chain, err, context => {
                                                    new ResolveChain(safeResolve, context, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                                            }, Context, async () => {
                                                let stepIdempKey: string | undefined;
                                                const stepIdempStore = chain.idempotencyOptions?.store || defaultIdempotencyStore;

                                                if (chain.idempotencyKey) {
                                                    try {
                                                        // Preserve runtime identity for per-workflow keys; toPOJO removes reserved fields.
                                                        const rawKey = isFunction(chain.idempotencyKey)
                                                            ? chain.idempotencyKey({ ...toPOJO(param), $stackId: stackId })
                                                            : chain.idempotencyKey;
                                                        stepIdempKey = buildIdempotencyKey(rawKey, {
                                                            namespace: options?.namespace
                                                        });
                                                        let claim = await stepIdempStore.claim(stepIdempKey, chain.idempotencyOptions?.ttlMs);
                                                        const stepSettleTimeout = chain.idempotencyOptions?.settleTimeoutMs;
                                                        const stepPollInterval = chain.idempotencyOptions?.pollIntervalMs || 50;

                                                        if (claim === Status.IN_PROGRESS && stepSettleTimeout && stepSettleTimeout > 0) {
                                                            const deadline = Date.now() + stepSettleTimeout;
                                                            while (Date.now() < deadline) {
                                                                await new Promise(res => setTimeout(res, Math.min(stepPollInterval, Math.max(1, deadline - Date.now()))));
                                                                if (typeof stepIdempStore.getRecord === 'function') {
                                                                    const rec = await stepIdempStore.getRecord(stepIdempKey);
                                                                    if (rec?.status === Status.COMPLETED) {
                                                                        claim = Status.COMPLETED;
                                                                        break;
                                                                    }
                                                                    if (!rec) {
                                                                        claim = await stepIdempStore.claim(stepIdempKey, chain.idempotencyOptions?.ttlMs);
                                                                        if (claim === Status.CLAIMED || claim === Status.COMPLETED) {
                                                                            break;
                                                                        }
                                                                    }
                                                                } else {
                                                                    const stored = await stepIdempStore.get?.(stepIdempKey);
                                                                    if (stored !== undefined) {
                                                                        claim = Status.COMPLETED;
                                                                        break;
                                                                    }
                                                                }
                                                            }
                                                        }

                                                        if (claim === Status.COMPLETED) {
                                                            const cachedRes = await stepIdempStore.get(stepIdempKey);
                                                            clearStepTimeout();
                                                            emitMonitoringEvent(options, {
                                                                type: 'step:complete',
                                                                stackId,
                                                                stepId,
                                                                stepName: chainName,
                                                                durationMs: Math.max(0, Date.now() - stepStartTime),
                                                                outputSummary: cachedRes,
                                                                timestamp: Date.now(),
                                                                namespace: options?.namespace
                                                            });
                                                            new ResolveChain(safeResolve, cachedRes, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                            return;
                                                        }
                                                        if (claim === Status.IN_PROGRESS) {
                                                            clearStepTimeout();
                                                            safeReject(new IdempotencyConflictException(stepIdempKey, { stackId, stepName: chainName, namespace: options?.namespace }));
                                                            return;
                                                        }
                                                    } catch (idempErr) {
                                                        clearStepTimeout();
                                                        safeReject(idempErr);
                                                        return;
                                                    }
                                                }

                                                const registerStepCompensation = (stepOutput: any) => {
                                                    if (chain.compensationHandler || chain.compensationHandlerName) {
                                                        try {
                                                            const payload = chain.compensationPayloadMapper
                                                                ? chain.compensationPayloadMapper(stepOutput, param)
                                                                : stepOutput;
                                                            defaultCompensationManager.registerCompensation(stackId, {
                                                                stepId: chain.$stepId,
                                                                stepName: chainName,
                                                                output: stepOutput,
                                                                input: toPOJO(param),
                                                                handler: chain.compensationHandler,
                                                                handlerName: chain.compensationHandlerName,
                                                                payload: toPOJO(payload),
                                                                options: chain.compensationOptions
                                                            });
                                                        } catch (compErr) {
                                                            /* c8 ignore next 2 */
                                                            logError('SingleChain', compErr);
                                                        }
                                                    }
                                                };

                                                const executeOnAfterAndResolve = (output: any, ctx: any) => {
                                                    emitMonitoringEvent(options, {
                                                        type: 'step:complete',
                                                        stackId,
                                                        stepId,
                                                        stepName: chainName,
                                                        durationMs: Math.max(0, Date.now() - stepStartTime),
                                                        outputSummary: output,
                                                        timestamp: Date.now(),
                                                        namespace: options?.namespace
                                                    });
                                                    registerStepCompensation(output);
                                                    new OnAfter(chain, output, param, ctx, propertyToContext, () => {
                                                        clearStepTimeout();
                                                        if (stepIdempKey) {
                                                            stepIdempStore.complete(stepIdempKey, output).catch(() => {});
                                                        }
                                                        new ResolveChain(safeResolve, ctx.getData(), chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                    }, (afterErr: any) => {
                                                        if (stepIdempKey) {
                                                            if (isPermanentBusinessError(afterErr, chain.idempotencyOptions)) {
                                                                stepIdempStore.complete(stepIdempKey, { error: afterErr.message, isPermanentError: true, name: afterErr.name }).catch(() => {});
                                                            } else {
                                                                stepIdempStore.fail(stepIdempKey, afterErr).catch(() => {});
                                                            }
                                                        }
                                                        clearStepTimeout();
                                                        tagErrorPhase(afterErr, ExecutionPhase.AFTER, chainName);
                                                        new OnFail(chain, afterErr, (resolvedCtx: any) => {
                                                            new ResolveChain(safeResolve, resolvedCtx, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                        }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, executeAfter, Context, options);
                                                    });
                                                };

                                                if (chain.reducer && param[chain.reducer]) {
                                                    const array = typeof param[chain.reducer] === 'function' ? param[chain.reducer]() : param[chain.reducer];
                                                    const runReducerAction = () => {
                                                        new Reducer(array, toPOJO(param), chain, Context, propertyToContext, undefined, stackId)
                                                            .reduce((err: any, result: any) => {
                                                                clearStepTimeout();
                                                                if (err) {
                                                                    if (stepIdempKey) {
                                                                        if (isPermanentBusinessError(err, chain.idempotencyOptions)) {
                                                                            stepIdempStore.complete(stepIdempKey, { error: err.message, isPermanentError: true, name: err.name }).catch(() => {});
                                                                        } else {
                                                                            stepIdempStore.fail(stepIdempKey, err).catch(() => {});
                                                                        }
                                                                    }
                                                                    tagErrorPhase(err, ExecutionPhase.ACTION, chainName);
                                                                    new OnFail(chain, err, (context: any) => {
                                                                        new ResolveChain(safeResolve, context, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                                    }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                                                                } else {
                                                                    let enrichedResult = Object.assign({}, result);
                                                                    registerStepCompensation(enrichedResult);
                                                                    new OnAfter(chain, enrichedResult, param, enrichedResult, (_ctx: any, enrichProps: any) => {
                                                                        for (const k in enrichProps) {
                                                                            const v = enrichProps[k];
                                                                            enrichedResult[k] = v;
                                                                        }
                                                                    }, () => {
                                                                        clearStepTimeout();
                                                                        if (stepIdempKey) {
                                                                            stepIdempStore.complete(stepIdempKey, enrichedResult).catch(() => {});
                                                                        }
                                                                        emitMonitoringEvent(options, {
                                                                            type: 'step:complete',
                                                                            stackId,
                                                                            stepId,
                                                                            stepName: chainName,
                                                                            durationMs: Math.max(0, Date.now() - stepStartTime),
                                                                            outputSummary: enrichedResult,
                                                                            timestamp: Date.now(),
                                                                            namespace: options?.namespace
                                                                        });
                                                                        new ResolveChain(safeResolve, enrichedResult, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                                    }, (afterErr: any) => {
                                                                        tagErrorPhase(afterErr, ExecutionPhase.AFTER, chainName);
                                                                        new OnFail(chain, afterErr, (context: any) => {
                                                                            new ResolveChain(safeResolve, context, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                                        }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                                                                    });
                                                                }
                                                            });
                                                    };

                                                    runReducerAction();
                                                } else {
                                                    let cacheKey = typeof chains === 'string' ? chains : (chain.name || (chains && chains.$stepId) || chain.$stepId);
                                                    let actionParam = Object.assign({}, toPOJO(param));
                                                    (actionParam as any)[SERVICES] = mergedServices;
                                                    (actionParam as any)[DEPENDENCIES] = mergedServices;
                                                    (actionParam as any)[DEPS] = mergedServices;
                                                    if (stackId) {
                                                        const stackFn: any = () => stackId;
                                                        stackFn.val = stackId;
                                                        (actionParam as any)[STACK_ID] = stackFn;
                                                        (actionParam as any)[STACK_ID_KEY] = stackFn;
                                                        (actionParam as any).$stackId = stackFn;
                                                        (actionParam as any).stackId = stackId;
                                                    }
                                                    if (options?.namespace) {
                                                        const nsFn: any = () => options.namespace;
                                                        nsFn.val = options.namespace;
                                                        (actionParam as any)[NAMESPACE] = nsFn;
                                                        (actionParam as any)[NAMESPACE_KEY] = nsFn;
                                                        (actionParam as any).$namespace = nsFn;
                                                        (actionParam as any).namespace = options.namespace;
                                                    }
                                                    if (stepEffectiveSignal) {
                                                        const sigFn: any = () => stepEffectiveSignal;
                                                        sigFn.val = stepEffectiveSignal;
                                                        sigFn.aborted = stepEffectiveSignal.aborted;
                                                        sigFn.addEventListener = stepEffectiveSignal.addEventListener.bind(stepEffectiveSignal);
                                                        sigFn.removeEventListener = stepEffectiveSignal.removeEventListener.bind(stepEffectiveSignal);
                                                        (actionParam as any)[SIGNAL] = sigFn;
                                                        (actionParam as any)[SIGNAL_KEY] = sigFn;
                                                        (actionParam as any).signal = stepEffectiveSignal;
                                                        (actionParam as any).$signal = sigFn;
                                                    }
                                                    if (initialParam?.[ATTEMPT] || param[ATTEMPT]) {
                                                        const attVal = param[ATTEMPT] || initialParam[ATTEMPT];
                                                        (actionParam as any)[ATTEMPT] = attVal;
                                                        (actionParam as any).$attempt = attVal;
                                                    }
                                                    if (initialParam?.[RETRY_DELAY] || param[RETRY_DELAY]) {
                                                        const delVal = param[RETRY_DELAY] || initialParam[RETRY_DELAY];
                                                        (actionParam as any)[RETRY_DELAY] = delVal;
                                                        (actionParam as any).$retryDelay = delVal;
                                                    }
                                                    if (param?.[STEPS] || (param as any)?.$steps || initialParam?.[STEPS] || (initialParam as any)?.$steps) {
                                                        const stepsFn = param?.[STEPS] || (param as any)?.$steps || initialParam?.[STEPS] || (initialParam as any)?.$steps;
                                                        (actionParam as any)[STEPS] = stepsFn;
                                                        (actionParam as any)[HISTORY] = param[HISTORY] || (param as any).$history || stepsFn;
                                                        (actionParam as any).$steps = stepsFn;
                                                        (actionParam as any).$history = stepsFn;
                                                    }
                                                    let rawAction: any;
                                                    try {
                                                        const runAction = () => chain.cachedLast
                                                            ? cache(stackId, cacheKey, actionParam, chain.cachedLast, chain.action, options?.namespace, chain.cacheOptions)
                                                            : chain.action(actionParam);

                                                        rawAction = runAction();
                                                    } catch (actionErr: any) {
                                                        if (stepIdempKey) {
                                                            if (isPermanentBusinessError(actionErr, chain.idempotencyOptions)) {
                                                                stepIdempStore.complete(stepIdempKey, { error: actionErr.message, isPermanentError: true, name: actionErr.name }).catch(() => {});
                                                            } else {
                                                                stepIdempStore.fail(stepIdempKey, actionErr).catch(() => {});
                                                            }
                                                        }
                                                        clearStepTimeout();
                                                        tagErrorPhase(actionErr, ExecutionPhase.ACTION, chainName);
                                                        new OnFail(chain, actionErr, (resolvedCtx: any) => {
                                                            new ResolveChain(safeResolve, resolvedCtx, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                        }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, executeAfter, Context, options);
                                                        return;
                                                    }
                                                    const context = Context.createContext(chain.$stepId, stackId, options?.namespace);
                                                    logInfo('SingleChain', {
                                                        chain: chains,
                                                        message: 'Starting action',
                                                        param
                                                    });

                                                    let action: any;
                                                    if (stepTimeoutMs && stepTimeoutMs > 0 && stepController) {
                                                        const timeoutPromise = new Promise((_, rejectTimeout) => {
                                                            /* c8 ignore next 2 */
                                                            if (stepController!.signal.aborted) {
                                                                rejectTimeout(stepController!.signal.reason);
                                                            } else {
                                                                stepController!.signal.addEventListener('abort', () => {
                                                                    rejectTimeout(stepController!.signal.reason);
                                                                }, { once: true });
                                                            }
                                                        });
                                                        action = rawAction instanceof Promise
                                                            ? Promise.race([rawAction, timeoutPromise])
                                                            : Promise.race([Promise.resolve(rawAction), timeoutPromise]);
                                                    } else {
                                                        action = rawAction;
                                                    }

                                                    if (action !== undefined) {
                                                        if (action instanceof Promise) {
                                                            action.then(props => {
                                                                clearStepTimeout();
                                                                propertyToContext(context, props);
                                                                executeOnAfterAndResolve(props, context);
                                                            }).catch(err => {
                                                                if (stepIdempKey) {
                                                                    if (isPermanentBusinessError(err, chain.idempotencyOptions)) {
                                                                        stepIdempStore.complete(stepIdempKey, { error: err.message, isPermanentError: true, name: err.name }).catch(() => {});
                                                                    } else {
                                                                        stepIdempStore.fail(stepIdempKey, err).catch(() => {});
                                                                    }
                                                                }
                                                                clearStepTimeout();
                                                                tagErrorPhase(err, ExecutionPhase.ACTION, chainName);
                                                                new OnFail(chain, err, (resolvedCtx) => {
                                                                    new ResolveChain(safeResolve, resolvedCtx, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                                }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, executeAfter, Context, options);
                                                            });
                                                        } else {
                                                            clearStepTimeout();
                                                            propertyToContext(context, action);
                                                            executeOnAfterAndResolve(action, context);
                                                        }
                                                    } else {
                                                        clearStepTimeout();
                                                        executeOnAfterAndResolve(undefined, context);
                                                    }
                                                }
                                            }, propertyToContext, stackId, options);
                                        };

                                        executeStepLifecycle();
                                    }).catch((err: any) => {
                                        clearStepTimeout();
                                        tagErrorPhase(err, ExecutionPhase.BEFORE, chainName);
                                        new OnFail(chain, err, safeResolve.bind(this), safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                                    });
                            }).catch((err: any) => {
                                clearStepTimeout();
                                const violation = extractNetworkViolation(err);
                                if (violation) {
                                    tagErrorPhase(violation, ExecutionPhase.VALIDATION, chainName);
                                    err = violation;
                                } else {
                                    tagErrorPhase(err, ExecutionPhase.VALIDATION, chainName);
                                }
                                new OnFail(chain, err, safeResolve.bind(this), safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                            });
                        };

                        if (effectiveNetworkPolicy?.enabled) {
                            networkPolicyStorage.run(
                                { ...effectiveNetworkPolicy, stepName: chainName },
                                executeInspectedStep
                            );
                        } else {
                            executeInspectedStep();
                        }
                    } catch (err: any) {
                        clearStepTimeout();
                        tagErrorPhase(err, ExecutionPhase.ACTION, chainName);
                        new OnFail(chain, err, safeResolve.bind(this), safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                    }
                });
            });
        };
    }
/* c8 ignore next */
}
