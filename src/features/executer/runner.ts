import { toPOJO } from '../context/proxy';
import { FlowTimeoutException, normalizeError } from './exceptions';
import { combineAbortSignals } from './signals';
import { defaultStorageManager } from '../storage';

export class Runner {
    private getChain: any;
    private generateUUID: any;
    private Context: any;
    private SingleChain: any;
    private ArrayChain: any;
    private Reducer: any;
    private Util: any;
    private createExecutionStack: any;
    private addChainToStack: any;
    private deleteStack: any;
    private cache: any;
    private logInfo: any;
    private logError: any;
    private executeAfter: any;
    private executeBefore: any;

    constructor(
        getChain: any,
        generateUUID: any,
        Context: any,
        SingleChain: any,
        ArrayChain: any,
        Reducer: any,
        Util: any,
        createExecutionStack: any,
        addChainToStack: any,
        deleteStack: any,
        cache: any,
        logInfo: any,
        logError: any,
        executeAfter: any,
        executeBefore: any
    ) {
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

    start(param: any, chains: any, rawOptions?: any): Promise<any> | undefined {
        if (chains) {
            const tenantId = rawOptions?.tenantId;
            const stackId = this.createExecutionStack(tenantId);
            this.logInfo('Runner', `Started sequence stack#${stackId}${tenantId ? ` for tenant#${tenantId}` : ''}`);

            const timeoutMs: number | undefined = rawOptions?.timeout ?? rawOptions?.timeoutMs;
            let flowController: AbortController | undefined;
            let flowTimer: any;
            let completedSteps = 0;

            if (timeoutMs && timeoutMs > 0) {
                flowController = new AbortController();
                flowTimer = setTimeout(() => {
                    const err = new FlowTimeoutException(
                        stackId,
                        timeoutMs,
                        completedSteps
                    );
                    flowController!.abort(err);
                }, timeoutMs);
            }

            const { signal: effectiveSignal, cleanup: cleanupSignals } = combineAbortSignals([
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
                const normalized = normalizeError(reason, {
                    stackId,
                    tenantId,
                    workflowId: rawOptions?.workflowId
                });
                (normalized as any).stackId = stackId;
                return Promise.reject(normalized);
            }

            const effectiveOptions = Object.assign({}, rawOptions, {
                signal: effectiveSignal,
                flowSignal: flowController?.signal,
                tenantId,
                onStepComplete: () => {
                    completedSteps++;
                }
            });

            const newParam = this.Util.convertToContextStructure(param, this.Context, this.generateUUID, stackId, tenantId);
            this.addChainToStack(stackId, newParam.$chainId());
            if (effectiveSignal) {
                const sigFn = () => effectiveSignal;
                (sigFn as any).val = effectiveSignal;
                newParam.$signal = sigFn;
                newParam.signal = sigFn;
            }
            if (tenantId) {
                newParam.$tenantId = () => tenantId;
                newParam.tenantId = () => tenantId;
            }

            const singleChain = new this.SingleChain(
                this.getChain,
                this.Context,
                propertyToContext,
                this.Reducer,
                this.addChainToStack,
                stackId,
                this.cache,
                this.logInfo,
                this.logError,
                this.executeAfter,
                this.executeBefore
            );
            const executionPromise = (chains instanceof Array)
                ? new this.ArrayChain(
                    this.getChain,
                    this.generateUUID,
                    this.Context,
                    singleChain
                ).start(newParam, chains, effectiveOptions)
                : singleChain.start(newParam, chains, effectiveOptions);

            return executionPromise
                .then((result: any) => {
                    clearFlowTimer();
                    return new Promise((resolve, reject) => {
                        try {
                            this.logInfo('Runner', `Completed stack#${stackId}`);
                            const adapter = defaultStorageManager.getStorageAdapter();
                            if (adapter?.saveCheckpoint || rawOptions?.checkpoint) {
                                try {
                                    defaultStorageManager.checkpoint(stackId, { status: 'completed' });
                                /* c8 ignore next 3 */
                                } catch {
                                    // ignore
                                }
                            }
                            this.deleteStack(stackId);
                            const isPojo = effectiveOptions?.pojo === true || effectiveOptions?.mode === 'pojo';
                            resolve(isPojo ? toPOJO(result) : result);
                        } catch (err) {
                            reject(err);
                        }
                    });
                })
                .catch((error: any) => {
                    clearFlowTimer();
                    this.logError('Runner', error);
                    return new Promise((_resolve, reject) => {
                        try {
                            /* c8 ignore start */
                            const adapter = defaultStorageManager.getStorageAdapter();
                            if (adapter?.saveCheckpoint || rawOptions?.checkpoint) {
                                try {
                                    defaultStorageManager.checkpoint(stackId, { status: 'failed' });
                                } catch {
                                    // ignore
                                }
                            }
                            /* c8 ignore stop */
                            this.deleteStack(stackId);
                            const normalized = normalizeError(error, {
                                stackId,
                                tenantId,
                                workflowId: rawOptions?.workflowId,
                                stepName: (error as any)?.func || (error as any)?.stepName,
                                phase: (error as any)?.phase || 'action'
                            });
                            (normalized as any).stackId = stackId;
                            reject(normalized);
                        } catch (err) {
                            reject(err);
                        }
                    });
                });
        }
        return undefined;
    }
/* c8 ignore next */
}

export const propertyToContext = (context: any, chainReturn: any): void => {
    if (chainReturn !== undefined) {
        if (chainReturn instanceof Object) {
            for (const name in chainReturn) {
                if (Object.prototype.hasOwnProperty.call(chainReturn, name)) {
                    context.set(name, chainReturn[name]);
                }
            }
        } else {
            context.set('value', chainReturn);
        }
    }
};
