"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.propertyToContext = exports.Runner = void 0;
const shared_1 = require("../../shared");
const context_1 = require("../context");
const exceptions_1 = require("./exceptions");
const signals_1 = require("./signals");
const storage_1 = require("../storage");
const compensation_1 = require("../compensation");
const idempotency_1 = require("../idempotency");
class Runner {
    getChain;
    generateUUID;
    Context;
    SingleChain;
    ArrayChain;
    Reducer;
    Util;
    createExecutionStack;
    addChainToStack;
    deleteStack;
    cache;
    logInfo;
    logError;
    executeAfter;
    executeBefore;
    constructor(getChain, generateUUID, Context, SingleChain, ArrayChain, Reducer, Util, createExecutionStack, addChainToStack, deleteStack, cache, logInfo, logError, executeAfter, executeBefore) {
        this.getChain = getChain;
        this.generateUUID = generateUUID;
        this.Context = Context;
        this.SingleChain = SingleChain;
        this.ArrayChain = ArrayChain;
        this.Reducer = Reducer;
        this.Util = Util;
        this.createExecutionStack = createExecutionStack;
        this.addChainToStack = addChainToStack;
        this.deleteStack = deleteStack;
        this.cache = cache;
        this.logInfo = logInfo;
        this.logError = logError;
        this.executeAfter = executeAfter;
        this.executeBefore = executeBefore;
    }
    start(param, chains, rawOptions) {
        if (chains) {
            const namespace = rawOptions?.namespace;
            const isSubStack = Boolean(rawOptions?.stackId);
            const stackId = rawOptions?.stackId || this.createExecutionStack(namespace);
            if (!isSubStack) {
                this.logInfo('Runner', `Started sequence stack#${stackId}${namespace ? ` for namespace#${namespace}` : ''}`);
            }
            const timeoutMs = rawOptions?.timeout ?? rawOptions?.timeoutMs;
            let flowController;
            let flowTimer;
            let completedSteps = 0;
            if (timeoutMs && timeoutMs > 0) {
                flowController = new AbortController();
                flowTimer = setTimeout(() => {
                    const err = new exceptions_1.FlowTimeoutException(stackId, timeoutMs, completedSteps);
                    flowController.abort(err);
                }, timeoutMs);
            }
            const { signal: effectiveSignal, cleanup: cleanupSignals } = (0, signals_1.combineAbortSignals)([
                rawOptions?.signal,
                flowController?.signal
            ]);
            const clearFlowTimer = () => {
                if (flowTimer !== undefined) {
                    clearTimeout(flowTimer);
                }
                cleanupSignals();
            };
            if (effectiveSignal?.aborted) {
                clearFlowTimer();
                if (!isSubStack) {
                    this.deleteStack(stackId);
                }
                const reason = effectiveSignal.reason || new Error('This operation was aborted');
                const normalized = (0, exceptions_1.normalizeError)(reason, {
                    stackId,
                    namespace,
                    workflowId: rawOptions?.workflowId
                });
                normalized.stackId = stackId;
                return Promise.reject(normalized);
            }
            const effectiveOptions = Object.assign({}, rawOptions, {
                signal: effectiveSignal,
                flowSignal: flowController?.signal,
                namespace,
                stackId,
                workflowId: rawOptions?.workflowId,
                workflowVersion: rawOptions?.workflowVersion,
                durable: rawOptions?.durable,
                onStepComplete: () => {
                    completedSteps++;
                }
            });
            const newParam = this.Util.convertToContextStructure(param, this.Context, this.generateUUID, stackId, namespace);
            this.addChainToStack(stackId, newParam.$chainId());
            if (effectiveSignal) {
                const sigFn = () => effectiveSignal;
                sigFn.val = effectiveSignal;
                newParam[shared_1.SIGNAL] = sigFn;
                newParam[shared_1.SIGNAL_KEY] = sigFn;
            }
            if (namespace) {
                const nsFn = () => namespace;
                nsFn.val = namespace;
                newParam[shared_1.NAMESPACE] = nsFn;
                newParam[shared_1.NAMESPACE_KEY] = nsFn;
            }
            if (rawOptions?.durable) {
                const durFn = () => true;
                durFn.val = true;
                newParam[shared_1.IS_DURABLE] = durFn;
                newParam.isDurable = durFn;
            }
            const idempotencyStore = rawOptions?.idempotencyStore || idempotency_1.defaultIdempotencyStore;
            let idempotencyKeyScoped;
            if (rawOptions?.idempotencyKey) {
                const rawKey = typeof rawOptions.idempotencyKey === 'function'
                    ? rawOptions.idempotencyKey((0, context_1.toPOJO)(param))
                    : rawOptions.idempotencyKey;
                idempotencyKeyScoped = (0, idempotency_1.buildIdempotencyKey)(rawKey, {
                    namespace: namespace,
                    workflowVersion: rawOptions?.workflowVersion
                });
            }
            const singleChain = new this.SingleChain(this.getChain, this.Context, exports.propertyToContext, this.Reducer, this.addChainToStack, stackId, this.cache, this.logInfo, this.logError, this.executeAfter, this.executeBefore);
            const runFlowExecution = async () => {
                if (idempotencyKeyScoped) {
                    const claim = await idempotencyStore.claim(idempotencyKeyScoped, rawOptions?.idempotencyTtlMs);
                    if (claim === shared_1.Status.COMPLETED) {
                        clearFlowTimer();
                        if (!isSubStack) {
                            this.deleteStack(stackId);
                        }
                        const isPojo = effectiveOptions?.pojo === true || effectiveOptions?.mode === 'pojo';
                        const stored = await idempotencyStore.get(idempotencyKeyScoped);
                        return isPojo ? (0, context_1.toPOJO)(stored) : stored;
                    }
                    if (claim === shared_1.Status.IN_PROGRESS) {
                        clearFlowTimer();
                        if (!isSubStack) {
                            this.deleteStack(stackId);
                        }
                        throw new exceptions_1.IdempotencyConflictException(idempotencyKeyScoped, {
                            stackId,
                            namespace
                        });
                    }
                }
                const executionPromise = (chains instanceof Array)
                    ? new this.ArrayChain(this.getChain, this.generateUUID, this.Context, singleChain).start(newParam, chains, effectiveOptions)
                    : singleChain.start(newParam, chains, effectiveOptions);
                try {
                    const result = await executionPromise;
                    clearFlowTimer();
                    if (result && result.status === shared_1.Status.WAITING) {
                        this.logInfo('Runner', `Suspended stack#${stackId} (waiting for event)`);
                        return result;
                    }
                    this.logInfo('Runner', `Completed stack#${stackId}`);
                    const adapter = storage_1.defaultStorageManager.getStorageAdapter();
                    if (!isSubStack && (adapter?.saveCheckpoint || rawOptions?.checkpoint)) {
                        try {
                            storage_1.defaultStorageManager.checkpoint(stackId, { status: shared_1.Status.COMPLETED });
                            /* c8 ignore next 3 */
                        }
                        catch {
                            // ignore
                        }
                    }
                    if (!isSubStack) {
                        this.deleteStack(stackId);
                    }
                    const isPojo = effectiveOptions?.pojo === true || effectiveOptions?.mode === 'pojo';
                    const finalResult = isPojo ? (0, context_1.toPOJO)(result) : result;
                    if (idempotencyKeyScoped) {
                        try {
                            await idempotencyStore.complete(idempotencyKeyScoped, finalResult);
                            /* c8 ignore next 3 */
                        }
                        catch {
                            // ignore
                        }
                    }
                    return finalResult;
                }
                catch (error) {
                    clearFlowTimer();
                    this.logError('Runner', error);
                    if (idempotencyKeyScoped) {
                        try {
                            await idempotencyStore.fail(idempotencyKeyScoped, error);
                            /* c8 ignore next 3 */
                        }
                        catch {
                            // ignore
                        }
                    }
                    let effectiveError = error;
                    if (!isSubStack) {
                        const compensations = compensation_1.defaultCompensationManager.getCompensations(stackId);
                        if (compensations.length > 0) {
                            try {
                                await compensation_1.defaultCompensationManager.runCompensations(stackId, error, rawOptions);
                            }
                            catch (compErr) {
                                effectiveError = compErr;
                            }
                            finally {
                                compensation_1.defaultCompensationManager.clearCompensations(stackId);
                            }
                        }
                    }
                    /* c8 ignore start */
                    const adapter = storage_1.defaultStorageManager.getStorageAdapter();
                    if (!isSubStack && (adapter?.saveCheckpoint || rawOptions?.checkpoint)) {
                        try {
                            storage_1.defaultStorageManager.checkpoint(stackId, { status: shared_1.Status.FAILED });
                        }
                        catch {
                            // ignore
                        }
                    }
                    /* c8 ignore stop */
                    if (!isSubStack) {
                        this.deleteStack(stackId);
                    }
                    const normalized = (0, exceptions_1.normalizeError)(effectiveError, {
                        stackId,
                        namespace,
                        workflowId: rawOptions?.workflowId,
                        stepName: effectiveError?.func || effectiveError?.stepName,
                        phase: effectiveError?.phase || 'action'
                    });
                    normalized.stackId = stackId;
                    throw normalized;
                }
            };
            return runFlowExecution();
        }
        return undefined;
    }
}
exports.Runner = Runner;
const propertyToContext = (context, chainReturn) => {
    if (chainReturn !== undefined) {
        if (chainReturn instanceof Object) {
            for (const name in chainReturn) {
                if (Object.prototype.hasOwnProperty.call(chainReturn, name)) {
                    if ((0, shared_1.isReservedKey)(name) || (0, shared_1.isFunction)(chainReturn[name])) {
                        continue;
                    }
                    context.set(name, chainReturn[name]);
                }
            }
        }
        else {
            context.set(shared_1.VALUE, chainReturn);
        }
    }
};
exports.propertyToContext = propertyToContext;
//# sourceMappingURL=runner.js.map