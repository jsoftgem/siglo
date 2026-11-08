import { expect } from 'chai';
import { SpanStatusCode, Span, Tracer, SpanOptions, Context, SpanContext, TraceFlags } from '@opentelemetry/api';
import { Step, flow, branch, when, parallel } from '@siglo/core';
import {
    SemanticAttributes,
    instrumentWorkflow,
    instrumentStep,
    createTelemetryStorageAdapter,
    injectTraceContext,
    extractTraceContext,
    getTraceHeaders,
} from './index';

// Custom mock tracer to inspect recorded spans and attributes
class MockSpan implements Partial<Span> {
    public name: string;
    public options?: SpanOptions;
    public attributes: Record<string, any> = {};
    public status?: { code: SpanStatusCode; message?: string };
    public exceptions: any[] = [];
    public ended = false;
    private _spanContext: SpanContext;

    constructor(name: string, options?: SpanOptions) {
        this.name = name;
        this.options = options;
        if (options?.attributes) {
            Object.assign(this.attributes, options.attributes);
        }
        this._spanContext = {
            traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
            spanId: '00f067aa0ba902b7',
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

    addEvent(): this {
        return this;
    }

    addLink(): this {
        return this;
    }

    addLinks(): this {
        return this;
    }
}

class MockTracer implements Partial<Tracer> {
    public spans: MockSpan[] = [];

    startSpan(name: string, options?: SpanOptions, _context?: Context): Span {
        const span = new MockSpan(name, options);
        this.spans.push(span);
        return span as unknown as Span;
    }

    startActiveSpan(name: any, ...args: any[]): any {
        const fn = args[args.length - 1];
        const span = new MockSpan(name);
        this.spans.push(span);
        return fn(span);
    }
}

describe('@siglo/opentelemetry Integration Suite', () => {
    let mockTracer: MockTracer;

    beforeEach(() => {
        mockTracer = new MockTracer();
    });

    describe('W3C Trace Context Helpers', () => {
        it('getTraceHeaders formats W3C traceparent correctly', () => {
            const span = new MockSpan('test');
            const headers = getTraceHeaders(span as unknown as Span);
            expect(headers.traceparent).to.equal('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
        });

        it('injectTraceContext & extractTraceContext propagate headers', () => {
            const carrier: Record<string, string> = {};
            injectTraceContext(carrier);
            expect(typeof carrier).to.equal('object');

            const incomingHeaders = {
                traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
            };
            const extractedContext = extractTraceContext(incomingHeaders);
            expect(extractedContext).to.be.ok;
        });

        it('getTraceHeaders handles missing span gracefully', () => {
            const headers = getTraceHeaders(undefined);
            expect(headers).to.deep.equal({});
        });
    });

    describe('instrumentWorkflow', () => {
        it('records root workflow span and child step spans with metadata on successful run', async () => {
            const stepA = Step.create('stepA', async (param: { x: number }) => ({ val: param.x * 2 }));
            const stepB = Step.create('stepB', async (param: { val: number }) => ({ output: param.val + 10 }));
            const myFlow = flow(stepA, stepB).version('1.2.0');

            const instrumented = instrumentWorkflow(myFlow, {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'order-processing',
                allowNamespace: true,
            });

            const result: any = await instrumented.run({ x: 5 }, { namespace: 'tenant-42', timeout: 5000 });
            const val = typeof result.output === 'function' ? result.output() : result.output;
            expect(val).to.equal(20);

            // Workflow span assertions
            const wfSpan = mockTracer.spans.find(s => s.name === 'workflow:order-processing');
            expect(wfSpan).to.exist;
            expect(wfSpan?.attributes[SemanticAttributes.WORKFLOW_NAME]).to.equal('order-processing');
            expect(wfSpan?.attributes[SemanticAttributes.WORKFLOW_VERSION]).to.equal('1.2.0');
            expect(wfSpan?.attributes[SemanticAttributes.NAMESPACE]).to.equal('tenant-42');
            expect(wfSpan?.attributes[SemanticAttributes.TIMEOUT]).to.equal(5000);
            expect(wfSpan?.attributes[SemanticAttributes.STACK_ID]).to.be.a('string');
            expect(wfSpan?.status?.code).to.equal(SpanStatusCode.OK);
            expect(wfSpan?.ended).to.be.true;

            // Step spans assertions
            const stepASpan = mockTracer.spans.find(s => s.name === 'step:stepA');
            expect(stepASpan).to.exist;
            expect(stepASpan?.attributes[SemanticAttributes.STEP_NAME]).to.equal('stepA');
            expect(stepASpan?.attributes[SemanticAttributes.NAMESPACE]).to.equal('tenant-42');
            expect(stepASpan?.status?.code).to.equal(SpanStatusCode.OK);
            expect(stepASpan?.ended).to.be.true;

            const stepBSpan = mockTracer.spans.find(s => s.name === 'step:stepB');
            expect(stepBSpan).to.exist;
            expect(stepBSpan?.ended).to.be.true;
        });

        it('records exception and sets ERROR status when workflow fails', async () => {
            const failingStep = Step.create('failingStep', async (): Promise<any> => {
                throw new Error('Database connection failed');
            });
            const failingFlow = flow(failingStep);

            const instrumented = instrumentWorkflow(failingFlow, {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'faulty-flow',
            });

            try {
                await instrumented.run({});
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.message).to.equal('Database connection failed');
            }

            const wfSpan = mockTracer.spans.find(s => s.name === 'workflow:faulty-flow');
            expect(wfSpan).to.exist;
            expect(wfSpan?.status?.code).to.equal(SpanStatusCode.ERROR);
            expect(wfSpan?.status?.message).to.equal('Database connection failed');
            expect(wfSpan?.exceptions).to.have.lengthOf(1);
            expect(wfSpan?.ended).to.be.true;

            const stepSpan = mockTracer.spans.find(s => s.name === 'step:failingStep');
            expect(stepSpan).to.exist;
            expect(stepSpan?.status?.code).to.equal(SpanStatusCode.ERROR);
            expect(stepSpan?.ended).to.be.true;
        });

        it('redacts namespace by default unless allowNamespace is true', async () => {
            const stepA = Step.create(async () => ({ ok: true }));
            const myFlow = flow(stepA);

            const instrumented = instrumentWorkflow(myFlow, {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'secure-workflow',
                allowNamespace: false, // Default: do not record namespace
            });

            await instrumented.run({}, { namespace: 'secret-tenant' });

            const wfSpan = mockTracer.spans.find(s => s.name === 'workflow:secure-workflow');
            expect(wfSpan?.attributes[SemanticAttributes.NAMESPACE]).to.be.undefined;
        });

        it('automatically traces nested branch and when combinators without explicit step instrumentation', async () => {
            const reserveStock = Step.create('reserveStock', async () => ({ reserved: true }));
            const chargePayment = Step.create('chargePayment', async () => ({ charged: true }));
            const wrapGift = Step.create('wrapGift', async () => ({ wrapped: true }));
            const shipOrder = Step.create('shipOrder', async () => ({ shipped: true }));
            const queueReview = Step.create('queueReview', async () => ({ review: true }));
            const cancelOrder = Step.create('recordCancellation', async () => ({ cancelled: true }));
            const saveOutcome = Step.create('saveOutcome', async () => ({ saved: true }));

            const fulfillment = flow(
                reserveStock,
                chargePayment,
                when((o: any) => o.giftWrap === true, wrapGift),
                shipOrder,
            );
            const placedOrder = when((o: any) => o.amountCents >= 100000, queueReview, fulfillment);
            const myWorkflow = flow(
                branch((e: any) => e.type, {
                    'order.placed': placedOrder,
                    'order.cancelled': cancelOrder,
                }),
                saveOutcome,
            );

            const instrumented = instrumentWorkflow(myWorkflow, {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'NestedOrderWorkflow',
            });

            // 1. Run standard order (placed, amount < 100k, no gift)
            await instrumented.run({ type: 'order.placed', amountCents: 5000, giftWrap: false });

            const stepNames1 = mockTracer.spans
                .filter(s => s.attributes[SemanticAttributes.STEP_NAME])
                .map(s => s.attributes[SemanticAttributes.STEP_NAME]);

            expect(stepNames1).to.include('reserveStock');
            expect(stepNames1).to.include('chargePayment');
            expect(stepNames1).to.include('shipOrder');
            expect(stepNames1).to.include('saveOutcome');
            // Untaken routes must not produce action spans:
            expect(stepNames1).to.not.include('wrapGift');
            expect(stepNames1).to.not.include('queueReview');
            expect(stepNames1).to.not.include('recordCancellation');

            mockTracer.spans.length = 0;

            // 2. Run gift order (placed, amount < 100k, gift true)
            await instrumented.run({ type: 'order.placed', amountCents: 5000, giftWrap: true });
            const stepNames2 = mockTracer.spans
                .filter(s => s.attributes[SemanticAttributes.STEP_NAME])
                .map(s => s.attributes[SemanticAttributes.STEP_NAME]);

            expect(stepNames2).to.include('reserveStock');
            expect(stepNames2).to.include('chargePayment');
            expect(stepNames2).to.include('wrapGift');
            expect(stepNames2).to.include('shipOrder');
            expect(stepNames2).to.include('saveOutcome');
            expect(stepNames2).to.not.include('queueReview');
            expect(stepNames2).to.not.include('recordCancellation');

            mockTracer.spans.length = 0;

            // 3. Run high-value review order (placed, amount >= 100k)
            await instrumented.run({ type: 'order.placed', amountCents: 200000 });
            const stepNames3 = mockTracer.spans
                .filter(s => s.attributes[SemanticAttributes.STEP_NAME])
                .map(s => s.attributes[SemanticAttributes.STEP_NAME]);

            expect(stepNames3).to.include('queueReview');
            expect(stepNames3).to.include('saveOutcome');
            expect(stepNames3).to.not.include('reserveStock');
            expect(stepNames3).to.not.include('chargePayment');
            expect(stepNames3).to.not.include('shipOrder');

            mockTracer.spans.length = 0;

            // 4. Run cancelled order
            await instrumented.run({ type: 'order.cancelled' });
            const stepNames4 = mockTracer.spans
                .filter(s => s.attributes[SemanticAttributes.STEP_NAME])
                .map(s => s.attributes[SemanticAttributes.STEP_NAME]);

            expect(stepNames4).to.include('recordCancellation');
            expect(stepNames4).to.include('saveOutcome');
            expect(stepNames4).to.not.include('queueReview');
            expect(stepNames4).to.not.include('reserveStock');
        });

        it('supports run, execute, and start entry points consistently without duplicate workflow spans', async () => {
            const step = Step.create('testStep', async () => ({ ok: true }));
            const wf = flow(step);
            const instrumented = instrumentWorkflow(wf, {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'EntryPointsTest',
            });

            // execute
            await instrumented.execute({});
            let wfSpans = mockTracer.spans.filter(s => s.name === 'workflow:EntryPointsTest');
            expect(wfSpans).to.have.lengthOf(1);

            mockTracer.spans.length = 0;

            // start
            await instrumented.start({});
            wfSpans = mockTracer.spans.filter(s => s.name === 'workflow:EntryPointsTest');
            expect(wfSpans).to.have.lengthOf(1);

            mockTracer.spans.length = 0;

            // run
            await instrumented.run({});
            wfSpans = mockTracer.spans.filter(s => s.name === 'workflow:EntryPointsTest');
            expect(wfSpans).to.have.lengthOf(1);
        });

        it('prevents duplicate spans when mixing explicit instrumentStep and workflow instrumentation', async () => {
            const explicitStep = Step.create('explicitStep', async () => ({ explicit: true }));
            // Step is explicitly instrumented BEFORE workflow composition
            instrumentStep(explicitStep, { tracer: mockTracer as unknown as Tracer });

            const normalStep = Step.create('normalStep', async () => ({ normal: true }));
            const wf = flow(explicitStep, normalStep);

            // Workflow is instrumented
            const instrumented = instrumentWorkflow(wf, {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'MixedInstrumentation',
            });

            await instrumented.run({});

            // Check that explicitStep only produced ONE span!
            const explicitSpans = mockTracer.spans.filter(
                s => s.attributes[SemanticAttributes.STEP_NAME] === 'explicitStep',
            );
            expect(explicitSpans).to.have.lengthOf(1);

            const normalSpans = mockTracer.spans.filter(
                s => s.attributes[SemanticAttributes.STEP_NAME] === 'normalStep',
            );
            expect(normalSpans).to.have.lengthOf(1);
        });

        it('prevents duplicate spans when instrumentWorkflow is called multiple times', async () => {
            const step = Step.create('dupStep', async () => ({ val: 1 }));
            const wf = flow(step);

            const instrumented1 = instrumentWorkflow(wf, {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'DupWf',
            });
            const instrumented2 = instrumentWorkflow(instrumented1, {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'DupWf',
            });

            expect(instrumented2).to.equal(instrumented1);

            await instrumented2.run({});

            const wfSpans = mockTracer.spans.filter(s => s.name === 'workflow:DupWf');
            expect(wfSpans).to.have.lengthOf(1);

            const stepSpans = mockTracer.spans.filter(s => s.attributes[SemanticAttributes.STEP_NAME] === 'dupStep');
            expect(stepSpans).to.have.lengthOf(1);
        });

        it('prevents duplicate wrappers when instrumentStep is called multiple times', async () => {
            const step = Step.create('multiStep', async () => ({ val: 1 }));
            const s1 = instrumentStep(step, { tracer: mockTracer as unknown as Tracer });
            const s2 = instrumentStep(s1, { tracer: mockTracer as unknown as Tracer });
            expect(s2).to.equal(s1);

            const wf = flow(s2);
            await wf.run({});

            const spans = mockTracer.spans.filter(s => s.attributes[SemanticAttributes.STEP_NAME] === 'multiStep');
            expect(spans).to.have.lengthOf(1);
        });

        it('handles concurrent branches without leaking context', async () => {
            const task1 = Step.create('task1', async () => ({ t1: true }));
            const task2 = Step.create('task2', async () => ({ t2: true }));
            const wf = flow(parallel(task1, task2));

            const instrumented = instrumentWorkflow(wf, {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'ParallelWorkflow',
            });

            await instrumented.run({});

            const stepNames = mockTracer.spans
                .filter(s => s.attributes[SemanticAttributes.STEP_NAME])
                .map(s => s.attributes[SemanticAttributes.STEP_NAME]);

            expect(stepNames).to.include('parallel');
            expect(stepNames).to.include('task1');
            expect(stepNames).to.include('task2');
        });
    });

    describe('instrumentStep & Retry Handling', () => {
        it('starts at attempt one when the same workflow handles another record', async () => {
            const workflow = instrumentWorkflow(flow(Step.create('handleRecord', async () => ({ ok: true }))), {
                tracer: mockTracer as unknown as Tracer,
            });
            await workflow.run({ record: 1 });
            await workflow.run({ record: 2 });
            const steps = mockTracer.spans.filter(
                span => span.attributes[SemanticAttributes.STEP_NAME] === 'handleRecord',
            );
            expect(steps).to.have.length(2);
            for (const step of steps) {
                expect(step.name).to.equal('step:handleRecord');
                expect(step.attributes[SemanticAttributes.STEP_ATTEMPT]).to.equal(1);
            }
        });

        it('records retry attempts with incremented attempt numbers', async () => {
            let attempts = 0;
            const flaky = Step.create('flakyService', async () => {
                attempts++;
                if (attempts === 1) {
                    throw new Error('Temporary 503 gateway error');
                }
                return { success: true };
            }).onFail({ maxRetries: 2, delay: 10 });

            instrumentStep(flaky, { tracer: mockTracer as unknown as Tracer });

            const testFlow = flow(flaky);
            await testFlow.run({});

            expect(attempts).to.equal(2);

            const initialSpan = mockTracer.spans.find(s => s.name === 'step:flakyService');
            expect(initialSpan).to.exist;
            expect(initialSpan?.attributes[SemanticAttributes.STEP_ATTEMPT]).to.equal(1);
            expect(initialSpan?.status?.code).to.equal(SpanStatusCode.ERROR);

            const retrySpan = mockTracer.spans.find(s => s.name === 'step:flakyService (retry #2)');
            expect(retrySpan).to.exist;
            expect(retrySpan?.attributes[SemanticAttributes.STEP_ATTEMPT]).to.equal(2);
            expect(retrySpan?.status?.code).to.equal(SpanStatusCode.OK);
        });

        it('handles non-object step input gracefully', () => {
            expect(instrumentStep(null as any)).to.be.null;
            expect(instrumentStep(undefined as any)).to.be.undefined;
        });
    });

    describe('createTelemetryStorageAdapter & Context Sanitization', () => {
        it('omits context fields by default and records only allowlisted fields with redaction', () => {
            const adapter = createTelemetryStorageAdapter({
                allowContextFields: ['orderId', 'creditCard'],
                redactHook: (key, val) => {
                    if (key === 'creditCard') {
                        return `****-****-****-${String(val).slice(-4)}`;
                    }
                    return val;
                },
            });

            expect(adapter.name).to.equal('opentelemetry');

            // Simulate active span
            const testSpan = new MockSpan('active-span');
            // When not active in trace, nothing breaks
            adapter.onContextChange?.({
                stackId: 'stack-1',
                stepId: 'step-1',
                field: 'password', // Not in allowlist
                value: 'super-secret',
                timestamp: Date.now(),
            });
            expect(testSpan.attributes['siglo.context.password']).to.be.undefined;
        });
    });
});
