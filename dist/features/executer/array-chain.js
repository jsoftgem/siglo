"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArrayChain = void 0;
const proxy_1 = require("../context/proxy");
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
        if (rawOutput && typeof rawOutput === 'object') {
            for (const k of Object.keys(rawOutput)) {
                if (k !== '$chainId' && k !== '$stackId' && k !== '$tenantId' && k !== '$$$validators' && k !== '$steps' && k !== '$history') {
                    cleanStepOutput[k] = rawOutput[k];
                }
            }
        }
        else if (rawOutput !== undefined) {
            cleanStepOutput.value = rawOutput;
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
            $steps: stepsAccessor,
            $history: stepsAccessor
        });
        if (array.length) {
            executeArrayChain(nextParam, getChain, generateUUID, Context, array, done, newAccumulated, singleChain, options, updatedSteps, stepIndex + 1);
        }
        else {
            const outputObj = (typeof result === 'object' && result !== null)
                ? Object.assign({}, newAccumulated, result, {
                    $steps: stepsAccessor,
                    $history: stepsAccessor
                })
                : result;
            const isPojo = options?.pojo === true || options?.mode === 'pojo';
            const finalResult = isPojo ? (0, proxy_1.toPOJO)(outputObj) : (0, proxy_1.wrapParam)(outputObj);
            done(undefined, finalResult);
        }
    })
        .catch((err) => {
        done(err);
    });
};
//# sourceMappingURL=array-chain.js.map