"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PutChainTypeException = exports.setChainConfig = exports.setPutChainContextPlugin = exports.putChainContext = void 0;
const putChainContext = (state, chainId, field, value, meta) => {
    let effectiveMeta = typeof meta === 'string' ? { stackId: meta } : (meta ? { ...meta } : undefined);
    if (!effectiveMeta?.stackId) {
        for (const [sId, stack] of state.stacks.entries()) {
            if (stack.chains && stack.chains.includes(chainId)) {
                effectiveMeta = Object.assign({}, effectiveMeta, {
                    stackId: sId,
                    tenantId: effectiveMeta?.tenantId || stack.tenantId
                });
                break;
            }
        }
    }
    if (state.plugins.putChainContext) {
        state.plugins.putChainContext(chainId, field, () => value, effectiveMeta);
    }
    else {
        let ctx = state.contexts.get(chainId);
        if (!ctx) {
            ctx = {};
            state.contexts.set(chainId, ctx);
        }
        const frozenValue = function (subfield) {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                if (subfield !== undefined) {
                    return value[subfield];
                }
                const result = {};
                for (const k of Object.keys(value)) {
                    result[k] = value[k];
                }
                return result;
            }
            return value;
        };
        const boundFn = frozenValue.bind(ctx);
        boundFn.val = value;
        ctx[field] = boundFn;
    }
};
exports.putChainContext = putChainContext;
const setPutChainContextPlugin = (state, plugin) => {
    if (!(plugin instanceof Function)) {
        throw new PutChainTypeException();
    }
    state.plugins.putChainContext = plugin;
};
exports.setPutChainContextPlugin = setPutChainContextPlugin;
const setChainConfig = (state, config) => {
    state.config = Object.assign(state.config || {}, config);
};
exports.setChainConfig = setChainConfig;
class PutChainTypeException extends Error {
    constructor() {
        super('Put chain plugin must be a function.');
    }
}
exports.PutChainTypeException = PutChainTypeException;
//# sourceMappingURL=put.js.map