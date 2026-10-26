import {
    trace,
    SpanStatusCode,
    context as otelContext,
    Tracer
} from '@opentelemetry/api';
import {
    Flow,
    Step,
    StorageAdapter
} from 'fluid-func';
import { SemanticAttributes } from './attributes';
import { FluidTelemetryOptions } from './types';

const DEFAULT_TRACER_NAME = '@fluid-func/opentelemetry';
const DEFAULT_TRACER_VERSION = '1.0.0';

/**
 * Returns an OpenTelemetry tracer based on configuration.
 */
export function getTracer(options?: FluidTelemetryOptions): Tracer {
    return options?.tracer || trace.getTracer(options?.serviceName || DEFAULT_TRACER_NAME, DEFAULT_TRACER_VERSION);
}

function resolveValue<T>(valOrFn: any): T | undefined {
    if (typeof valOrFn === 'function') {
        try {
            return valOrFn();
        } catch {
            return undefined;
        }
    }
    return valOrFn;
}

/**
 * Creates a StorageAdapter that streams allowed, sanitized context changes to active telemetry spans.
 */
export function createTelemetryStorageAdapter(options: FluidTelemetryOptions = {}): StorageAdapter {
    return {
        name: 'opentelemetry',
        onContextChange(entry) {
            if (!options.allowContextFields || !options.allowContextFields.includes(entry.field)) {
                return; // Omit by default to protect secrets and full context
            }
            const activeSpan = trace.getActiveSpan();
            if (activeSpan) {
                let val = entry.value;
                if (options.redactHook) {
                    val = options.redactHook(entry.field, val);
                }
                if (val !== undefined) {
                    activeSpan.setAttribute(
                        `fluid.context.${entry.field}`,
                        typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val)
                    );
                }
            }
        },
    };
}

/**
 * Instruments an individual Step with an OpenTelemetry child span covering action execution,
 * attempt counting, and error recording.
 */
export function instrumentStep<TInput = any, TOutput = any>(
    step: Step<TInput, TOutput>,
    options: FluidTelemetryOptions = {}
): Step<TInput, TOutput> {
    const tracer = getTracer(options);
    const originalAction = step.action;
    if (!originalAction) {
        return step;
    }

    let invocationCount = 0;
    const isNamespaceAllowed = options.allowNamespace ?? false;

    step.action = (async (param: any, current: any, index?: number) => {
        invocationCount++;
        const stackId = resolveValue<string>(param?.$stackId);
        const retryCount = resolveValue<number>(param?.$attempt);
        const attempt = retryCount !== undefined ? retryCount + 1 : invocationCount;
        const namespace = resolveValue<string>(param?.$namespace);
        const stepName = step.name || (step as any).$stepId || 'unnamed-step';

        const spanName = attempt > 1 ? `step:${stepName} (retry #${attempt})` : `step:${stepName}`;
        const stepSpan = tracer.startSpan(spanName, {
            attributes: {
                [SemanticAttributes.STEP_NAME]: stepName,
                ...(step.$stepId ? { [SemanticAttributes.STEP_ID]: step.$stepId } : {}),
                [SemanticAttributes.STEP_ATTEMPT]: attempt,
                ...(stackId ? { [SemanticAttributes.STACK_ID]: stackId } : {}),
                ...(isNamespaceAllowed && namespace
                    ? { [SemanticAttributes.NAMESPACE]: namespace }
                    : {}),
                ...(step.timeoutMs ? { [SemanticAttributes.TIMEOUT]: step.timeoutMs } : {}),
            },
        });

        const ctx = trace.setSpan(otelContext.active(), stepSpan);

        return otelContext.with(ctx, async () => {
            try {
                const result = await originalAction(param, current, index);
                stepSpan.setStatus({ code: SpanStatusCode.OK });
                return result;
            } catch (err: any) {
                stepSpan.recordException(err);
                stepSpan.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: err?.message || 'Step execution failed',
                });
                throw err;
            } finally {
                stepSpan.end();
            }
        });
    }) as any;

    return step;
}

/**
 * Wraps a Flow execution with end-to-end OpenTelemetry spans and instruments child steps.
 */
export function instrumentWorkflow<TInput = any, TOutput = any>(
    workflow: Flow<TInput, TOutput>,
    options: FluidTelemetryOptions = {}
): Flow<TInput, TOutput> {
    const tracer = getTracer(options);

    // Instrument individual child steps if available
    if (Array.isArray(workflow.steps)) {
        for (const step of workflow.steps) {
            if (step && typeof step === 'object' && 'action' in step) {
                instrumentStep(step as Step, options);
            }
        }
    }

    const originalRun = workflow.run.bind(workflow);
    const isNamespaceAllowed = options.allowNamespace ?? false;

    workflow.run = (async (input: TInput, execOptions: any = {}) => {
        const workflowName = options.workflowName || (workflow as any).name || 'workflow';
        const workflowVersion = options.workflowVersion || (workflow as any).workflowVersion || '1.0.0';
        const namespace = execOptions?.namespace;

        const wfSpan = tracer.startSpan(`workflow:${workflowName}`, {
            attributes: {
                [SemanticAttributes.WORKFLOW_NAME]: workflowName,
                [SemanticAttributes.WORKFLOW_VERSION]: String(workflowVersion),
                ...(isNamespaceAllowed && namespace
                    ? { [SemanticAttributes.NAMESPACE]: namespace }
                    : {}),
                ...(execOptions?.timeout || workflow.timeoutMs
                    ? { [SemanticAttributes.TIMEOUT]: execOptions?.timeout || workflow.timeoutMs }
                    : {}),
            },
        });

        const ctx = trace.setSpan(otelContext.active(), wfSpan);

        return otelContext.with(ctx, async () => {
            try {
                const result: any = await originalRun(input, execOptions);
                const stackId = resolveValue<string>(result?.$stackId);
                if (stackId) {
                    wfSpan.setAttribute(SemanticAttributes.STACK_ID, stackId);
                }
                wfSpan.setStatus({ code: SpanStatusCode.OK });
                return result;
            } catch (err: any) {
                wfSpan.recordException(err);
                wfSpan.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: err?.message || 'Workflow execution failed',
                });
                throw err;
            } finally {
                wfSpan.end();
            }
        });
    }) as any;

    return workflow;
}
