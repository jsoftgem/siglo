"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const AddSpecToContext_1 = __importDefault(require("./Helpers/AddSpecToContext"));
const AddInitialParam_1 = __importDefault(require("./Helpers/AddInitialParam"));
const ConvertParamFromSpec_1 = __importDefault(require("./Helpers/ConvertParamFromSpec"));
const SetResolvedContexts_1 = __importDefault(require("./Helpers/SetResolvedContexts"));
const OnAfter_1 = __importDefault(require("./LifeCycle/OnAfter"));
const OnBefore_1 = __importDefault(require("./LifeCycle/OnBefore"));
const OnFail_1 = __importDefault(require("./LifeCycle/OnFail"));
const ResolveChain_1 = __importDefault(require("./Helpers/ResolveChain"));
const proxy_1 = require("../../context/proxy");
const shared_1 = require("../../../shared");
const exceptions_1 = require("../exceptions");
const signals_1 = require("../signals");
class StartChain {
    start;
    constructor(getChain, Context, propertyToContext, Reducer, addChainToStack, stackId, cache, logInfo, logError, executeAfter, executeBefore) {
        this.start = (initialParam, chains, options) => {
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
                let cleanupAbort;
                if (options?.signal) {
                    const onAbort = () => {
                        reject(options.signal.reason || new Error('This operation was aborted'));
                    };
                    options.signal.addEventListener('abort', onAbort, { once: true });
                    cleanupAbort = () => {
                        options.signal.removeEventListener('abort', onAbort);
                    };
                }
                const safeResolve = (val) => {
                    cleanupAbort?.();
                    resolve(val);
                };
                const safeReject = (err) => {
                    cleanupAbort?.();
                    reject(err);
                };
                setTimeout(() => {
                    const chain = (chains && typeof chains === 'object')
                        ? Object.assign({}, chains, {
                            $chainId: (0, shared_1.generateUUID)(),
                            func: chains.func || chains.name || ''
                        })
                        : getChain(chains);
                    const chainName = chain.func || (typeof chains === 'string' ? chains : (chain.name || ''));
                    const stepTimeoutMs = chain.timeoutMs || (typeof chain.timeout === 'number' ? chain.timeout : undefined);
                    let stepController;
                    let stepTimer;
                    let stepSignalCleanup = () => { };
                    let stepEffectiveSignal = options?.signal;
                    let stepOptions = options;
                    if (stepTimeoutMs && stepTimeoutMs > 0) {
                        stepController = new AbortController();
                        const stepStartTime = Date.now();
                        stepTimer = setTimeout(() => {
                            const elapsed = Date.now() - stepStartTime;
                            stepController.abort(new exceptions_1.StepTimeoutException(chainName, stepTimeoutMs, elapsed));
                        }, stepTimeoutMs);
                        const combined = (0, signals_1.combineAbortSignals)([options?.signal, stepController.signal]);
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
                        const paramAsContext = new Context(contextChainId, stackId, options?.tenantId);
                        new AddSpecToContext_1.default(chain.specs, paramAsContext);
                        new AddInitialParam_1.default(initialParam, paramAsContext);
                        paramAsContext.runSpecs().then(() => {
                            const initialData = paramAsContext.getData();
                            let param = new ConvertParamFromSpec_1.default(Object.assign({}, initialParam, initialData), chain).getParam();
                            if (stepEffectiveSignal) {
                                const sigFn = () => stepEffectiveSignal;
                                sigFn.val = stepEffectiveSignal;
                                param.$signal = sigFn;
                                param.signal = sigFn;
                            }
                            if (options?.tenantId) {
                                const tFn = () => options.tenantId;
                                tFn.val = options.tenantId;
                                param.$tenantId = tFn;
                                param.tenantId = tFn;
                            }
                            if (initialParam?.$steps) {
                                param.$steps = initialParam.$steps;
                                param.$history = initialParam.$history || initialParam.$steps;
                            }
                            executeBefore(chain.func, param)
                                .then(resolvedPluginData => {
                                const newContext = new Context('_before_temp', stackId, options?.tenantId);
                                new SetResolvedContexts_1.default(resolvedPluginData, newContext);
                                param = Object.assign({}, param, newContext.getData());
                                if (stepEffectiveSignal) {
                                    const sigFn = () => stepEffectiveSignal;
                                    sigFn.val = stepEffectiveSignal;
                                    param.$signal = sigFn;
                                    param.signal = sigFn;
                                }
                                if (options?.tenantId) {
                                    const tFn = () => options.tenantId;
                                    tFn.val = options.tenantId;
                                    param.$tenantId = tFn;
                                    param.tenantId = tFn;
                                }
                                if (initialParam?.$steps) {
                                    param.$steps = initialParam.$steps;
                                    param.$history = initialParam.$history || initialParam.$steps;
                                }
                                new OnBefore_1.default(chain, param, (val) => {
                                    clearStepTimeout();
                                    safeResolve(val);
                                }, (err) => {
                                    clearStepTimeout();
                                    new OnFail_1.default(chain, err, context => {
                                        new ResolveChain_1.default(safeResolve, context, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                    }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                                }, Context, () => {
                                    const executeOnAfterAndResolve = (output, ctx) => {
                                        new OnAfter_1.default(chain, output, param, ctx, propertyToContext, () => {
                                            clearStepTimeout();
                                            new ResolveChain_1.default(safeResolve, ctx.getData(), chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                        }, (afterErr) => {
                                            clearStepTimeout();
                                            new OnFail_1.default(chain, afterErr, (resolvedCtx) => {
                                                new ResolveChain_1.default(safeResolve, resolvedCtx, chainName, logInfo, undefined, undefined, safeReject, stepOptions);
                                            }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, executeAfter, Context, options);
                                        });
                                    };
                                    if (chain.reducer && param[chain.reducer]) {
                                        const array = param[chain.reducer]();
                                        new Reducer(array, (0, proxy_1.wrapParam)(param), chain, Context, propertyToContext, undefined, stackId)
                                            .reduce((err, result) => {
                                            clearStepTimeout();
                                            if (err) {
                                                new OnFail_1.default(chain, err, (context) => {
                                                    new ResolveChain_1.default(safeResolve, context, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                                            }
                                            else {
                                                new OnAfter_1.default(chain, result, param, result, (_ctx, enrichProps) => {
                                                    for (const k in enrichProps) {
                                                        const v = enrichProps[k];
                                                        result[k] = () => v;
                                                    }
                                                }, () => {
                                                    new ResolveChain_1.default(safeResolve, result, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                }, (afterErr) => {
                                                    new OnFail_1.default(chain, afterErr, (context) => {
                                                        new ResolveChain_1.default(safeResolve, context, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                    }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                                                });
                                            }
                                        });
                                    }
                                    else {
                                        let cacheKey = typeof chains === 'string' ? chains : (chain.name || (chains && chains.$chainId) || chain.$chainId);
                                        const isPojo = options?.pojo === true || options?.mode === 'pojo';
                                        const wrappedParam = isPojo ? (0, proxy_1.toPOJO)(param) : (0, proxy_1.wrapParam)(param);
                                        const actionParam = (chain.isModern || isPojo) ? (0, proxy_1.toPOJO)(param) : wrappedParam;
                                        const rawAction = chain.cachedLast
                                            ? cache(stackId, cacheKey, actionParam, chain.cachedLast, chain.action, options?.tenantId)
                                            : chain.action(actionParam);
                                        const context = Context.createContext(chain.$chainId, stackId, options?.tenantId);
                                        logInfo('SingleChain', {
                                            chain: chains,
                                            message: 'Starting action',
                                            param
                                        });
                                        let action;
                                        if (stepTimeoutMs && stepTimeoutMs > 0 && stepController) {
                                            const timeoutPromise = new Promise((_, rejectTimeout) => {
                                                /* c8 ignore next 2 */
                                                if (stepController.signal.aborted) {
                                                    rejectTimeout(stepController.signal.reason);
                                                }
                                                else {
                                                    stepController.signal.addEventListener('abort', () => {
                                                        rejectTimeout(stepController.signal.reason);
                                                    }, { once: true });
                                                }
                                            });
                                            action = rawAction instanceof Promise
                                                ? Promise.race([rawAction, timeoutPromise])
                                                : Promise.race([Promise.resolve(rawAction), timeoutPromise]);
                                        }
                                        else {
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
                                                    new OnFail_1.default(chain, err, (resolvedCtx) => {
                                                        new ResolveChain_1.default(safeResolve, resolvedCtx, chainName, logInfo, undefined, undefined, safeReject, stepOptions);
                                                    }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, executeAfter, Context, options);
                                                });
                                            }
                                            else {
                                                clearStepTimeout();
                                                propertyToContext(context, action);
                                                executeOnAfterAndResolve(action, context);
                                            }
                                        }
                                        else {
                                            clearStepTimeout();
                                            executeOnAfterAndResolve(undefined, context);
                                        }
                                    }
                                }, propertyToContext, stackId);
                            }).catch((err) => {
                                clearStepTimeout();
                                new OnFail_1.default(chain, err, safeResolve.bind(this), safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                            });
                        }).catch((err) => {
                            clearStepTimeout();
                            new OnFail_1.default(chain, err, safeResolve.bind(this), safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                        });
                    }
                    catch (err) {
                        clearStepTimeout();
                        new OnFail_1.default(chain, err, safeResolve.bind(this), safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                    }
                });
            });
        };
    }
}
exports.default = StartChain;
//# sourceMappingURL=StartChain.js.map