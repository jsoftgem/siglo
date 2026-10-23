import { PluginActionItem, PluginStore } from '../plugins/before';
export interface PluginItem {
    name: string;
    action: (context: any) => any;
    before?: string[];
    after?: string[];
}
export declare const getPlugins: (config: Record<string, any>, props: Record<string, any>, plugins?: PluginStore) => void;
export { PluginActionItem, PluginStore };
//# sourceMappingURL=getPlugins.d.ts.map