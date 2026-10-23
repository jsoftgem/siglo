"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetContext = void 0;
class GetContext {
    context;
    constructor(chainId, getChainDataById) {
        const currentChain = getChainDataById(chainId);
        this.context = Object.assign({}, { ...currentChain });
    }
    getContext() {
        return this.context;
    }
}
exports.GetContext = GetContext;
//# sourceMappingURL=get.js.map