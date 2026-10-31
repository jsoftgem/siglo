export type WorkflowStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SUSPENDED' | 'SKIPPED';
export type StepStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'WAITING';

export interface StepRun {
  stepId: string;
  stepName?: string;
  status: StepStatus;
  attempts?: number;
  startTime?: number;
  durationMs?: number;
  error?: string;
}

export interface ContextDiff {
  field: string;
  value: any;
  timestamp: number;
}

export interface WorkflowRun {
  stackId: string;
  flowName?: string;
  namespace?: string;
  status: WorkflowStatus;
  startTime: number;
  durationMs?: number;
  waitingForEvent?: string | null;
  steps: Record<string, StepRun>;
  context: Record<string, any>;
  contextDiffs?: ContextDiff[];
  ast?: any;
}
