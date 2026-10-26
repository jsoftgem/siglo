export const SemanticAttributes = {
    WORKFLOW_NAME: 'fluid.workflow.name',
    WORKFLOW_VERSION: 'fluid.workflow.version',
    WORKFLOW_ID: 'fluid.workflow.id',
    STACK_ID: 'fluid.stack.id',
    STEP_NAME: 'fluid.step.name',
    STEP_ID: 'fluid.step.id',
    STEP_ATTEMPT: 'fluid.step.attempt',
    NAMESPACE: 'fluid.namespace',
    CACHE_HIT: 'fluid.cache.hit',
    TIMEOUT: 'fluid.timeout',
} as const;

export type SemanticAttributeKey = (typeof SemanticAttributes)[keyof typeof SemanticAttributes];
