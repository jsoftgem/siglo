import {
    Status,
    isReservedKey,
    isFunction,
    SIGNAL,
    SIGNAL_KEY,
    NAMESPACE,
    NAMESPACE_KEY,
    IS_DURABLE,
    VALUE,
    STEPS,
    HISTORY
} from '../../shared';
import { toPOJO } from '../context';
import { FlowTimeoutException, normalizeError, IdempotencyConflictException } from './exceptions';
import { combineAbortSignals } from './signals';
import { defaultStorageManager } from '../storage';
import { defaultCompensationManager } from '../compensation';
import { defaultIdempotencyStore, buildIdempotencyKey, isPermanentBusinessError } from '../idempotency';
import { emitMonitoringEvent } from '../events/emitter';

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
            const namespace = rawOptions?.namespace;
            const isSubStack = Boolean(rawOptions?.stackId) && !rawOptions?.isResume;
            const stackId = rawOptions?.stackId || this.createExecutionStack(namespace, rawOptions?.monitor);
            const flowStartTime = Date.now();
            if (!isSubStack) {
                this.logInfo('Runner', `Started sequence stack#${stackId}${namespace ? ` for namespace#${namespace}` : ''}`);
            }

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
                if (!isSubStack) {
                    this.deleteStack(stackId);
                }
                const reason = effectiveSignal.reason || new Error('This operation was aborted');
                const normalized = normalizeError(reason, {
                    stackId,
                    namespace,
                    workflowId: rawOptions?.workflowId
                });
                (normalized as any).stackId = stackId;
                if (!rawOptions?.isResume) {
                    emitMonitoringEvent(rawOptions, {
                        type: 'flow:start',
                        stackId,
                        flowName: rawOptions?.workflowId,
                        version: rawOptions?.workflowVersion !== undefined ? String(rawOptions.workflowVersion) : undefined,
                        ast: rawOptions?.ast,
                        timestamp: flowStartTime,
                        namespace
                    });
                }
                emitMonitoringEvent(rawOptions, {
                    type: 'flow:error',
                    stackId,
                    error: {
                        message: normalized.message,
                        stack: normalized.stack,
                        code: (normalized as any).code
                    },
                    timestamp: Date.now(),
                    namespace
                });
                emitMonitoringEvent(rawOptions, {
                    type: 'flow:complete',
                    stackId,
                    durationMs: Math.max(0, Date.now() - flowStartTime),
                    status: 'FAILED',
                    error: {
                        message: normalized.message,
                        stack: normalized.stack
                    },
                    timestamp: Date.now(),
                    namespace
                });
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
            this.addChainToStack(stackId, newParam.$stepId());
            if (param?.[STEPS] || (param as any)?.$steps) {
                const stepsFn = param[STEPS] || (param as any).$steps;
                newParam[STEPS] = stepsFn;
                newParam[HISTORY] = param[HISTORY] || (param as any).$history || stepsFn;
                newParam.$steps = stepsFn;
                newParam.$history = stepsFn;
            }
            if (effectiveSignal) {
                const sigFn = () => effectiveSignal;
                (sigFn as any).val = effectiveSignal;
                newParam[SIGNAL] = sigFn;
                newParam[SIGNAL_KEY] = sigFn;
            }
            if (namespace) {
                const nsFn = () => namespace;
                (nsFn as any).val = namespace;
                newParam[NAMESPACE] = nsFn;
                newParam[NAMESPACE_KEY] = nsFn;
            }
            if (rawOptions?.durable) {
                const durFn = () => true;
                (durFn as any).val = true;
                newParam[IS_DURABLE] = durFn;
                newParam.isDurable = durFn;
            }

            const idempotencyStore = rawOptions?.idempotencyStore || defaultIdempotencyStore;
            let idempotencyKeyScoped: string | undefined;

            if (rawOptions?.idempotencyKey) {
                const rawKey = typeof rawOptions.idempotencyKey === 'function'
                    ? rawOptions.idempotencyKey(toPOJO(param))
                    : rawOptions.idempotencyKey;
                idempotencyKeyScoped = buildIdempotencyKey(rawKey, {
                    namespace: namespace,
                    workflowVersion: rawOptions?.workflowVersion
                });
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

            const runFlowExecution = async () => {
                if (idempotencyKeyScoped) {
                    let claim = await idempotencyStore.claim(idempotencyKeyScoped, rawOptions?.idempotencyTtlMs);

                    const settleTimeoutMs = rawOptions?.settleTimeoutMs;
                    const pollIntervalMs = rawOptions?.pollIntervalMs || 50;

                    if (claim === Status.IN_PROGRESS && settleTimeoutMs && settleTimeoutMs > 0) {
                        const deadline = Date.now() + settleTimeoutMs;
                        while (Date.now() < deadline) {
                            await new Promise(res => setTimeout(res, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));

                            if (typeof idempotencyStore.getRecord === 'function') {
                                const rec = await idempotencyStore.getRecord(idempotencyKeyScoped);
                                if (rec?.status === Status.COMPLETED) {
                                    claim = Status.COMPLETED;
                                    break;
                                }
                                if (!rec) {
                                    claim = await idempotencyStore.claim(idempotencyKeyScoped, rawOptions?.idempotencyTtlMs);
                                    if (claim === Status.CLAIMED || claim === Status.COMPLETED) {
                                        break;
                                    }
                                }
                            } else {
                                const stored = await idempotencyStore.get?.(idempotencyKeyScoped);
                                if (stored !== undefined) {
                                    claim = Status.COMPLETED;
                                    break;
                                }
                            }
                        }
                    }

                    if (claim === Status.COMPLETED) {
                        clearFlowTimer();
                        if (!isSubStack) {
                            this.deleteStack(stackId);
                        }
                        const stored = typeof idempotencyStore.get === 'function'
                            ? await idempotencyStore.get(idempotencyKeyScoped)
                            /* c8 ignore start */
                            : typeof (idempotencyStore as any).getResult === 'function'
                                ? await (idempotencyStore as any).getResult(idempotencyKeyScoped)
                                : undefined;
                            /* c8 ignore stop */
                        const rawStored = toPOJO(stored);
                        /* c8 ignore next 3 */
                        if (!rawStored || typeof rawStored !== 'object' || Array.isArray(rawStored)) {
                            return rawStored;
                        }
                        return Object.freeze(Object.assign({}, rawStored, { $stackId: stackId }));
                    }
                    if (claim === Status.IN_PROGRESS) {
                        clearFlowTimer();
                        if (!isSubStack) {
                            this.deleteStack(stackId);
                        }
                        throw new IdempotencyConflictException(idempotencyKeyScoped, {
                            stackId,
                            namespace
                        });
                    }
                }

                if (!rawOptions?.isResume) {
                    emitMonitoringEvent(rawOptions, {
                        type: 'flow:start',
                    stackId,
                    flowName: rawOptions?.workflowId,
                    version: rawOptions?.workflowVersion !== undefined ? String(rawOptions.workflowVersion) : undefined,
                    ast: rawOptions?.ast,
                    timestamp: flowStartTime,
                        namespace
                    });
                }

                const executionPromise = (chains instanceof Array)
                    ? new this.ArrayChain(
                        this.getChain,
                        this.generateUUID,
                        this.Context,
                        singleChain
                    ).start(newParam, chains, effectiveOptions)
                    : singleChain.start(newParam, chains, effectiveOptions);

                try {
                    const result = await executionPromise;
                    clearFlowTimer();

                    if (result && result.status === Status.WAITING) {
                        this.logInfo('Runner', `Suspended stack#${stackId} (waiting for event)`);
                        emitMonitoringEvent(rawOptions, {
                            type: 'flow:suspended',
                            stackId,
                            stepId: result.stepId,
                            waitingForEvent: result.eventName || 'wait',
                            timeoutMs: result.expiresAt ? Math.max(0, result.expiresAt - Date.now()) : undefined,
                            expiresAt: result.expiresAt,
                            correlationKey: result.correlationKey,
                            timestamp: Date.now(),
                            namespace
                        });
                        return result;
                    }

                    this.logInfo('Runner', `Completed stack#${stackId}`);
                    const adapter = defaultStorageManager.getStorageAdapter();
                    if (!isSubStack && (adapter?.saveCheckpoint || rawOptions?.checkpoint)) {
                        try {
                            defaultStorageManager.checkpoint(stackId, { status: Status.COMPLETED });
                        /* c8 ignore next 3 */
                        } catch {
                            // ignore
                        }
                    }
                    if (!isSubStack) {
                        this.deleteStack(stackId);
                    }
                    const rawResult = toPOJO(result);
                    /* c8 ignore next 3 */
                    if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
                        return rawResult;
                    }
                    const finalResult = Object.freeze(Object.assign({}, rawResult, { $stackId: stackId }));

                    if (idempotencyKeyScoped) {
                        try {
                            await idempotencyStore.complete(idempotencyKeyScoped, finalResult);
                        /* c8 ignore next 3 */
                        } catch {
                            // ignore
                        }
                    }

                    emitMonitoringEvent(rawOptions, {
                        type: 'flow:complete',
                        stackId,
                        durationMs: Math.max(0, Date.now() - flowStartTime),
                        status: 'COMPLETED',
                        timestamp: Date.now(),
                        namespace
                    });

                    return finalResult;
                } catch (error: any) {
                    clearFlowTimer();
                    this.logError('Runner', error);

                    if (idempotencyKeyScoped) {
                        try {
                            if (isPermanentBusinessError(error, rawOptions)) {
                                await idempotencyStore.complete(idempotencyKeyScoped, {
                                    error: error.message,
                                    isPermanentError: true,
                                    name: error.name
                                });
                            } else {
                                await idempotencyStore.fail(idempotencyKeyScoped, error);
                            }
                        /* c8 ignore next 3 */
                        } catch {
                            // ignore
                        }
                    }

                    let effectiveError = error;
                    if (!isSubStack) {
                        const compensations = defaultCompensationManager.getCompensations(stackId);
                        if (compensations.length > 0) {
                            try {
                                await defaultCompensationManager.runCompensations(stackId, error, rawOptions);
                            } catch (compErr: any) {
                                effectiveError = compErr;
                            } finally {
                                defaultCompensationManager.clearCompensations(stackId);
                            }
                        }
                    }

                    /* c8 ignore start */
                    const adapter = defaultStorageManager.getStorageAdapter();
                    if (!isSubStack && (adapter?.saveCheckpoint || rawOptions?.checkpoint)) {
                        try {
                            defaultStorageManager.checkpoint(stackId, { status: Status.FAILED });
                        } catch {
                            // ignore
                        }
                    }
                    /* c8 ignore stop */
                    const normalized = normalizeError(effectiveError, {
                        stackId,
                        namespace,
                        workflowId: rawOptions?.workflowId,
                        stepName: (effectiveError as any)?.func || (effectiveError as any)?.stepName,
                        phase: (effectiveError as any)?.phase || 'action'
                    });
                    (normalized as any).stackId = stackId;

                    emitMonitoringEvent(rawOptions, {
                        type: 'flow:error',
                        stackId,
                        error: {
                            message: normalized.message,
                            stack: normalized.stack,
                            code: (normalized as any).code
                        },
                        timestamp: Date.now(),
                        namespace
                    });

                    emitMonitoringEvent(rawOptions, {
                        type: 'flow:complete',
                        stackId,
                        durationMs: Math.max(0, Date.now() - flowStartTime),
                        status: 'FAILED',
                        error: {
                            message: normalized.message,
                            stack: normalized.stack
                        },
                        timestamp: Date.now(),
                        namespace
                    });

                    // Keep the observation policy reachable until terminal telemetry
                    // has been redacted; execution still releases the stack before throw.
                    if (!isSubStack) this.deleteStack(stackId);

                    throw normalized;
                }
            };

            return runFlowExecution();
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
                    if (isReservedKey(name) || isFunction(chainReturn[name])) {
                        continue;
                    }
                    context.set(name, chainReturn[name]);
                }
            }
        } else {
            context.set(VALUE, chainReturn);
        }
    }
};
