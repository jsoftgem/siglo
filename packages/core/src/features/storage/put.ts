import { PutChainContextMeta, StorageState } from './state';

export const putChainContext = (
    state: StorageState,
    stepId: string,
    field: string,
    value: any,
    meta?: PutChainContextMeta | string,
): void => {
    let effectiveMeta: PutChainContextMeta | undefined =
        typeof meta === 'string' ? { stackId: meta } : meta ? { ...meta } : undefined;

    if (!effectiveMeta?.stackId) {
        for (const [sId, stack] of state.stacks.entries()) {
            if (stack.chains && stack.chains.includes(stepId)) {
                effectiveMeta = Object.assign({}, effectiveMeta, {
                    stackId: sId,
                    namespace: effectiveMeta?.namespace || stack.namespace,
                });
                break;
            }
        }
    }

    if (state.plugins.putChainContext) {
        state.plugins.putChainContext(stepId, field, () => value, effectiveMeta);
    } else {
        if (field === '__proto__' || field === 'constructor' || field === 'prototype') {
            return;
        }
        let ctx = state.contexts.get(stepId);
        if (!ctx) {
            ctx = Object.create(null) as Record<string, any>;
            state.contexts.set(stepId, ctx);
        }
        const effectiveCtx = ctx!;
        const isNativeOrBinary =
            value instanceof Date ||
            value instanceof RegExp ||
            value instanceof Error ||
            (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) ||
            (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) ||
            (value !== null &&
                typeof value === 'object' &&
                (typeof (value as any)[Symbol.asyncIterator] === 'function' ||
                    typeof (value as any).pipe === 'function'));

        const frozenValue = function (subfield?: string): any {
            if (value && typeof value === 'object' && !Array.isArray(value) && !isNativeOrBinary) {
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
        const boundFn: any = frozenValue.bind(effectiveCtx);
        boundFn.val = value;
        effectiveCtx[field] = boundFn;
    }
};

export const setPutChainContextPlugin = (
    state: StorageState,
    plugin: (stepId: string, field: string, getter: () => any, meta?: PutChainContextMeta) => void,
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
