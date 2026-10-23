"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.propertyToContext = exports.Runner = void 0;
const context_1 = require("../context");
const exceptions_1 = require("./exceptions");
const signals_1 = require("./signals");
const storage_1 = require("../storage");
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
            const stackId = this.createExecutionStack(namespace);
            this.logInfo('Runner', `Started sequence stack#${stackId}${namespace ? ` for namespace#${namespace}` : ''}`);
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
                this.deleteStack(stackId);
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
                onStepComplete: () => {
                    completedSteps++;
                }
            });
            const newParam = this.Util.convertToContextStructure(param, this.Context, this.generateUUID, stackId, namespace);
            this.addChainToStack(stackId, newParam.$chainId());
            if (effectiveSignal) {
                const sigFn = () => effectiveSignal;
                sigFn.val = effectiveSignal;
                newParam.$signal = sigFn;
                newParam.signal = sigFn;
            }
            if (namespace) {
                newParam.$namespace = () => namespace;
                newParam.namespace = () => namespace;
            }
            const singleChain = new this.SingleChain(this.getChain, this.Context, exports.propertyToContext, this.Reducer, this.addChainToStack, stackId, this.cache, this.logInfo, this.logError, this.executeAfter, this.executeBefore);
            const executionPromise = (chains instanceof Array)
                ? new this.ArrayChain(this.getChain, this.generateUUID, this.Context, singleChain).start(newParam, chains, effectiveOptions)
                : singleChain.start(newParam, chains, effectiveOptions);
            return executionPromise
                .then((result) => {
                clearFlowTimer();
                return new Promise((resolve, reject) => {
                    try {
                        this.logInfo('Runner', `Completed stack#${stackId}`);
                        const adapter = storage_1.defaultStorageManager.getStorageAdapter();
                        if (adapter?.saveCheckpoint || rawOptions?.checkpoint) {
                            try {
                                storage_1.defaultStorageManager.checkpoint(stackId, { status: 'completed' });
                                /* c8 ignore next 3 */
                            }
                            catch {
                                // ignore
                            }
                        }
                        this.deleteStack(stackId);
                        const isPojo = effectiveOptions?.pojo === true || effectiveOptions?.mode === 'pojo';
                        resolve(isPojo ? (0, context_1.toPOJO)(result) : result);
                    }
                    catch (err) {
                        reject(err);
                    }
                });
            })
                .catch((error) => {
                clearFlowTimer();
                this.logError('Runner', error);
                return new Promise((_resolve, reject) => {
                    try {
                        /* c8 ignore start */
                        const adapter = storage_1.defaultStorageManager.getStorageAdapter();
                        if (adapter?.saveCheckpoint || rawOptions?.checkpoint) {
                            try {
                                storage_1.defaultStorageManager.checkpoint(stackId, { status: 'failed' });
                            }
                            catch {
                                // ignore
                            }
                        }
                        /* c8 ignore stop */
                        this.deleteStack(stackId);
                        const normalized = (0, exceptions_1.normalizeError)(error, {
                            stackId,
                            namespace,
                            workflowId: rawOptions?.workflowId,
                            stepName: error?.func || error?.stepName,
                            phase: error?.phase || 'action'
                        });
                        normalized.stackId = stackId;
                        reject(normalized);
                    }
                    catch (err) {
                        reject(err);
                    }
                });
            });
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
                    context.set(name, chainReturn[name]);
                }
            }
        }
        else {
            context.set('value', chainReturn);
        }
    }
};
exports.propertyToContext = propertyToContext;
//# sourceMappingURL=runner.js.map