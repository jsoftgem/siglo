export declare class Runner {
    private getChain;
    private generateUUID;
    private Context;
    private SingleChain;
    private ArrayChain;
    private Reducer;
    private Util;
    private createExecutionStack;
    private addChainToStack;
    private deleteStack;
    private cache;
    private logInfo;
    private logError;
    private executeAfter;
    private executeBefore;
    constructor(getChain: any, generateUUID: any, Context: any, SingleChain: any, ArrayChain: any, Reducer: any, Util: any, createExecutionStack: any, addChainToStack: any, deleteStack: any, cache: any, logInfo: any, logError: any, executeAfter: any, executeBefore: any);
    start(param: any, chains: any, rawOptions?: any): Promise<any> | undefined;
}
export declare const propertyToContext: (context: any, chainReturn: any) => void;
//# sourceMappingURL=runner.d.ts.map