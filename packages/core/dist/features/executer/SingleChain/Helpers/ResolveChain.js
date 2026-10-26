"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const shared_1 = require("../../../../shared");
const SetResolvedContexts_1 = __importDefault(require("./SetResolvedContexts"));
const proxy_1 = require("../../../context/proxy");
class ResolveChain {
    constructor(resolve, context, chain, logInfo, executeAfter, Context, reject, options) {
        logInfo('SingleChain', {
            chain,
            message: 'Completed',
            resolvedContext: context
        });
        const isPojo = options?.pojo === true || options?.mode === 'pojo';
        const resolveFinal = (ctx) => {
            if (!ctx) {
                resolve(ctx);
                return;
            }
            if (!ctx[shared_1.STEPS]) {
                const rawOutput = (0, proxy_1.toPOJO)(ctx);
                const cleanOutput = {};
                for (const k of Object.keys(rawOutput)) {
                    if (!(0, shared_1.isReservedKey)(k)) {
                        cleanOutput[k] = rawOutput[k];
                    }
                }
                const stepName = typeof chain === 'string'
                    ? chain
                    : (chain && (chain.func || chain.name)) || 'step_0';
                const singleSteps = {
                    [stepName]: cleanOutput,
                    [0]: cleanOutput
                };
                const stepsAccessor = (subField) => subField !== undefined ? singleSteps[subField] : singleSteps;
                Object.assign(stepsAccessor, singleSteps);
                ctx[shared_1.STEPS] = stepsAccessor;
                ctx[shared_1.HISTORY] = stepsAccessor;
            }
            resolve(isPojo ? (0, proxy_1.toPOJO)(ctx) : (0, proxy_1.wrapParam)(ctx));
        };
        if (executeAfter) {
            executeAfter(chain, context).then((resolvedPluginData) => {
                if (resolvedPluginData) {
                    const stackId = typeof context?.[shared_1.STACK_ID] === 'function' ? context[shared_1.STACK_ID]() : undefined;
                    const newContext = new Context('_after_temp', stackId);
                    new SetResolvedContexts_1.default(resolvedPluginData, newContext);
                    context = Object.assign(context, newContext.getData());
                }
                resolveFinal(context);
            }).catch((err) => {
                if (reject) {
                    reject(err);
                }
                else {
                    logInfo('SingleChain', { error: err });
                }
            });
        }
        else {
            resolveFinal(context);
        }
    }
}
exports.default = ResolveChain;
//# sourceMappingURL=ResolveChain.js.map