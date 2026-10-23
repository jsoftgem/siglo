export interface PluginActionItem {
    name: string;
    action: (context: any) => any;
}

export type PluginStore = Record<string, PluginActionItem[]>;

const executeActions = (
    context: any,
    plugins: PluginActionItem[],
    resolvedContext: Record<string, any> = {},
    index = 0,
    done: (err?: any, resolvedContext?: Record<string, any>) => void
): void => {
    if (index < plugins.length) {
        try {
            const plugin = plugins[index];
            const action = plugin.action(context);
            if (action instanceof Promise) {
                action.then((data: any) => {
                    resolvedContext = { ...resolvedContext };
                    resolvedContext[plugin.name] = data;
                    index++;
                    executeActions(context, plugins, resolvedContext, index, done);
                }).catch((err: any) => { done(err); });
            } else {
                if (action !== undefined) {
                    resolvedContext = { ...resolvedContext };
                    resolvedContext[plugin.name] = action;
                }
                index++;
                executeActions(context, plugins, resolvedContext, index, done);
            }
        } catch (err) {
            done(err);
        }
    } else {
        done(undefined, resolvedContext);
    }
};

export const executeBeforePlugins = (
    chain: string,
    context: any,
    plugins?: PluginStore
): Promise<Record<string, any> | void> => {
    const beforeChain = `before_${chain}`;
    const chainPlugins = plugins ? plugins[beforeChain] : undefined;
    return new Promise((resolve, reject) => {
        if (chainPlugins) {
            executeActions(context, chainPlugins, {}, 0, (err, resolvedContext) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(resolvedContext);
                }
            });
        } else {
            resolve();
        }
    });
};
