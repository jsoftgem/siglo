import type { QueryCheckpoint, StepExecution, WorkflowExecution } from '../types';

export const rawCheckpoints = new WeakMap<WorkflowExecution, QueryCheckpoint>();
export const rawOutputs = new WeakMap<StepExecution, Record<string, unknown>>();
