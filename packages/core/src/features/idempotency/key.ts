export interface IdempotencyScope {
    namespace?: string;
    workflowVersion?: string | number;
    workflowId?: string;
}

export function buildIdempotencyKey(rawKey: string, scope?: IdempotencyScope): string {
    const namespace = scope?.namespace || 'default';
    const version = scope?.workflowVersion !== undefined ? String(scope.workflowVersion) : '1';
    return `ff:idemp:${namespace}:${version}:${rawKey}`;
}
