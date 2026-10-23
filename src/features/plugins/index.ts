import { executeAfterPlugins } from './after';
import { executeBeforePlugins } from './before';
import { getPlugins } from '../storage';

export const executeBefore = (chain: string, context: any): Promise<Record<string, any> | void> => {
    return executeBeforePlugins(chain, context, getPlugins());
};

export const executeAfter = (chain: string, context: any): Promise<Record<string, any> | void> => {
    return executeAfterPlugins(chain, context, getPlugins());
};

export { executeAfterPlugins, executeBeforePlugins };
