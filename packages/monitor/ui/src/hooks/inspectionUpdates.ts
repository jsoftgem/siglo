import type { MonitoringEvent, StepRun } from '../types';

export function appendInspection(step: StepRun, event: MonitoringEvent): StepRun {
  if (!event.inspection || !event.stepId || event.stepId !== step.stepId) return step;
  return { ...step, inspections: [...(step.inspections || []), {
    attempt: event.attempt || step.attempts || 1,
    timestamp: event.timestamp || Date.now(), data: event.inspection
  }].slice(-50) };
}
