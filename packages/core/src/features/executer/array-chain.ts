import {
    Status,
    isObject,
    isReservedKey,
    SKIPPED,
    SKIPPED_BRANCHES,
    BRANCH_SELECTED,
    VALUE,
    STEPS,
    HISTORY,
} from '../../shared';
import { toPOJO } from '../context/proxy';
import { WorkflowSuspendedException } from './exceptions';
import { defaultStorageManager } from '../storage';
import { defaultDurableManager } from '../durable';
import { executeComputeStepSync, isThenable } from '../step/compute';

export class ArrayChain {
    private getChain: any;
    private generateUUID: any;
    private Context: any;
    private singleChain: any;

    constructor(getChain: any, generateUUID: any, Context: any, singleChain: any) {
        this.getChain = getChain;
        this.generateUUID = generateUUID;
        this.Context = Context;
        this.singleChain = singleChain;
    }

    start(param: any, chains: any[], options?: any): Promise<any> {
        return new Promise((resolve, reject) => {
            if (options?.signal?.aborted) {
                return reject(options.signal.reason || new Error('This operation was aborted'));
            }
            const array = [...chains];
            const accumulatedParam: any = Object.assign({}, param);
            const rawPriorSteps = param?.[STEPS] || param?.$steps;
            const priorSteps = typeof rawPriorSteps === 'function' ? rawPriorSteps() : rawPriorSteps;
            const initialSteps: Record<string, any> =
                isObject(priorSteps) && !Array.isArray(priorSteps) ? Object.assign({}, priorSteps) : {};
            executeArrayChain(
                param,
                this.getChain,
                this.generateUUID,
                this.Context,
                array,
                (err, result) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(result);
                    }
                },
                accumulatedParam,
                this.singleChain,
                options,
                initialSteps,
                0,
            );
        });
    }
    /* c8 ignore next */
}

interface StepAdvanceState {
    updatedSteps: Record<string, any>;
    newAccumulated: any;
    stepsAccessor: any;
    nextParam: any;
}

function advanceStepState(
    chain: any,
    result: any,
    stepIndex: number,
    steps: Record<string, any>,
    accumulatedParam: any,
    options?: any,
): StepAdvanceState {
    if (options?.onStepComplete) {
        options.onStepComplete();
    }

    const stepName = typeof chain === 'string' ? chain : chain?.name || chain?.func || `$step_${stepIndex}`;

    const rawOutput = toPOJO(result);
    const cleanStepOutput: Record<string, any> = {};
    if (isObject(rawOutput) && !Array.isArray(rawOutput)) {
        for (const k of Object.keys(rawOutput)) {
            if (!isReservedKey(k)) {
                cleanStepOutput[k] = rawOutput[k];
            }
        }
        if (result?.[SKIPPED] === true) {
            cleanStepOutput.skipped = true;
            if (result[SKIPPED_BRANCHES]) cleanStepOutput[SKIPPED_BRANCHES] = result[SKIPPED_BRANCHES];
            if (result[BRANCH_SELECTED]) cleanStepOutput[BRANCH_SELECTED] = result[BRANCH_SELECTED];
        }
    } else if (rawOutput !== undefined) {
        cleanStepOutput[VALUE] = rawOutput;
    }

    const updatedSteps = Object.assign({}, steps, {
        [stepName]: cleanStepOutput,
        [stepIndex]: cleanStepOutput,
    });

    const isPlainObj = isObject(result) && !Array.isArray(result);
    const newAccumulated = isPlainObj
        ? Object.assign({}, accumulatedParam, result)
        : result !== undefined
          ? Object.assign({}, accumulatedParam, { [VALUE]: result })
          : Object.assign({}, accumulatedParam);

    const stepsAccessor: any = (subField?: string) => {
        if (subField !== undefined) {
            return updatedSteps[subField];
        }
        return updatedSteps;
    };
    Object.assign(stepsAccessor, updatedSteps);

    const nextParam = Object.assign({}, newAccumulated, {
        [STEPS]: stepsAccessor,
        [HISTORY]: stepsAccessor,
    });

    return { updatedSteps, newAccumulated, stepsAccessor, nextParam };
}

function finalizeArrayOutput(result: any, state: StepAdvanceState): any {
    const outputObj =
        result === undefined
            ? Object.assign({}, state.newAccumulated, {
                  [STEPS]: state.stepsAccessor,
                  [HISTORY]: state.stepsAccessor,
              })
            : isObject(result) && !Array.isArray(result)
              ? Object.assign({}, state.newAccumulated, result, {
                    [STEPS]: state.stepsAccessor,
                    [HISTORY]: state.stepsAccessor,
                })
              : result;
    return toPOJO(outputObj);
}

const executeArrayChain = (
    param: any,
    getChain: any,
    generateUUID: any,
    Context: any,
    array: any[],
    done: (err?: any, result?: any) => void,
    accumulatedParam: any,
    singleChain: any,
    options?: any,
    steps: Record<string, any> = {},
    stepIndex = 0,
): void => {
    let curParam = param;
    let curAccumulated = accumulatedParam;
    let curSteps = steps;
    let curIndex = stepIndex;

    // Fast path: execute consecutive ComputeSteps in a tight synchronous loop
    // without allocating intermediate Promises or scheduling setTimeout macrotasks.
    while (array.length > 0 && array[0]?.isCompute === true) {
        /* c8 ignore next 3 */
        if (options?.signal?.aborted) {
            return done(options.signal.reason || new Error('This operation was aborted'));
        }

        const chain = array.shift();
        let result: any;
        try {
            result = executeComputeStepSync(chain, curParam, options);
        } catch (err: any) {
            return done(err);
        }

        if (isThenable(result)) {
            (result as Promise<any>).then(
                (resolvedVal: any) => {
                    const state = advanceStepState(chain, resolvedVal, curIndex, curSteps, curAccumulated, options);
                    if (array.length > 0) {
                        executeArrayChain(
                            state.nextParam,
                            getChain,
                            generateUUID,
                            Context,
                            array,
                            done,
                            state.newAccumulated,
                            singleChain,
                            options,
                            state.updatedSteps,
                            curIndex + 1,
                        );
                    } else {
                        done(undefined, finalizeArrayOutput(resolvedVal, state));
                    }
                },
                (err: any) => done(err),
            );
            return;
        }

        const state = advanceStepState(chain, result, curIndex, curSteps, curAccumulated, options);
        curParam = state.nextParam;
        curAccumulated = state.newAccumulated;
        curSteps = state.updatedSteps;
        curIndex++;

        if (array.length === 0) {
            done(undefined, finalizeArrayOutput(result, state));
            return;
        }
    }

    /* c8 ignore next 3 */
    if (options?.signal?.aborted) {
        return done(options.signal.reason || new Error('This operation was aborted'));
    }

    const chain = array.shift();
    singleChain
        .start(curParam, chain, options)
        .then((result: any) => {
            const state = advanceStepState(chain, result, curIndex, curSteps, curAccumulated, options);

            if (array.length) {
                executeArrayChain(
                    state.nextParam,
                    getChain,
                    generateUUID,
                    Context,
                    array,
                    done,
                    state.newAccumulated,
                    singleChain,
                    options,
                    state.updatedSteps,
                    curIndex + 1,
                );
            } else {
                done(undefined, finalizeArrayOutput(result, state));
            }
        })
        .catch((err: any) => {
            if (
                (err instanceof WorkflowSuspendedException || err?.name === 'WorkflowSuspendedException') &&
                options?.durable
            ) {
                try {
                    const waitRecord = {
                        stackId: options.stackId,
                        workflowId: options.workflowId,
                        correlationKey: err.correlationKey || `wait:${options.stackId}`,
                        eventName: err.eventName || 'wait',
                        status: Status.WAITING,
                        continuationStepIndex: curIndex + 1,
                        stepId: chain?.$stepId || `$step_${curIndex}`,
                        expiresAt: err.expiresAt,
                        createdAt: Date.now(),
                        version: options.workflowVersion,
                        namespace: options.namespace,
                    };
                    defaultStorageManager.checkpoint(options.stackId, {
                        status: Status.WAITING,
                        workflowId: options.workflowId,
                        metadata: {
                            waitRecord,
                            accumulatedContext: toPOJO(curAccumulated),
                            steps: curSteps,
                        },
                    });
                    defaultDurableManager.registerWait(waitRecord);
                    const adapter = defaultStorageManager.getAdapter();
                    if (adapter && typeof (adapter as any).saveWaitRecord === 'function') {
                        const saveRes = (adapter as any).saveWaitRecord(waitRecord);
                        if (saveRes && typeof saveRes.catch === 'function') {
                            saveRes.catch(() => {});
                        }
                    }
                    /* c8 ignore next 3 */
                } catch {
                    // ignore
                }
                return done(undefined, {
                    status: Status.WAITING,
                    stackId: options.stackId,
                    stepId: chain?.$stepId || `$step_${curIndex}`,
                    correlationKey: err.correlationKey,
                    eventName: err.eventName,
                    expiresAt: err.expiresAt,
                    continuationStepIndex: curIndex + 1,
                });
            }
            done(err);
        });
};
