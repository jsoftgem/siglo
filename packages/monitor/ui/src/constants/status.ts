import { WorkflowStatus } from '../types/workflow';

export const WORKFLOW_STATUS_LIST: Array<WorkflowStatus | 'ALL'> = [
    'ALL',
    'RUNNING',
    'SUSPENDED',
    'FAILED',
    'COMPLETED',
];
