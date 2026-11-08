import { PluginActionItem, PluginStore } from '../plugins/before';

export interface PluginItem {
    name: string;
    action: (context: any) => any;
    before?: string[];
    after?: string[];
}

export const getPlugins = (
    config: Record<string, any>,
    props: Record<string, any>,
    plugins: PluginStore = {},
): void => {
    if (props.plugins) {
        if (props.plugins instanceof Array) {
            props.plugins.forEach((plugin: PluginItem) => {
                if (!plugin.name) {
                    throw new Error('plugin must have .name');
                }
                if (!plugin.action) {
                    throw new Error('plugin must have .action function');
                }
                if (plugin.before || plugin.after) {
                    addPluginBefore(plugin.before, plugin.action, plugin.name, plugins);
                    addPluginAfter(plugin.after, plugin.action, plugin.name, plugins);
                } else {
                    throw new Error('plugin must have alteast one .before or .after array');
                }
            });
        } else {
            throw new Error('plugins must be array');
        }
    }
    config.plugins = plugins;
};

function addPluginBefore(chains: any, action: any, name: string, plugins: PluginStore): void {
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
        } else {
            throw new Error('plugin.before must be array');
        }
    }
}

function addPluginAfter(chains: any, action: any, name: string, plugins: PluginStore): void {
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
        } else {
            throw new Error('plugin.after must be array');
        }
    }
}

export { PluginActionItem, PluginStore };
