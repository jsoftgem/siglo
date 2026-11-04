export class GetContext {
    private readonly context: Record<string, any>;

    constructor(stepId: string, getChainDataById: (stepId: string) => any) {
        const currentChain = getChainDataById(stepId);
        this.context = Object.assign({}, { ...currentChain });
    }

    getContext(): Record<string, any> {
        return this.context;
    }
/* c8 ignore next */
}
