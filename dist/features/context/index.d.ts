import { toPOJO, wrapParam } from './proxy';
export default class Context {
    $chainId: string;
    $stackId?: string;
    $tenantId?: string;
    constructor($chainId: string, $stackId?: string, $tenantId?: string);
    set(name: string, value: any): void;
    setStackId(stackId: string): void;
    setTenantId(tenantId: string): void;
    addSpec(fieldSpec: any): void;
    getData(): Record<string, any>;
    validate(): Promise<void>;
    runSpecs(): Promise<void>;
    static createContext(chainId: string, stackId?: string, tenantId?: string): Context;
}
export { Context, toPOJO, wrapParam };
//# sourceMappingURL=index.d.ts.map