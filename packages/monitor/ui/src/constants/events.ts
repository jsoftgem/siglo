import { SigloEventType } from '../types/events';

export const SIGLO_EVENT_TYPES: SigloEventType[] = [
  'flow:start',
  'flow:complete',
  'flow:error',
  'flow:suspended',
  'flow:resumed',
  'step:start',
  'step:complete',
  'step:retry',
  'step:error',
  'step:skipped',
  'context:change',
  'cache:hit',
  'cache:miss',
  'checkpoint:save'
];
