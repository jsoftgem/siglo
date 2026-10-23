export interface CacheOptions {
    ttl?: number;
    staleWhileRevalidate?: number;
    swr?: boolean | number;
    keySerializer?: (stepId: string, param: any, tenantId?: string) => string;
    stampedeProtection?: boolean;
}
export declare function cache(stackId: string, stepId: string, param: any, cachedLast: number, action: (param: any) => any, tenantId?: string, options?: CacheOptions): any;
//# sourceMappingURL=index.d.ts.map