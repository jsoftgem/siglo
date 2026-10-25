import AddSpecToContext from './Helpers/AddSpecToContext';
import AddInitialParam from './Helpers/AddInitialParam';
import ConvertParamFromSpec from './Helpers/ConvertParamFromSpec';
import SetResolvedContexts from './Helpers/SetResolvedContexts';
import OnAfter from './LifeCycle/OnAfter';
import OnBefore from './LifeCycle/OnBefore';
import OnFail from './LifeCycle/OnFail';
import ResolveChain from './Helpers/ResolveChain';
import { wrapParam, toPOJO } from '../../context';
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
    STACK_ID_KEY
} from '../../../shared';
import { StepTimeoutException, IdempotencyConflictException } from '../exceptions';
import { combineAbortSignals } from '../signals';
import { defaultCompensationManager } from '../../compensation';
import { defaultIdempotencyStore, buildIdempotencyKey } from '../../idempotency';

export default class StartChain {
    start: (initialParam: any, chains: any, options?: any) => Promise<any>;

    constructor(
        getChain: (name: any) => any,
        Context: any,
        propertyToContext: (context: any, chainReturn: any) => void,
        Reducer: any,
        addChainToStack: (stackId: string, chainId: string) => void,
        stackId: string,
        cache: any,
        logInfo: (source: string, message: any) => void,
        logError: (source: string, error: any) => void,
        executeAfter: (chain: string, context: any) => Promise<any>,
        executeBefore: (chain: string, context: any) => Promise<any>
    ) {
        this.start = (initialParam: any, chains: any, options?: any) => {
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

                let cleanupAbort: (() => void) | undefined;
                if (options?.signal) {
                    const onAbort = () => {
                        reject(options.signal.reason || new Error('This operation was aborted'));
                    };
                    options.signal.addEventListener('abort', onAbort, { once: true });
                    cleanupAbort = () => {
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

                setTimeout(() => {
                    const chain = (chains && typeof chains === 'object')
                        ? Object.assign({}, chains, {
                            $chainId: generateUUID(),
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
                        addChainToStack(stackId, chain.$chainId);
                        /* c8 ignore next 3 */
                        const contextChainId = typeof initialParam?.$chainId === 'function'
                            ? initialParam.$chainId()
                            : (initialParam?.$chainId || chain.$chainId);
                        const paramAsContext = new Context(contextChainId, stackId, options?.namespace);
                        new AddSpecToContext(chain.specs, paramAsContext);
                        new AddInitialParam(initialParam, paramAsContext);
                        paramAsContext.runSpecs().then(() => {
                            const initialData = paramAsContext.getData();
                            let param = new ConvertParamFromSpec(Object.assign({}, initialParam, initialData), chain).getParam();
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
                            executeBefore(chain.func, param)
                                .then(resolvedPluginData => {
                                    const newContext = new Context('_before_temp', stackId, options?.namespace);
                                    new SetResolvedContexts(resolvedPluginData, newContext);
                                    param = Object.assign({}, param, newContext.getData());
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
                                                const rawKey = isFunction(chain.idempotencyKey)
                                                    ? chain.idempotencyKey(toPOJO(param))
                                                    : chain.idempotencyKey;
                                                stepIdempKey = buildIdempotencyKey(rawKey, {
                                                    namespace: options?.namespace
                                                });
                                                const claim = await stepIdempStore.claim(stepIdempKey, chain.idempotencyOptions?.ttlMs);
                                                if (claim === Status.COMPLETED) {
                                                    const cachedRes = await stepIdempStore.get(stepIdempKey);
                                                    clearStepTimeout();
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

                                        const executeOnAfterAndResolve = (output: any, ctx: any) => {
                                            if (stepIdempKey) {
                                                stepIdempStore.complete(stepIdempKey, output).catch(() => {});
                                            }
                                            if (chain.compensationHandler) {
                                                defaultCompensationManager.registerCompensation(stackId, {
                                                    stepId: chain.$stepId || chain.$chainId,
                                                    stepName: chainName,
                                                    output,
                                                    input: toPOJO(param),
                                                    handler: chain.compensationHandler,
                                                    options: chain.compensationOptions
                                                });
                                            }
                                            new OnAfter(chain, output, param, ctx, propertyToContext, () => {
                                                clearStepTimeout();
                                                new ResolveChain(safeResolve, ctx.getData(), chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                            }, (afterErr: any) => {
                                                if (stepIdempKey) {
                                                    stepIdempStore.fail(stepIdempKey, afterErr).catch(() => {});
                                                }
                                                clearStepTimeout();
                                                tagErrorPhase(afterErr, ExecutionPhase.AFTER, chainName);
                                                new OnFail(chain, afterErr, (resolvedCtx: any) => {
                                                    new ResolveChain(safeResolve, resolvedCtx, chainName, logInfo, undefined, undefined, safeReject, stepOptions);
                                                }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, executeAfter, Context, options);
                                            });
                                        };

                                        if (chain.reducer && param[chain.reducer]) {
                                            const array = param[chain.reducer]();
                                            new Reducer(array, wrapParam(param), chain, Context, propertyToContext, undefined, stackId)
                                                .reduce((err: any, result: any) => {
                                                    clearStepTimeout();
                                                    if (err) {
                                                        if (stepIdempKey) {
                                                            stepIdempStore.fail(stepIdempKey, err).catch(() => {});
                                                        }
                                                        tagErrorPhase(err, ExecutionPhase.ACTION, chainName);
                                                        new OnFail(chain, err, (context: any) => {
                                                            new ResolveChain(safeResolve, context, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                        }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                                                    } else {
                                                        new OnAfter(chain, result, param, result, (_ctx: any, enrichProps: any) => {
                                                            for (const k in enrichProps) {
                                                                const v = enrichProps[k];
                                                                result[k] = () => v;
                                                            }
                                                        }, () => {
                                                            new ResolveChain(safeResolve, result, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                        }, (afterErr: any) => {
                                                            tagErrorPhase(afterErr, ExecutionPhase.AFTER, chainName);
                                                            new OnFail(chain, afterErr, (context: any) => {
                                                                new ResolveChain(safeResolve, context, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                            }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                                                        });
                                                    }
                                                });
                                        } else {
                                            let cacheKey = typeof chains === 'string' ? chains : (chain.name || (chains && chains.$chainId) || chain.$chainId);
                                            const isPojo = options?.pojo === true || options?.mode === 'pojo';
                                            const wrappedParam = isPojo ? toPOJO(param) : wrapParam(param);
                                            let actionParam = (chain.isModern || isPojo) ? toPOJO(param) : wrappedParam;
                                            if (chain.isModern || isPojo) {
                                                actionParam = Object.assign({}, actionParam);
                                            }
                                            if (stackId) {
                                                (actionParam as any)[STACK_ID] = () => stackId;
                                                (actionParam as any)[STACK_ID_KEY] = stackId;
                                            }
                                            if (options?.namespace) {
                                                (actionParam as any)[NAMESPACE] = () => options.namespace;
                                                (actionParam as any)[NAMESPACE_KEY] = options.namespace;
                                            }
                                            let rawAction: any;
                                            try {
                                                rawAction = chain.cachedLast
                                                    ? cache(stackId, cacheKey, actionParam, chain.cachedLast, chain.action, options?.namespace, chain.cacheOptions)
                                                    : chain.action(actionParam);
                                            } catch (actionErr: any) {
                                                if (stepIdempKey) {
                                                    stepIdempStore.fail(stepIdempKey, actionErr).catch(() => {});
                                                }
                                                clearStepTimeout();
                                                tagErrorPhase(actionErr, ExecutionPhase.ACTION, chainName);
                                                new OnFail(chain, actionErr, (resolvedCtx: any) => {
                                                    new ResolveChain(safeResolve, resolvedCtx, chainName, logInfo, undefined, undefined, safeReject, stepOptions);
                                                }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, executeAfter, Context, options);
                                                return;
                                            }
                                            const context = Context.createContext(chain.$chainId, stackId, options?.namespace);
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
                                                            stepIdempStore.fail(stepIdempKey, err).catch(() => {});
                                                        }
                                                        clearStepTimeout();
                                                        tagErrorPhase(err, ExecutionPhase.ACTION, chainName);
                                                        new OnFail(chain, err, (resolvedCtx) => {
                                                            new ResolveChain(safeResolve, resolvedCtx, chainName, logInfo, undefined, undefined, safeReject, stepOptions);
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
                                    }, propertyToContext, stackId);
                                }).catch((err: any) => {
                                    clearStepTimeout();
                                    tagErrorPhase(err, ExecutionPhase.BEFORE, chainName);
                                    new OnFail(chain, err, safeResolve.bind(this), safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                                });
                        }).catch((err: any) => {
                            clearStepTimeout();
                            tagErrorPhase(err, ExecutionPhase.VALIDATION, chainName);
                            new OnFail(chain, err, safeResolve.bind(this), safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                        });
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
