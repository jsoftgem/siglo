import { StorageState } from './state';
export declare function getChainDataById(state: StorageState, chainId: string): any;
export declare function getChainContext(state: StorageState, chainId: string, field: string): any;
export declare function setGetChainContextPlugin(state: StorageState, plugin: any): void;
export declare class GetChainTypeException extends Error {
    constructor();
}
export declare const getLogMonitor: (state: StorageState) => any;
export declare const getPlugins: (state: StorageState) => any;
//# sourceMappingURL=get.d.ts.map