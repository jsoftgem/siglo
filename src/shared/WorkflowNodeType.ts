/* c8 ignore start */
export const WorkflowNodeType = {
    STEP: 'step',
    SEQUENCE: 'sequence',
    PARALLEL: 'parallel',
    BRANCH: 'branch',
    WAIT: 'wait',
    MAP: 'map',
} as const;

export type WorkflowNodeType = (typeof WorkflowNodeType)[keyof typeof WorkflowNodeType];
/* c8 ignore stop */
