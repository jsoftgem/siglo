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
                {},
                0,
            );
        });
    }
    /* c8 ignore next */
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
    /* c8 ignore next 3 */
    if (options?.signal?.aborted) {
        return done(options.signal.reason || new Error('This operation was aborted'));
    }

    const chain = array.shift();
    singleChain
        .start(param, chain, options)
        .then((result: any) => {
            if (options?.onStepComplete) {
                options.onStepComplete();
            }

            const stepName = typeof chain === 'string' ? chain : chain?.name || chain?.func || `$step_${stepIndex}`;

            const rawOutput = toPOJO(result);
            const cleanStepOutput: Record<string, any> = {};
            if (isObject(rawOutput)) {
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

            const newAccumulated = Object.assign({}, accumulatedParam, result);

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

            if (array.length) {
                executeArrayChain(
                    nextParam,
                    getChain,
                    generateUUID,
                    Context,
                    array,
                    done,
                    newAccumulated,
                    singleChain,
                    options,
                    updatedSteps,
                    stepIndex + 1,
                );
            } else {
                const outputObj = isObject(result)
                    ? Object.assign({}, newAccumulated, result, {
                          [STEPS]: stepsAccessor,
                          [HISTORY]: stepsAccessor,
                      })
                    : result;
                const finalResult = toPOJO(outputObj);
                done(undefined, finalResult);
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
                        continuationStepIndex: stepIndex + 1,
                        stepId: chain?.$stepId || `$step_${stepIndex}`,
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
                            accumulatedContext: toPOJO(accumulatedParam),
                            steps: steps,
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
                    stepId: chain?.$stepId || `$step_${stepIndex}`,
                    correlationKey: err.correlationKey,
                    eventName: err.eventName,
                    expiresAt: err.expiresAt,
                    continuationStepIndex: stepIndex + 1,
                });
            }
            done(err);
        });
};
