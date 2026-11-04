import { applyWaitEvent } from './wait-state';
import { WorkflowExecutionEvent, redactEvent, RedactionOptions, sanitizeInspection } from 'siglo';
import { WorkflowRunRecord, StepRunRecord, ContextDiffRecord } from './types';

export class WorkflowExecutionStore {
    private runs: Map<string, WorkflowRunRecord> = new Map();
    private maxRuns: number;
    private maxEventsPerRun: number;
    private maxDiffsPerRun: number;
    private redaction?: RedactionOptions;

    constructor(maxRuns: number = 1000, maxEventsPerRun: number = 500, maxDiffsPerRun: number = 200, redaction?: RedactionOptions) {
        this.redaction = redaction;
        this.maxRuns = maxRuns;
        this.maxEventsPerRun = maxEventsPerRun;
        this.maxDiffsPerRun = maxDiffsPerRun;
    }

    addEvent(event: WorkflowExecutionEvent): void {
        if (event) event = redactEvent(event, this.redaction);
        if (!event || !event.stackId) {
            return;
        }

        let run = this.runs.get(event.stackId);
        if (!run) {
            run = {
                stackId: event.stackId,
                namespace: event.namespace,
                status: 'RUNNING',
                startTime: event.timestamp || Date.now(),
                steps: {},
                context: {},
                contextDiffs: [],
                events: []
            };
            this.runs.set(event.stackId, run);

            // Evict oldest if exceeding capacity
            if (this.runs.size > this.maxRuns) {
                const oldestKey = this.runs.keys().next().value;
                if (oldestKey) {
                    this.runs.delete(oldestKey);
                }
            }
        }

        run.events.push(event);
        if (run.events.length > this.maxEventsPerRun) {
            run.events.splice(1, run.events.length - this.maxEventsPerRun);
        }

        switch (event.type) {
            case 'step:inspection':
            case 'ai:complete': {
                const data = sanitizeInspection(event.inspection);
                if (data) {
                    const step = this.getOrCreateStep(run, event.stepId, event.stepName);
                    step.inspections = [...(step.inspections || []), {
                        attempt: event.attempt || step.attempts, timestamp: event.timestamp, data
                    }].slice(-50);
                }
                break;
            }
            case 'flow:start':
                run.flowName = event.flowName || run.flowName;
                run.version = event.version || run.version;
                run.ast = event.ast || run.ast;
                run.namespace = event.namespace || run.namespace;
                run.startTime = event.timestamp || run.startTime;
                run.status = 'RUNNING';
                break;

            case 'step:start': {
                const step = this.getOrCreateStep(run, event.stepId, event.stepName);
                step.status = 'RUNNING';
                step.attempts = event.attempt || 1;
                step.startTime = event.timestamp;
                break;
            }

            case 'step:complete': {
                const step = this.getOrCreateStep(run, event.stepId, event.stepName);
                step.status = 'COMPLETED';
                step.durationMs = event.durationMs;
                step.outputSummary = event.outputSummary;
                step.endTime = event.timestamp;
                break;
            }

            case 'step:retry': {
                const step = this.getOrCreateStep(run, event.stepId, event.stepName || 'step');
                step.status = 'RETRYING';
                step.attempts = event.attempt;
                step.maxAttempts = event.maxAttempts;
                step.error = event.error;
                break;
            }

            case 'step:error': {
                const step = this.getOrCreateStep(run, event.stepId, event.stepName);
                step.status = 'FAILED';
                step.error = event.error;
                break;
            }

            case 'step:skipped': {
                const step = this.getOrCreateStep(run, event.stepId, event.stepName);
                step.status = 'SKIPPED';
                break;
            }

            case 'context:change': {
                run.context[event.field] = event.value;
                const diff: ContextDiffRecord = {
                    stepId: event.stepId,
                    field: event.field,
                    value: event.value,
                    timestamp: event.timestamp
                };
                run.contextDiffs.push(diff);
                if (run.contextDiffs.length > this.maxDiffsPerRun) {
                    run.contextDiffs.shift();
                }
                break;
            }

            case 'flow:suspended': {
                run.status = 'SUSPENDED';
                run.waitingForEvent = event.waitingForEvent;
                run.steps = applyWaitEvent(run.steps, event);
                break;
            }

            case 'flow:resumed': {
                run.status = 'RUNNING';
                run.waitingForEvent = undefined;
                run.steps = applyWaitEvent(run.steps, event);
                break;
            }

            case 'flow:complete':
                run.status = event.status;
                run.durationMs = event.durationMs;
                run.endTime = event.timestamp;
                run.error = event.error;
                break;

            default:
                break;
        }
    }

    private getOrCreateStep(run: WorkflowRunRecord, stepId: string, stepName: string): StepRunRecord {
        let step = run.steps[stepId];
        if (!step) {
            step = {
                stepId,
                stepName: stepName || stepId,
                status: 'PENDING',
                attempts: 1
            };
            run.steps[stepId] = step;
        }
        if (stepName && (!step.stepName || step.stepName === stepId)) {
            step.stepName = stepName;
        }
        return step;
    }

    getRun(stackId: string): WorkflowRunRecord | undefined {
        return this.runs.get(stackId);
    }

    listRuns(filter?: { namespace?: string; status?: string }): WorkflowRunRecord[] {
        let list = Array.from(this.runs.values());
        if (filter?.namespace) {
            list = list.filter(r => r.namespace === filter.namespace);
        }
        if (filter?.status) {
            list = list.filter(r => r.status === filter.status);
        }
        return list.sort((a, b) => b.startTime - a.startTime);
    }

    clear(): void {
        this.runs.clear();
    }
}
