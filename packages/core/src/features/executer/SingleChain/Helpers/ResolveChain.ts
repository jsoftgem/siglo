import { STEPS, HISTORY, STACK_ID, isReservedKey } from '../../../../shared';
import SetResolvedContexts from './SetResolvedContexts';
import { toPOJO } from '../../../context/proxy';

export default class ResolveChain {
    constructor(
        resolve: (value: any) => void,
        context: any,
        chain: any,
        logInfo: (source: string, message: any) => void,
        executeAfter?: (chain: string, context: any) => Promise<any>,
        Context?: any,
        reject?: (reason?: any) => void,
        _options?: any,
    ) {
        logInfo('SingleChain', {
            chain,
            message: 'Completed',
            resolvedContext: context,
        });
        const resolveFinal = (ctx: any) => {
            if (!ctx) {
                resolve(ctx);
                return;
            }
            if (!ctx[STEPS]) {
                const rawOutput = toPOJO(ctx);
                const cleanOutput: Record<string, any> = {};
                for (const k of Object.keys(rawOutput)) {
                    if (!isReservedKey(k)) {
                        cleanOutput[k] = rawOutput[k];
                    }
                }
                const stepName = typeof chain === 'string' ? chain : (chain && (chain.func || chain.name)) || 'step_0';
                const singleSteps: Record<string, any> = {
                    [stepName]: cleanOutput,
                    [0]: cleanOutput,
                };
                const stepsAccessor: any = (subField?: string) =>
                    subField !== undefined ? singleSteps[subField] : singleSteps;
                Object.assign(stepsAccessor, singleSteps);
                ctx = Object.assign({}, ctx);
                ctx[STEPS] = stepsAccessor;
                ctx[HISTORY] = stepsAccessor;
            }
            resolve(toPOJO(ctx));
        };

        if (executeAfter) {
            executeAfter(chain, context)
                .then((resolvedPluginData: any) => {
                    if (resolvedPluginData) {
                        const stackId = typeof context?.[STACK_ID] === 'function' ? context[STACK_ID]() : undefined;
                        const newContext = new Context('_after_temp', stackId);
                        new SetResolvedContexts(resolvedPluginData, newContext);
                        context = Object.assign(context, newContext.getData());
                    }
                    resolveFinal(context);
                })
                .catch((err: any) => {
                    if (reject) {
                        reject(err);
                    } else {
                        logInfo('SingleChain', { error: err });
                    }
                });
        } else {
            resolveFinal(context);
        }
    }
    /* c8 ignore next */
}
