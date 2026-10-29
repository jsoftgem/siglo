export const SemanticAttributes = {
    WORKFLOW_NAME: 'siglo.workflow.name',
    WORKFLOW_VERSION: 'siglo.workflow.version',
    WORKFLOW_ID: 'siglo.workflow.id',
    STACK_ID: 'siglo.stack.id',
    STEP_NAME: 'siglo.step.name',
    STEP_ID: 'siglo.step.id',
    STEP_ATTEMPT: 'siglo.step.attempt',
    NAMESPACE: 'siglo.namespace',
    CACHE_HIT: 'siglo.cache.hit',
    TIMEOUT: 'siglo.timeout',
} as const;

export type SemanticAttributeKey = (typeof SemanticAttributes)[keyof typeof SemanticAttributes];
