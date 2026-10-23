export class GetContext {
    private readonly context: Record<string, any>;

    constructor(chainId: string, getChainDataById: (chainId: string) => any) {
        const currentChain = getChainDataById(chainId);
        this.context = Object.assign({}, { ...currentChain });
    }

    getContext(): Record<string, any> {
        return this.context;
    }
/* c8 ignore next */
}
