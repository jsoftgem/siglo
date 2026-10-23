import { PutChainContextMeta, StorageState } from './state';

export const putChainContext = (
    state: StorageState,
    chainId: string,
    field: string,
    value: any,
    meta?: PutChainContextMeta | string
): void => {
    let effectiveMeta: PutChainContextMeta | undefined =
        typeof meta === 'string' ? { stackId: meta } : (meta ? { ...meta } : undefined);

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
    } else {
        let ctx = state.contexts.get(chainId);
        if (!ctx) {
            ctx = {};
            state.contexts.set(chainId, ctx);
        }
        const frozenValue = function(subfield?: string): any {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                if (subfield !== undefined) {
                    return (value as any)[subfield];
                }
                const result: Record<string, any> = {};
                for (const k of Object.keys(value)) {
                    result[k] = (value as any)[k];
                }
                return result;
            }
            return value;
        };
        const boundFn: any = frozenValue.bind(ctx);
        boundFn.val = value;
        ctx[field] = boundFn;
    }
};

export const setPutChainContextPlugin = (
    state: StorageState,
    plugin: (stepId: string, field: string, getter: () => any, meta?: PutChainContextMeta) => void
): void => {
    if (!(plugin instanceof Function)) {
        throw new PutChainTypeException();
    }
    state.plugins.putChainContext = plugin;
};

export const setChainConfig = (state: StorageState, config: any): void => {
    state.config = Object.assign(state.config || {}, config);
};

export class PutChainTypeException extends Error {
    constructor() {
        super('Put chain plugin must be a function.');
    }
/* c8 ignore next */
}
