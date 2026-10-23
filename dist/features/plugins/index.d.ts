import { executeAfterPlugins } from './after';
import { executeBeforePlugins } from './before';
export declare const executeBefore: (chain: string, context: any) => Promise<Record<string, any> | void>;
export declare const executeAfter: (chain: string, context: any) => Promise<Record<string, any> | void>;
export { executeAfterPlugins, executeBeforePlugins };
//# sourceMappingURL=index.d.ts.map