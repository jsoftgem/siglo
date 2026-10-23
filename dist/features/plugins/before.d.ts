export interface PluginActionItem {
    name: string;
    action: (context: any) => any;
}
export type PluginStore = Record<string, PluginActionItem[]>;
export declare const executeBeforePlugins: (chain: string, context: any, plugins?: PluginStore) => Promise<Record<string, any> | void>;
//# sourceMappingURL=before.d.ts.map