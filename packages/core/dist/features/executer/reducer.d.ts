export declare class Reducer {
    private array;
    private param;
    private chain;
    private Context;
    private propertyToContext;
    private context;
    private stackId?;
    constructor(array: any[], param: any, chain: any, Context: any, propertyToContext: (context: any, chainReturn: any) => void, contextInstance?: any, stackId?: string);
    reduce(done: (err?: any, accumulated?: any) => void, accumulated?: any, index?: number): void;
}
//# sourceMappingURL=reducer.d.ts.map