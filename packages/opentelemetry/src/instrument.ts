import { trace, SpanStatusCode, context as otelContext, createContextKey, Tracer } from '@opentelemetry/api';
import {
    Flow,
    Step,
    StorageAdapter,
    StepExecutionContext,
    StepExecutionHook,
    withStepExecutionHook,
} from '@siglo/core';
import { SemanticAttributes } from './attributes';
import { SigloTelemetryOptions } from './types';

const DEFAULT_TRACER_NAME = '@siglo/opentelemetry';
const DEFAULT_TRACER_VERSION = '1.2.1';

const STEP_INSTRUMENTED = Symbol.for('siglo.opentelemetry.step_instrumented');
const WORKFLOW_INSTRUMENTED = Symbol.for('siglo.opentelemetry.workflow_instrumented');
const STEP_OPTIONS = Symbol.for('siglo.opentelemetry.step_options');
const ACTIVE_STEP_KEY = createContextKey('siglo.opentelemetry.active_step');
const ACTIVE_WORKFLOW_KEY = createContextKey('siglo.opentelemetry.active_workflow');

/**
 * Returns an OpenTelemetry tracer based on configuration.
 */
export function getTracer(options?: SigloTelemetryOptions): Tracer {
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
export function createTelemetryStorageAdapter(options: SigloTelemetryOptions = {}): StorageAdapter {
    return {
        name: 'opentelemetry',
        onContextChange(entry: any) {
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
                        `siglo.context.${entry.field}`,
                        typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val),
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
export function instrumentStep<TStep extends Step<any, any, any>>(step: TStep, options?: SigloTelemetryOptions): TStep;
export function instrumentStep<TInput = any, TOutput = any, TName extends string = string>(
    step: Step<TInput, TOutput, TName>,
    options?: SigloTelemetryOptions,
): Step<TInput, TOutput, TName>;
export function instrumentStep(step: any, options: SigloTelemetryOptions = {}): any {
    if (!step || typeof step !== 'object') {
        return step;
    }

    (step as any)[STEP_OPTIONS] = options;

    if ((step as any)[STEP_INSTRUMENTED]) {
        return step;
    }

    const originalAction = step.action;
    if (!originalAction) {
        return step;
    }

    (step as any)[STEP_INSTRUMENTED] = true;

    step.action = (async (param: any, current: any, index?: number) => {
        const stackId = resolveValue<string>(param?.$stackId);
        const retryCount = resolveValue<number>(param?.$attempt);
        const attempt = (retryCount ?? 0) + 1;
        const stepId = step.$stepId || step.name || 'unnamed-step';

        // Duplicate-instrumentation protection:
        // If an active step span with this stepId and attempt is already active in otelContext
        // (for example, created by workflow-level execution hook), do not create a duplicate span!
        const activeStep = otelContext.active().getValue(ACTIVE_STEP_KEY) as
            { stepId: string; attempt: number } | undefined;
        if (activeStep && activeStep.stepId === stepId && activeStep.attempt === attempt) {
            return originalAction(param, current, index);
        }

        const tracer = getTracer(options);
        const isNamespaceAllowed = options.allowNamespace ?? false;
        const namespace = resolveValue<string>(param?.$namespace);
        const stepName = step.name || step.$stepId || 'unnamed-step';

        const spanName = attempt > 1 ? `step:${stepName} (retry #${attempt})` : `step:${stepName}`;
        const stepSpan = tracer.startSpan(spanName, {
            attributes: {
                [SemanticAttributes.STEP_NAME]: stepName,
                ...(step.$stepId ? { [SemanticAttributes.STEP_ID]: step.$stepId } : {}),
                [SemanticAttributes.STEP_ATTEMPT]: attempt,
                ...(stackId ? { [SemanticAttributes.STACK_ID]: stackId } : {}),
                ...(isNamespaceAllowed && namespace ? { [SemanticAttributes.NAMESPACE]: namespace } : {}),
                ...(step.timeoutMs ? { [SemanticAttributes.TIMEOUT]: step.timeoutMs } : {}),
            },
        });

        const ctx = trace.setSpan(otelContext.active(), stepSpan).setValue(ACTIVE_STEP_KEY, { stepId, attempt });

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
 * Wraps a Flow execution with end-to-end OpenTelemetry spans and instruments child steps automatically,
 * including nested branch and when combinators, concurrent operations, and sub-flows.
 */
export function instrumentWorkflow<TFlow extends Flow<any, any>>(
    workflow: TFlow,
    options?: SigloTelemetryOptions,
): TFlow;
export function instrumentWorkflow<TInput = any, TOutput = any>(
    workflow: Flow<TInput, TOutput>,
    options?: SigloTelemetryOptions,
): Flow<TInput, TOutput>;
export function instrumentWorkflow(workflow: any, options: SigloTelemetryOptions = {}): any {
    if (!workflow || typeof workflow !== 'object') {
        return workflow;
    }

    if ((workflow as any)[WORKFLOW_INSTRUMENTED]) {
        return workflow;
    }
    (workflow as any)[WORKFLOW_INSTRUMENTED] = true;

    const tracer = getTracer(options);
    const isNamespaceAllowed = options.allowNamespace ?? false;

    // Core runtime step execution hook: wraps every executed step action (including nested branch,
    // when, parallel, map, sub-flows) with an active child span.
    const stepExecutionHook: StepExecutionHook = async (stepContext: StepExecutionContext, next: () => any) => {
        const stepId = stepContext.stepId || stepContext.step?.$stepId || stepContext.stepName;
        const attempt = stepContext.attempt || 1;

        // Duplicate-instrumentation protection:
        if ((stepContext.step as any)?.[STEP_INSTRUMENTED]) {
            return next();
        }
        const activeStep = otelContext.active().getValue(ACTIVE_STEP_KEY) as
            { stepId: string; attempt: number } | undefined;
        if (activeStep && activeStep.stepId === stepId && activeStep.attempt === attempt) {
            return next();
        }

        // Check if the step had explicit instrumentStep options configured
        const stepSpecificOptions: SigloTelemetryOptions = (stepContext.step as any)?.[STEP_OPTIONS] || options;
        const stepTracer = getTracer(stepSpecificOptions);
        const stepNamespaceAllowed = stepSpecificOptions.allowNamespace ?? isNamespaceAllowed;

        const stackId = resolveValue<string>(stepContext.stackId || stepContext.param?.$stackId);
        const namespace = resolveValue<string>(stepContext.namespace || stepContext.param?.$namespace);
        const stepName = stepContext.stepName || stepContext.step?.name || stepId || 'unnamed-step';

        const spanName = attempt > 1 ? `step:${stepName} (retry #${attempt})` : `step:${stepName}`;
        const stepSpan = stepTracer.startSpan(spanName, {
            attributes: {
                [SemanticAttributes.STEP_NAME]: stepName,
                ...(stepId ? { [SemanticAttributes.STEP_ID]: stepId } : {}),
                [SemanticAttributes.STEP_ATTEMPT]: attempt,
                ...(stackId ? { [SemanticAttributes.STACK_ID]: stackId } : {}),
                ...(stepNamespaceAllowed && namespace ? { [SemanticAttributes.NAMESPACE]: namespace } : {}),
                ...(stepContext.step?.timeoutMs ? { [SemanticAttributes.TIMEOUT]: stepContext.step.timeoutMs } : {}),
            },
        });

        const ctx = trace.setSpan(otelContext.active(), stepSpan).setValue(ACTIVE_STEP_KEY, { stepId, attempt });

        return otelContext.with(ctx, async () => {
            try {
                const result = await next();
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
    };

    const originalRun = typeof workflow.run === 'function' ? workflow.run.bind(workflow) : undefined;
    const originalExecute = typeof workflow.execute === 'function' ? workflow.execute.bind(workflow) : undefined;
    const originalStart = typeof workflow.start === 'function' ? workflow.start.bind(workflow) : undefined;

    const wrapEntryPoint = (targetFn?: (...args: any[]) => any) => {
        if (!targetFn) return undefined;
        return async (input: any, execOptions: any = {}) => {
            // Execution entry-point coverage:
            // If already inside an active workflow span, delegate to original without duplicate workflow span
            const activeWf = otelContext.active().getValue(ACTIVE_WORKFLOW_KEY);
            if (activeWf) {
                return targetFn(input, execOptions);
            }

            const workflowName = options.workflowName || (workflow as any).name || 'workflow';
            const workflowVersion = options.workflowVersion || (workflow as any).workflowVersion || '1.0.0';
            const namespace = execOptions?.namespace;

            const wfSpan = tracer.startSpan(`workflow:${workflowName}`, {
                attributes: {
                    [SemanticAttributes.WORKFLOW_NAME]: workflowName,
                    [SemanticAttributes.WORKFLOW_VERSION]: String(workflowVersion),
                    ...(isNamespaceAllowed && namespace ? { [SemanticAttributes.NAMESPACE]: namespace } : {}),
                    ...(execOptions?.timeout || workflow.timeoutMs
                        ? { [SemanticAttributes.TIMEOUT]: execOptions?.timeout || workflow.timeoutMs }
                        : {}),
                },
            });

            const ctx = trace.setSpan(otelContext.active(), wfSpan).setValue(ACTIVE_WORKFLOW_KEY, wfSpan);

            return otelContext.with(ctx, async () => {
                try {
                    const effectiveExecOptions = {
                        ...execOptions,
                        stepExecutionHook,
                    };
                    const executeCall = () => targetFn(input, effectiveExecOptions);
                    const result: any = withStepExecutionHook
                        ? await withStepExecutionHook(stepExecutionHook, executeCall)
                        : await executeCall();

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
        };
    };

    if (originalRun) {
        workflow.run = wrapEntryPoint(originalRun) as any;
    }
    if (originalExecute) {
        workflow.execute = wrapEntryPoint(originalExecute) as any;
    }
    if (originalStart) {
        workflow.start = wrapEntryPoint(originalStart) as any;
    }

    return workflow;
}
