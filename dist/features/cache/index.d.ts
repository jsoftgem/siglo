export interface CacheOptions {
    ttl?: number;
    staleWhileRevalidate?: number;
    swr?: boolean | number;
    keySerializer?: (stepId: string, param: any, namespace?: string) => string;
    stampedeProtection?: boolean;
}
export declare function cache(stackId: string, stepId: string, param: any, cachedLast: number, action: (param: any) => any, namespace?: string, options?: CacheOptions): any;
//# sourceMappingURL=index.d.ts.map