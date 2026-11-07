import { SpanStatusCode, Span, Tracer, SpanOptions, SpanContext, TraceFlags } from '@opentelemetry/api';
import { Step, flow, parallel, race, when } from '@siglo/core';
import {
    SemanticAttributes,
    instrumentWorkflow,
    instrumentStep,
    injectTraceContext,
    extractTraceContext,
    getTraceHeaders
} from '@siglo/opentelemetry';
import { RandomSource } from '../engine/property-generators';
import { InvariantEvaluator } from '../engine/invariant-evaluator';
import { CharterResult } from './combinators.explore';

class ExploratoryMockSpan implements Partial<Span> {
    public id: string;
    public parentId?: string;
    public name: string;
    public options?: SpanOptions;
    public attributes: Record<string, any> = {};
    public status?: { code: SpanStatusCode; message?: string };
    public exceptions: any[] = [];
    public ended = false;
    private _spanContext: SpanContext;

    constructor(name: string, id: string, parentId?: string, options?: SpanOptions) {
        this.name = name;
        this.id = id;
        this.parentId = parentId;
        this.options = options;
        if (options?.attributes) {
            Object.assign(this.attributes, options.attributes);
        }
        this._spanContext = {
            traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
            spanId: id.slice(0, 16).padStart(16, '0'),
            traceFlags: TraceFlags.SAMPLED,
        };
    }

    setAttribute(key: string, value: any): this {
        this.attributes[key] = value;
        return this;
    }

    setAttributes(attributes: Record<string, any>): this {
        Object.assign(this.attributes, attributes);
        return this;
    }

    setStatus(status: { code: SpanStatusCode; message?: string }): this {
        this.status = status;
        return this;
    }

    recordException(exception: any): this {
        this.exceptions.push(exception);
        return this;
    }

    end(): void {
        this.ended = true;
    }

    spanContext(): SpanContext {
        return this._spanContext;
    }

    isRecording(): boolean {
        return !this.ended;
    }

    updateName(name: string): this {
        this.name = name;
        return this;
    }

    addEvent(): this { return this; }
    addLink(): this { return this; }
    addLinks(): this { return this; }
}

class ExploratoryMockTracer implements Partial<Tracer> {
    public spans: ExploratoryMockSpan[] = [];
    private spanCounter = 0;
    private activeSpanStack: ExploratoryMockSpan[] = [];

    startSpan(name: string, options?: SpanOptions): Span {
        this.spanCounter++;
        const id = `span_${this.spanCounter}_${Math.random().toString(36).slice(2, 8)}`;
        const parentId = this.activeSpanStack.length > 0
            ? this.activeSpanStack[this.activeSpanStack.length - 1].id
            : undefined;

        const span = new ExploratoryMockSpan(name, id, parentId, options);
        this.spans.push(span);
        return span as unknown as Span;
    }

    startActiveSpan(name: any, ...args: any[]): any {
        const fn = args[args.length - 1];
        this.spanCounter++;
        const id = `span_root_${this.spanCounter}_${Math.random().toString(36).slice(2, 8)}`;
        const span = new ExploratoryMockSpan(name, id, undefined);
        this.spans.push(span);

        this.activeSpanStack.push(span);
        try {
            return fn(span);
        } finally {
            this.activeSpanStack.pop();
        }
    }
}

export async function runOpenTelemetryCharter(
    iterations: number = 15,
    seed: number = 9009
): Promise<CharterResult> {
    const startTime = Date.now();
    const rng = new RandomSource(seed);
    const errors: string[] = [];
    const invariantsChecked = [9];

    for (let i = 0; i < iterations; i++) {
        const tracer = new ExploratoryMockTracer();

        try {
            // =========================================================================
            // Sub-test A: W3C Trace Context Round-trip & Header Integrity
            // =========================================================================
            const dummySpan = new ExploratoryMockSpan('carrier_test', 'span_carrier_1');
            const headers = getTraceHeaders(dummySpan as unknown as Span);
            if (!headers.traceparent || !headers.traceparent.startsWith('00-')) {
                errors.push(`Iteration ${i}: Malformed W3C traceparent header: ${headers.traceparent}`);
            }

            const carrier: Record<string, string> = { ...headers };
            const extracted = extractTraceContext(carrier);
            if (!extracted) {
                errors.push(`Iteration ${i}: Failed to extract trace context from valid W3C header`);
            }

            // =========================================================================
            // Sub-test B: Generative Multi-Branch Workflow Span Hierarchy (Oracle 9)
            // =========================================================================
            const shouldFail = rng.nextBoolean(0.3);
            const branchType = rng.pick(['sequential', 'parallel', 'when']);

            const s1 = Step.create(`step_otel_1_${i}`, async () => ({ a: 1 }));
            const s2 = Step.create(`step_otel_2_${i}`, async () => {
                if (shouldFail) {
                    throw new Error(`Injected Otel step error in iteration ${i}`);
                }
                return { b: 2 };
            });
            const s3 = Step.create(`step_otel_3_${i}`, async () => ({ c: 3 }));

            let testFlow;
            if (branchType === 'parallel') {
                testFlow = flow(s1, parallel(s2, s3)).version('1.0.0');
            } else if (branchType === 'when') {
                testFlow = flow(s1, when((ctx: any) => ctx?.a === 1, s2, s3)).version('1.0.0');
            } else {
                testFlow = flow(s1, s2, s3).version('1.0.0');
            }

            const instrumented = instrumentWorkflow(testFlow, {
                tracer: tracer as unknown as Tracer,
                workflowName: `otel_flow_${i}`,
                allowNamespace: true,
            });

            try {
                await instrumented.run({ initial: true }, { namespace: `ns_${i}` });
                if (shouldFail) {
                    errors.push(`Iteration ${i}: Expected workflow to throw on injected failure, but resolved`);
                }
            } catch (err: any) {
                if (!shouldFail) {
                    errors.push(`Iteration ${i}: Unexpected workflow failure: ${err.message}`);
                }
            }

            // Verify Oracle 9: Distributed Tracing & Span Hierarchy Continuity
            const spanRecords = tracer.spans.map(s => ({
                id: s.id,
                parentId: s.parentId,
                name: s.name
            }));

            try {
                InvariantEvaluator.assertSpanContinuity(spanRecords);
            } catch (invErr: any) {
                errors.push(`Iteration ${i} [Oracle 9]: ${invErr.message}`);
            }

            // Verify Root Span attributes
            const rootSpan = tracer.spans.find(s => s.name.startsWith('workflow:'));
            if (!rootSpan) {
                errors.push(`Iteration ${i}: Missing root workflow span in tracer!`);
            } else {
                if (!rootSpan.ended) {
                    errors.push(`Iteration ${i}: Root workflow span was not ended!`);
                }
                if (shouldFail && rootSpan.status?.code !== SpanStatusCode.ERROR) {
                    errors.push(`Iteration ${i}: Failing workflow root span did not have ERROR status!`);
                }
                if (!shouldFail && rootSpan.status?.code !== SpanStatusCode.OK) {
                    errors.push(`Iteration ${i}: Successful workflow root span did not have OK status!`);
                }
            }

            // Verify all child step spans ended
            for (const span of tracer.spans) {
                if (!span.ended) {
                    errors.push(`Iteration ${i}: Span "${span.name}" (${span.id}) was not ended.`);
                }
            }

        } catch (charterErr: any) {
            errors.push(`Iteration ${i} Unhandled Exception: ${charterErr.message}`);
        }
    }

    return {
        charterName: 'Charter 9: Observability, W3C Trace Context & Metric Fidelity',
        iterations,
        passed: errors.length === 0,
        durationMs: Date.now() - startTime,
        invariantsChecked,
        errors
    };
}
