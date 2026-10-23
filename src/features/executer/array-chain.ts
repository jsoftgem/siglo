import { toPOJO, wrapParam } from '../context/proxy';

export class ArrayChain {
    private getChain: any;
    private generateUUID: any;
    private Context: any;
    private singleChain: any;

    constructor(
        getChain: any,
        generateUUID: any,
        Context: any,
        singleChain: any
    ) {
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
                0
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
    stepIndex = 0
): void => {
    /* c8 ignore next 3 */
    if (options?.signal?.aborted) {
        return done(options.signal.reason || new Error('This operation was aborted'));
    }

    const chain = array.shift();
    singleChain.start(param, chain, options)
        .then((result: any) => {
            if (options?.onStepComplete) {
                options.onStepComplete();
            }

            const stepName = (typeof chain === 'string')
                ? chain
                : (chain?.name || chain?.func || `$step_${stepIndex}`);

            const rawOutput = toPOJO(result);
            const cleanStepOutput: Record<string, any> = {};
            if (rawOutput && typeof rawOutput === 'object') {
                for (const k of Object.keys(rawOutput)) {
                    if (k !== '$chainId' && k !== '$stackId' && k !== '$namespace' && k !== '$$$validators' && k !== '$steps' && k !== '$history') {
                        cleanStepOutput[k] = rawOutput[k];
                    }
                }
            } else if (rawOutput !== undefined) {
                cleanStepOutput.value = rawOutput;
            }

            const updatedSteps = Object.assign({}, steps, {
                [stepName]: cleanStepOutput,
                [stepIndex]: cleanStepOutput
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
                $steps: stepsAccessor,
                $history: stepsAccessor
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
                    stepIndex + 1
                );
            } else {
                const outputObj = (typeof result === 'object' && result !== null)
                    ? Object.assign({}, newAccumulated, result, {
                        $steps: stepsAccessor,
                        $history: stepsAccessor
                    })
                    : result;
                const isPojo = options?.pojo === true || options?.mode === 'pojo';
                const finalResult = isPojo ? toPOJO(outputObj) : wrapParam(outputObj);
                done(undefined, finalResult);
            }
        })
        .catch((err: any) => {
            done(err);
        });
};
