export interface SpecData {
    defaultValue?: any;
    default?: any;
    require?: boolean | (() => boolean);
    requireMessage?: string;
    validator?: (currentValue?: any) => Promise<any>;
    validate?: (currentValue?: any) => Promise<any>;
    transformer?: (currentValue?: any) => Promise<any>;
    transform?: (currentValue?: any) => Promise<any>;
    translator?: (currentValue?: any, context?: any) => Promise<any>;
    translate?: (currentValue?: any, context?: any) => Promise<any>;
    schema?: any;
}
export default class Spec {
    field: string;
    actions: string[];
    data: SpecData;
    constructor(field: string);
    default(defaultValue: any): void;
    require(requireVal: boolean | (() => boolean), requireMessage?: string): void;
    validate(validator?: (currentValue?: any) => Promise<any>): void;
    transform(transformer?: (currentValue?: any) => Promise<any>): void;
    translate(translator?: (currentValue?: any, context?: any) => Promise<any>): void;
    schema(schemaObj: any): void;
    runValidation(context: any): Promise<void>;
    runRequireValidation(context: any): Promise<void>;
    runDefault(context: any): Promise<void>;
    runTransform(context: any): Promise<void>;
    runTranslate(context: any): Promise<void>;
    runSchema(context: any): Promise<void>;
}
export { Spec };
//# sourceMappingURL=index.d.ts.map