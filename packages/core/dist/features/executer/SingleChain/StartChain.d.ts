export default class StartChain {
    start: (initialParam: any, chains: any, options?: any) => Promise<any>;
    constructor(getChain: (name: any) => any, Context: any, propertyToContext: (context: any, chainReturn: any) => void, Reducer: any, addChainToStack: (stackId: string, chainId: string) => void, stackId: string, cache: any, logInfo: (source: string, message: any) => void, logError: (source: string, error: any) => void, executeAfter: (chain: string, context: any) => Promise<any>, executeBefore: (chain: string, context: any) => Promise<any>);
}
//# sourceMappingURL=StartChain.d.ts.map