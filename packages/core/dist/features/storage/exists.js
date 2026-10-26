"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exists = void 0;
/**
 * Checks the name if already exists in the storage
 * @deprecated Not needed with direct step instances.
 * @param state
 * @param chainName
 */
const exists = (state, chainName) => {
    return state.chains.has(chainName);
};
exports.exists = exists;
//# sourceMappingURL=exists.js.map