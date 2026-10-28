export const SemanticAttributes = {
    WORKFLOW_NAME: 'rivulet.workflow.name',
    WORKFLOW_VERSION: 'rivulet.workflow.version',
    WORKFLOW_ID: 'rivulet.workflow.id',
    STACK_ID: 'rivulet.stack.id',
    STEP_NAME: 'rivulet.step.name',
    STEP_ID: 'rivulet.step.id',
    STEP_ATTEMPT: 'rivulet.step.attempt',
    NAMESPACE: 'rivulet.namespace',
    CACHE_HIT: 'rivulet.cache.hit',
    TIMEOUT: 'rivulet.timeout',
} as const;

export type SemanticAttributeKey = (typeof SemanticAttributes)[keyof typeof SemanticAttributes];
