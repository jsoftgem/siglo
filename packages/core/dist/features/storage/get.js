"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPlugins = exports.getLogMonitor = exports.GetChainTypeException = void 0;
exports.getChainDataById = getChainDataById;
exports.getChainContext = getChainContext;
exports.setGetChainContextPlugin = setGetChainContextPlugin;
function getChainDataById(state, chainId) {
    return state.contexts.get(chainId);
}
function getChainContext(state, chainId, field) {
    if (state.plugins.getChainContext) {
        return state.plugins.getChainContext(chainId, field);
    }
    const ctx = state.contexts.get(chainId);
    if (ctx) {
        return ctx[field];
    }
    return undefined;
}
function setGetChainContextPlugin(state, plugin) {
    if (!(plugin instanceof Function)) {
        throw new GetChainTypeException();
    }
    state.plugins.getChainContext = plugin;
}
class GetChainTypeException extends Error {
    constructor() {
        super('Get chain plugin must be a function.');
    }
}
exports.GetChainTypeException = GetChainTypeException;
const getLogMonitor = (state) => {
    return state.config && state.config.logMonitor
        ? state.config.logMonitor
        : () => false;
};
exports.getLogMonitor = getLogMonitor;
const getPlugins = (state) => {
    return state.config && state.config.plugins
        ? state.config.plugins
        : undefined;
};
exports.getPlugins = getPlugins;
//# sourceMappingURL=get.js.map