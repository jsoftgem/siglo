import { toPOJO, wrapParam } from './proxy';
export default class Context {
    $chainId: string;
    $stackId?: string;
    $namespace?: string;
    constructor($chainId: string, $stackId?: string, $namespace?: string);
    set(name: string, value: any): void;
    setStackId(stackId: string): void;
    setNamespace(namespace: string): void;
    addSpec(fieldSpec: any): void;
    getData(): Record<string, any>;
    validate(): Promise<void>;
    runSpecs(): Promise<void>;
    static createContext(chainId: string, stackId?: string, namespace?: string): Context;
}
export { Context, toPOJO, wrapParam };
//# sourceMappingURL=index.d.ts.map