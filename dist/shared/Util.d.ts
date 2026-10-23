export declare const generateUUID: () => string;
export declare const batchIn: (object: Record<string, any>, next: (value: any, nextCb: () => void) => void, done: () => void) => void;
export declare const batch: (array: any[], next: (value: any, nextCb: () => void) => void, done: () => void, index?: number) => void;
export declare function isValidJson(json: string): boolean;
export interface PromiseCollectResult<T = any> {
    success: T[];
    error: any[];
}
export interface PromiseStepResult<T = any> {
    success?: boolean;
    failed?: boolean;
    data?: T;
    error?: any;
}
export declare class CollectPromiseResult<T = any> {
    private promises;
    constructor(promises: Promise<T>[]);
    collect(callback: (result: PromiseCollectResult<T>) => void, results?: PromiseStepResult<T>[]): void;
}
//# sourceMappingURL=Util.d.ts.map