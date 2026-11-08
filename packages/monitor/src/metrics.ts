import { WorkflowExecutionEvent, WorkflowEventEmitter } from '@siglo/core';

export class PrometheusExporter {
    private activeFlows: number = 0;
    private flowsCompleted: number = 0;
    private flowsFailed: number = 0;
    private flowDurationSum: number = 0;
    private flowDurationCount: number = 0;
    private stepRetriesTotal: number = 0;
    private stepsCompleted: number = 0;
    private stepsFailed: number = 0;

    attachToEmitter(emitter: WorkflowEventEmitter): this {
        emitter.on('*', event => {
            this.handleEvent(event);
        });
        return this;
    }

    handleEvent(event: WorkflowExecutionEvent): void {
        switch (event.type) {
            case 'flow:start':
                this.activeFlows++;
                break;
            case 'flow:complete':
                if (this.activeFlows > 0) this.activeFlows--;
                if (event.status === 'COMPLETED') {
                    this.flowsCompleted++;
                } else {
                    this.flowsFailed++;
                }
                this.flowDurationSum += (event.durationMs || 0) / 1000;
                this.flowDurationCount++;
                break;
            case 'step:retry':
                this.stepRetriesTotal++;
                break;
            case 'step:complete':
                this.stepsCompleted++;
                break;
            case 'step:error':
                this.stepsFailed++;
                break;
            default:
                break;
        }
    }

    getMetricsAsText(): string {
        const lines: string[] = [
            '# HELP siglo_active_flows Current number of actively running workflows.',
            '# TYPE siglo_active_flows gauge',
            `siglo_active_flows ${this.activeFlows}`,
            '',
            '# HELP siglo_flows_total Total number of workflow executions completed or failed.',
            '# TYPE siglo_flows_total counter',
            `siglo_flows_total{status="completed"} ${this.flowsCompleted}`,
            `siglo_flows_total{status="failed"} ${this.flowsFailed}`,
            '',
            '# HELP siglo_flow_duration_seconds Total execution time of workflows in seconds.',
            '# TYPE siglo_flow_duration_seconds summary',
            `siglo_flow_duration_seconds_sum ${this.flowDurationSum.toFixed(4)}`,
            `siglo_flow_duration_seconds_count ${this.flowDurationCount}`,
            '',
            '# HELP siglo_step_retries_total Total count of step execution retries.',
            '# TYPE siglo_step_retries_total counter',
            `siglo_step_retries_total ${this.stepRetriesTotal}`,
            '',
            '# HELP siglo_steps_total Total count of step completions and failures.',
            '# TYPE siglo_steps_total counter',
            `siglo_steps_total{status="completed"} ${this.stepsCompleted}`,
            `siglo_steps_total{status="failed"} ${this.stepsFailed}`,
            '',
        ];
        return lines.join('\n');
    }
}
