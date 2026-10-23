"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPlugins = void 0;
const getPlugins = (config, props, plugins = {}) => {
    if (props.plugins) {
        if (props.plugins instanceof Array) {
            props.plugins.forEach((plugin) => {
                if (!plugin.name) {
                    throw new Error('plugin must have .name');
                }
                if (!plugin.action) {
                    throw new Error('plugin must have .action function');
                }
                if (plugin.before || plugin.after) {
                    addPluginBefore(plugin.before, plugin.action, plugin.name, plugins);
                    addPluginAfter(plugin.after, plugin.action, plugin.name, plugins);
                }
                else {
                    throw new Error('plugin must have alteast one .before or .after array');
                }
            });
        }
        else {
            throw new Error('plugins must be array');
        }
    }
    config.plugins = plugins;
};
exports.getPlugins = getPlugins;
function addPluginBefore(chains, action, name, plugins) {
    if (chains) {
        if (chains instanceof Array) {
            chains.forEach(_chain => {
                const beforeChain = `before_${_chain}`;
                if (!plugins[beforeChain]) {
                    plugins[beforeChain] = [];
                }
                const chain = plugins[beforeChain];
                chain.push({ name, action });
            });
        }
        else {
            throw new Error('plugin.before must be array');
        }
    }
}
function addPluginAfter(chains, action, name, plugins) {
    if (chains) {
        if (chains instanceof Array) {
            chains.forEach(_chain => {
                const afterChain = `after_${_chain}`;
                if (!plugins[afterChain]) {
                    plugins[afterChain] = [];
                }
                const chain = plugins[afterChain];
                chain.push({ name, action });
            });
        }
        else {
            throw new Error('plugin.after must be array');
        }
    }
}
//# sourceMappingURL=getPlugins.js.map