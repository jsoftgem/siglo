import { PutChainContextMeta, StorageState } from './state';
export declare const putChainContext: (state: StorageState, chainId: string, field: string, value: any, meta?: PutChainContextMeta | string) => void;
export declare const setPutChainContextPlugin: (state: StorageState, plugin: (stepId: string, field: string, getter: () => any, meta?: PutChainContextMeta) => void) => void;
export declare const setChainConfig: (state: StorageState, config: any) => void;
export declare class PutChainTypeException extends Error {
    constructor();
}
//# sourceMappingURL=put.d.ts.map