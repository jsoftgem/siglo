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
const context_1 = require("../../context");
const shared_1 = require("../../../shared");
const exceptions_1 = require("../exceptions");
const signals_1 = require("../signals");
const compensation_1 = require("../../compensation");
const idempotency_1 = require("../../idempotency");
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
                        const paramAsContext = new Context(contextChainId, stackId, options?.namespace);
                        new AddSpecToContext_1.default(chain.specs, paramAsContext);
                        new AddInitialParam_1.default(initialParam, paramAsContext);
                        paramAsContext.runSpecs().then(() => {
                            const initialData = paramAsContext.getData();
                            let param = new ConvertParamFromSpec_1.default(Object.assign({}, initialParam, initialData), chain).getParam();
                            if (stepEffectiveSignal) {
                                const sigFn = () => stepEffectiveSignal;
                                sigFn.val = stepEffectiveSignal;
                                param[shared_1.SIGNAL] = sigFn;
                                param[shared_1.SIGNAL_KEY] = sigFn;
                            }
                            if (options?.namespace) {
                                const nsFn = () => options.namespace;
                                nsFn.val = options.namespace;
                                param[shared_1.NAMESPACE] = nsFn;
                                param[shared_1.NAMESPACE_KEY] = nsFn;
                            }
                            if (initialParam?.[shared_1.ATTEMPT]) {
                                param[shared_1.ATTEMPT] = initialParam[shared_1.ATTEMPT];
                            }
                            if (initialParam?.[shared_1.RETRY_DELAY]) {
                                param[shared_1.RETRY_DELAY] = initialParam[shared_1.RETRY_DELAY];
                            }
                            if (initialParam?.[shared_1.STEPS]) {
                                param[shared_1.STEPS] = initialParam[shared_1.STEPS];
                                param[shared_1.HISTORY] = initialParam[shared_1.HISTORY] || initialParam[shared_1.STEPS];
                            }
                            if (initialParam?.[shared_1.IS_DURABLE]) {
                                param[shared_1.IS_DURABLE] = initialParam[shared_1.IS_DURABLE];
                            }
                            executeBefore(chain.func, param)
                                .then(resolvedPluginData => {
                                const newContext = new Context('_before_temp', stackId, options?.namespace);
                                new SetResolvedContexts_1.default(resolvedPluginData, newContext);
                                param = Object.assign({}, param, newContext.getData());
                                if (stepEffectiveSignal) {
                                    const sigFn = () => stepEffectiveSignal;
                                    sigFn.val = stepEffectiveSignal;
                                    param[shared_1.SIGNAL] = sigFn;
                                    param[shared_1.SIGNAL_KEY] = sigFn;
                                }
                                if (options?.namespace) {
                                    const nsFn = () => options.namespace;
                                    nsFn.val = options.namespace;
                                    param[shared_1.NAMESPACE] = nsFn;
                                    param[shared_1.NAMESPACE_KEY] = nsFn;
                                }
                                if (initialParam?.[shared_1.ATTEMPT]) {
                                    param[shared_1.ATTEMPT] = initialParam[shared_1.ATTEMPT];
                                }
                                if (initialParam?.[shared_1.RETRY_DELAY]) {
                                    param[shared_1.RETRY_DELAY] = initialParam[shared_1.RETRY_DELAY];
                                }
                                if (initialParam?.[shared_1.STEPS]) {
                                    param[shared_1.STEPS] = initialParam[shared_1.STEPS];
                                    param[shared_1.HISTORY] = initialParam[shared_1.HISTORY] || initialParam[shared_1.STEPS];
                                }
                                if (initialParam?.[shared_1.IS_DURABLE]) {
                                    param[shared_1.IS_DURABLE] = initialParam[shared_1.IS_DURABLE];
                                }
                                new OnBefore_1.default(chain, param, (val) => {
                                    clearStepTimeout();
                                    safeResolve(val);
                                }, (err) => {
                                    clearStepTimeout();
                                    (0, shared_1.tagErrorPhase)(err, shared_1.ExecutionPhase.BEFORE, chainName);
                                    new OnFail_1.default(chain, err, context => {
                                        new ResolveChain_1.default(safeResolve, context, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                    }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                                }, Context, async () => {
                                    let stepIdempKey;
                                    const stepIdempStore = chain.idempotencyOptions?.store || idempotency_1.defaultIdempotencyStore;
                                    if (chain.idempotencyKey) {
                                        try {
                                            const rawKey = (0, shared_1.isFunction)(chain.idempotencyKey)
                                                ? chain.idempotencyKey((0, context_1.toPOJO)(param))
                                                : chain.idempotencyKey;
                                            stepIdempKey = (0, idempotency_1.buildIdempotencyKey)(rawKey, {
                                                namespace: options?.namespace
                                            });
                                            const claim = await stepIdempStore.claim(stepIdempKey, chain.idempotencyOptions?.ttlMs);
                                            if (claim === shared_1.Status.COMPLETED) {
                                                const cachedRes = await stepIdempStore.get(stepIdempKey);
                                                clearStepTimeout();
                                                new ResolveChain_1.default(safeResolve, cachedRes, chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                                return;
                                            }
                                            if (claim === shared_1.Status.IN_PROGRESS) {
                                                clearStepTimeout();
                                                safeReject(new exceptions_1.IdempotencyConflictException(stepIdempKey, { stackId, stepName: chainName, namespace: options?.namespace }));
                                                return;
                                            }
                                        }
                                        catch (idempErr) {
                                            clearStepTimeout();
                                            safeReject(idempErr);
                                            return;
                                        }
                                    }
                                    const executeOnAfterAndResolve = (output, ctx) => {
                                        if (stepIdempKey) {
                                            stepIdempStore.complete(stepIdempKey, output).catch(() => { });
                                        }
                                        if (chain.compensationHandler) {
                                            compensation_1.defaultCompensationManager.registerCompensation(stackId, {
                                                stepId: chain.$stepId || chain.$chainId,
                                                stepName: chainName,
                                                output,
                                                input: (0, context_1.toPOJO)(param),
                                                handler: chain.compensationHandler,
                                                options: chain.compensationOptions
                                            });
                                        }
                                        new OnAfter_1.default(chain, output, param, ctx, propertyToContext, () => {
                                            clearStepTimeout();
                                            new ResolveChain_1.default(safeResolve, ctx.getData(), chainName, logInfo, executeAfter, Context, safeReject, stepOptions);
                                        }, (afterErr) => {
                                            if (stepIdempKey) {
                                                stepIdempStore.fail(stepIdempKey, afterErr).catch(() => { });
                                            }
                                            clearStepTimeout();
                                            (0, shared_1.tagErrorPhase)(afterErr, shared_1.ExecutionPhase.AFTER, chainName);
                                            new OnFail_1.default(chain, afterErr, (resolvedCtx) => {
                                                new ResolveChain_1.default(safeResolve, resolvedCtx, chainName, logInfo, undefined, undefined, safeReject, stepOptions);
                                            }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, executeAfter, Context, options);
                                        });
                                    };
                                    if (chain.reducer && param[chain.reducer]) {
                                        const array = param[chain.reducer]();
                                        new Reducer(array, (0, context_1.wrapParam)(param), chain, Context, propertyToContext, undefined, stackId)
                                            .reduce((err, result) => {
                                            clearStepTimeout();
                                            if (err) {
                                                if (stepIdempKey) {
                                                    stepIdempStore.fail(stepIdempKey, err).catch(() => { });
                                                }
                                                (0, shared_1.tagErrorPhase)(err, shared_1.ExecutionPhase.ACTION, chainName);
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
                                                    (0, shared_1.tagErrorPhase)(afterErr, shared_1.ExecutionPhase.AFTER, chainName);
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
                                        const wrappedParam = isPojo ? (0, context_1.toPOJO)(param) : (0, context_1.wrapParam)(param);
                                        let actionParam = (chain.isModern || isPojo) ? (0, context_1.toPOJO)(param) : wrappedParam;
                                        if (chain.isModern || isPojo) {
                                            actionParam = Object.assign({}, actionParam);
                                        }
                                        if (stackId) {
                                            actionParam[shared_1.STACK_ID] = () => stackId;
                                            actionParam[shared_1.STACK_ID_KEY] = stackId;
                                        }
                                        if (options?.namespace) {
                                            actionParam[shared_1.NAMESPACE] = () => options.namespace;
                                            actionParam[shared_1.NAMESPACE_KEY] = options.namespace;
                                        }
                                        let rawAction;
                                        try {
                                            rawAction = chain.cachedLast
                                                ? cache(stackId, cacheKey, actionParam, chain.cachedLast, chain.action, options?.namespace, chain.cacheOptions)
                                                : chain.action(actionParam);
                                        }
                                        catch (actionErr) {
                                            if (stepIdempKey) {
                                                stepIdempStore.fail(stepIdempKey, actionErr).catch(() => { });
                                            }
                                            clearStepTimeout();
                                            (0, shared_1.tagErrorPhase)(actionErr, shared_1.ExecutionPhase.ACTION, chainName);
                                            new OnFail_1.default(chain, actionErr, (resolvedCtx) => {
                                                new ResolveChain_1.default(safeResolve, resolvedCtx, chainName, logInfo, undefined, undefined, safeReject, stepOptions);
                                            }, safeReject.bind(this), this, initialParam, chains, logInfo, logError, executeAfter, Context, options);
                                            return;
                                        }
                                        const context = Context.createContext(chain.$chainId, stackId, options?.namespace);
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
                                                    if (stepIdempKey) {
                                                        stepIdempStore.fail(stepIdempKey, err).catch(() => { });
                                                    }
                                                    clearStepTimeout();
                                                    (0, shared_1.tagErrorPhase)(err, shared_1.ExecutionPhase.ACTION, chainName);
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
                                (0, shared_1.tagErrorPhase)(err, shared_1.ExecutionPhase.BEFORE, chainName);
                                new OnFail_1.default(chain, err, safeResolve.bind(this), safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                            });
                        }).catch((err) => {
                            clearStepTimeout();
                            (0, shared_1.tagErrorPhase)(err, shared_1.ExecutionPhase.VALIDATION, chainName);
                            new OnFail_1.default(chain, err, safeResolve.bind(this), safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                        });
                    }
                    catch (err) {
                        clearStepTimeout();
                        (0, shared_1.tagErrorPhase)(err, shared_1.ExecutionPhase.ACTION, chainName);
                        new OnFail_1.default(chain, err, safeResolve.bind(this), safeReject.bind(this), this, initialParam, chains, logInfo, logError, undefined, undefined, options);
                    }
                });
            });
        };
    }
}
exports.default = StartChain;
//# sourceMappingURL=StartChain.js.map