import AddSpecToContext from './Helpers/AddSpecToContext';
import AddInitialParam from './Helpers/AddInitialParam';
import ConvertParamFromSpec from './Helpers/ConvertParamFromSpec';
import SetResolvedContexts from './Helpers/SetResolvedContexts';
import OnAfter from './LifeCycle/OnAfter';
import OnBefore from './LifeCycle/OnBefore';
import OnFail from './LifeCycle/OnFail';
import ResolveChain from './Helpers/ResolveChain';
import { wrapParam, toPOJO } from '../../context';
import { generateUUID } from '../../../shared';
import { StepTimeoutException } from '../exceptions';
import { combineAbortSignals } from '../signals';

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
                                param.$signal = sigFn;
                                param.signal = sigFn;
                            }
                            if (options?.namespace) {
                                const nsFn = () => options.namespace;
                                (nsFn as any).val = options.namespace;
                                param.$namespace = nsFn;
                                param.namespace = nsFn;
                            }
                            if (initialParam?.$attempt) {
                                param.$attempt = initialParam.$attempt;
                            }
                            if (initialParam?.$retryDelay) {
                                param.$retryDelay = initialParam.$retryDelay;
                            }
                            if (initialParam?.$steps) {
                                param.$steps = initialParam.$steps;
                                param.$history = initialParam.$history || initialParam.$steps;
                            }
                            executeBefore(chain.func, param)
                                .then(resolvedPluginData => {
                                    const newContext = new Context('_before_temp', stackId, options?.namespace);
                                    new SetResolvedContexts(resolvedPluginData, newContext);
                                    param = Object.assign({}, param, newContext.getData());
                                    if (stepEffectiveSignal) {
                                        const sigFn = () => stepEffectiveSignal;
                                        (sigFn as any).val = stepEffectiveSignal;
                                        param.$signal = sigFn;
                                        param.signal = sigFn;
                                    }
                                    if (options?.namespace) {
                                        const nsFn = () => options.namespace;
                                        (nsFn as any).val = options.namespace;
                                        param.$namespace = nsFn;
                                        param.namespace = nsFn;
                                    }
                                    if (initialParam?.$attempt) {
                                        param.$attempt = initialParam.$attempt;
                                    }
                                    if (initialParam?.$retryDelay) {
                                        param.$retryDelay = initialParam.$retryDelay;
                                    }
                                    if (initialParam?.$steps) {
                                        param.$steps = initialParam.$steps;
                                        param.$history = initialParam.$history || initialParam.$steps;
                                    }
                                    new OnBefore(chain, param, (val) => {
                                        clearStepTimeout();
                                        safeResolve(val);
                                    }, (err: any) => {
                                        clearStepTimeout();
                                        if (err && typeof err === 'object') {
                                            err.phase = 'before';
                                            err.stepName = chainName;
                                        }
                                        new OnFail(chain, err, context => {
                                            new ResolveChain(safeResolve, context, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                        }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                                    }, Context, () => {
                                        const executeOnAfterAndResolve = (output: any, ctx: any) => {
                                            new OnAfter(chain, output, param, ctx, propertyToContext, () => {
                                                clearStepTimeout();
                                                new ResolveChain(safeResolve, ctx.getData(), chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                            }, (afterErr: any) => {
                                                clearStepTimeout();
                                                if (afterErr && typeof afterErr === 'object') {
                                                    afterErr.phase = 'after';
                                                    afterErr.stepName = chainName;
                                                }
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
                                                        if (err && typeof err === 'object') {
                                                            err.phase = 'action';
                                                            err.stepName = chainName;
                                                        }
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
                                                            if (afterErr && typeof afterErr === 'object') {
                                                                afterErr.phase = 'after';
                                                                afterErr.stepName = chainName;
                                                            }
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
                                            const actionParam = (chain.isModern || isPojo) ? toPOJO(param) : wrappedParam;
                                            let rawAction: any;
                                            try {
                                                rawAction = chain.cachedLast
                                                    ? cache(stackId, cacheKey, actionParam, chain.cachedLast, chain.action, options?.namespace, chain.cacheOptions)
                                                    : chain.action(actionParam);
                                            } catch (actionErr: any) {
                                                clearStepTimeout();
                                                if (actionErr && typeof actionErr === "object") {
                                                    actionErr.phase = "action";
                                                    actionErr.stepName = chainName;
                                                }
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
                                                        clearStepTimeout();
                                                        if (err && typeof err === 'object') {
                                                            err.phase = 'action';
                                                            err.stepName = chainName;
                                                        }
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
                                    if (err && typeof err === 'object') {
                                        err.phase = 'before';
                                        err.stepName = chainName;
                                    }
                                    new OnFail(chain, err, safeResolve.bind(this), safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                                });
                        }).catch((err: any) => {
                            clearStepTimeout();
                            if (err && typeof err === 'object') {
                                err.phase = 'validation';
                                err.stepName = chainName;
                            }
                            new OnFail(chain, err, safeResolve.bind(this), safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                        });
                    } catch (err: any) {
                        clearStepTimeout();
                        if (err && typeof err === 'object') {
                            err.phase = 'action';
                            err.stepName = chainName;
                        }
                        new OnFail(chain, err, safeResolve.bind(this), safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                    }
                });
            });
        };
    }
/* c8 ignore next */
}
