"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArrayChain = void 0;
const shared_1 = require("../../shared");
const proxy_1 = require("../context/proxy");
const exceptions_1 = require("./exceptions");
const storage_1 = require("../storage");
const durable_1 = require("../durable");
class ArrayChain {
    getChain;
    generateUUID;
    Context;
    singleChain;
    constructor(getChain, generateUUID, Context, singleChain) {
        this.getChain = getChain;
        this.generateUUID = generateUUID;
        this.Context = Context;
        this.singleChain = singleChain;
    }
    start(param, chains, options) {
        return new Promise((resolve, reject) => {
            if (options?.signal?.aborted) {
                return reject(options.signal.reason || new Error('This operation was aborted'));
            }
            const array = [...chains];
            const accumulatedParam = Object.assign({}, param);
            executeArrayChain(param, this.getChain, this.generateUUID, this.Context, array, (err, result) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(result);
                }
            }, accumulatedParam, this.singleChain, options, {}, 0);
        });
    }
}
exports.ArrayChain = ArrayChain;
const executeArrayChain = (param, getChain, generateUUID, Context, array, done, accumulatedParam, singleChain, options, steps = {}, stepIndex = 0) => {
    /* c8 ignore next 3 */
    if (options?.signal?.aborted) {
        return done(options.signal.reason || new Error('This operation was aborted'));
    }
    const chain = array.shift();
    singleChain.start(param, chain, options)
        .then((result) => {
        if (options?.onStepComplete) {
            options.onStepComplete();
        }
        const stepName = (typeof chain === 'string')
            ? chain
            : (chain?.name || chain?.func || `$step_${stepIndex}`);
        const rawOutput = (0, proxy_1.toPOJO)(result);
        const cleanStepOutput = {};
        if ((0, shared_1.isObject)(rawOutput)) {
            for (const k of Object.keys(rawOutput)) {
                if (!(0, shared_1.isReservedKey)(k)) {
                    cleanStepOutput[k] = rawOutput[k];
                }
            }
            if (result?.[shared_1.SKIPPED] === true) {
                cleanStepOutput.skipped = true;
                if (result[shared_1.SKIPPED_BRANCHES])
                    cleanStepOutput[shared_1.SKIPPED_BRANCHES] = result[shared_1.SKIPPED_BRANCHES];
                if (result[shared_1.BRANCH_SELECTED])
                    cleanStepOutput[shared_1.BRANCH_SELECTED] = result[shared_1.BRANCH_SELECTED];
            }
        }
        else if (rawOutput !== undefined) {
            cleanStepOutput[shared_1.VALUE] = rawOutput;
        }
        const updatedSteps = Object.assign({}, steps, {
            [stepName]: cleanStepOutput,
            [stepIndex]: cleanStepOutput
        });
        const newAccumulated = Object.assign({}, accumulatedParam, result);
        const stepsAccessor = (subField) => {
            if (subField !== undefined) {
                return updatedSteps[subField];
            }
            return updatedSteps;
        };
        Object.assign(stepsAccessor, updatedSteps);
        const nextParam = Object.assign({}, newAccumulated, {
            [shared_1.STEPS]: stepsAccessor,
            [shared_1.HISTORY]: stepsAccessor
        });
        if (array.length) {
            executeArrayChain(nextParam, getChain, generateUUID, Context, array, done, newAccumulated, singleChain, options, updatedSteps, stepIndex + 1);
        }
        else {
            const outputObj = (0, shared_1.isObject)(result)
                ? Object.assign({}, newAccumulated, result, {
                    [shared_1.STEPS]: stepsAccessor,
                    [shared_1.HISTORY]: stepsAccessor
                })
                : result;
            const isPojo = options?.pojo === true || options?.mode === 'pojo';
            const finalResult = isPojo ? (0, proxy_1.toPOJO)(outputObj) : (0, proxy_1.wrapParam)(outputObj);
            done(undefined, finalResult);
        }
    })
        .catch((err) => {
        if ((err instanceof exceptions_1.WorkflowSuspendedException || err?.name === 'WorkflowSuspendedException') && options?.durable) {
            try {
                storage_1.defaultStorageManager.checkpoint(options.stackId, {
                    status: shared_1.Status.WAITING,
                    workflowId: options.workflowId
                });
                durable_1.defaultDurableManager.registerWait({
                    stackId: options.stackId,
                    workflowId: options.workflowId,
                    correlationKey: err.correlationKey || `wait:${options.stackId}`,
                    eventName: err.eventName || 'wait',
                    status: shared_1.Status.WAITING,
                    continuationStepIndex: stepIndex + 1,
                    stepId: chain?.$stepId || chain?.$chainId || `$step_${stepIndex}`,
                    expiresAt: err.expiresAt,
                    createdAt: Date.now(),
                    version: options.workflowVersion
                });
                /* c8 ignore next 3 */
            }
            catch {
                // ignore
            }
            return done(undefined, {
                status: shared_1.Status.WAITING,
                stackId: options.stackId,
                correlationKey: err.correlationKey,
                eventName: err.eventName,
                expiresAt: err.expiresAt,
                continuationStepIndex: stepIndex + 1
            });
        }
        done(err);
    });
};
//# sourceMappingURL=array-chain.js.map