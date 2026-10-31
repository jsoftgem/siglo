import { StorageState } from './state';

export function getChainDataById(state: StorageState, stepId: string): any {
    return state.contexts.get(stepId);
}

export function getChainContext(state: StorageState, stepId: string, field: string): any {
    if (state.plugins.getChainContext) {
        return state.plugins.getChainContext(stepId, field);
    }
    const ctx = state.contexts.get(stepId);
    if (ctx) {
        return ctx[field];
    }
    return undefined;
}

export function setGetChainContextPlugin(state: StorageState, plugin: any): void {
    if (!(plugin instanceof Function)) {
        throw new GetChainTypeException();
    }
    state.plugins.getChainContext = plugin;
}

export class GetChainTypeException extends Error {
    constructor() {
        super('Get chain plugin must be a function.');
    }
/* c8 ignore next */
}

export const getLogMonitor = (state: StorageState): any => {
    return state.config && state.config.logMonitor
        ? state.config.logMonitor
        : () => false;
};

export const getPlugins = (state: StorageState): any => {
    return state.config && state.config.plugins
        ? state.config.plugins
        : () => false;
};
