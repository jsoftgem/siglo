export declare class Validators {
    private readonly chainId;
    private readonly getChainContext;
    private CollectPromiseResult;
    constructor(chainId: string, getChainContext: (chainId: string, field: string) => any, CollectPromiseResult?: any);
    addSpec(fieldSpec: any, setChainContextValue: (name: string, value: any) => void): void;
    runValidations(context: any): Promise<void>;
    runSpecs(context: any): Promise<void>;
}
//# sourceMappingURL=validators.d.ts.map