import { expect } from 'chai';
import { trace, SpanStatusCode, Span, Tracer, SpanOptions, Context, SpanContext, TraceFlags } from '@opentelemetry/api';
import { Step, flow, branch, when, parallel, map, clearStorage } from '@siglo/core';
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
    public parentSpan?: Span;
    private _spanContext: SpanContext;

    constructor(name: string, options?: SpanOptions, parentSpan?: Span) {
        this.name = name;
        this.options = options;
        this.parentSpan = parentSpan;
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
        const activeParent = trace.getActiveSpan();
        const span = new MockSpan(name, options, activeParent);
        this.spans.push(span);
        return span as unknown as Span;
    }

    startActiveSpan(name: any, ...args: any[]): any {
        const fn = args[args.length - 1];
        const activeParent = trace.getActiveSpan();
        const span = new MockSpan(name, undefined, activeParent);
        this.spans.push(span);
        return fn(span);
    }
}

describe('@siglo/opentelemetry Integration Suite', () => {
    let mockTracer: MockTracer;

    beforeEach(() => {
        mockTracer = new MockTracer();
        clearStorage();
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
            expect(stepASpan?.attributes[SemanticAttributes.STEP_KIND]).to.equal('standard');
            expect(stepASpan?.attributes[SemanticAttributes.NAMESPACE]).to.equal('tenant-42');
            expect(stepASpan?.status?.code).to.equal(SpanStatusCode.OK);
            expect(stepASpan?.ended).to.be.true;

            const stepBSpan = mockTracer.spans.find(s => s.name === 'step:stepB');
            expect(stepBSpan).to.exist;
            expect(stepBSpan?.attributes[SemanticAttributes.STEP_KIND]).to.equal('standard');
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

        it('supports run entry point without duplicate workflow spans', async () => {
            const step = Step.create('testStep', async () => ({ ok: true }));
            const wf = flow(step);
            const instrumented = instrumentWorkflow(wf, {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'EntryPointsTest',
            });

            // run
            await instrumented.run({});
            const wfSpans = mockTracer.spans.filter(s => s.name === 'workflow:EntryPointsTest');
            expect(wfSpans).to.have.lengthOf(1);
        });

        it('supports custom targets with execute and start entry points', async () => {
            const customTarget = {
                execute: async () => ({ ok: true }),
                start: async () => ({ ok: true }),
            };
            const instrumented = instrumentWorkflow(customTarget as any, {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'CustomEntryPointsTest',
            });

            // execute
            await instrumented.execute({});
            let wfSpans = mockTracer.spans.filter(s => s.name === 'workflow:CustomEntryPointsTest');
            expect(wfSpans).to.have.lengthOf(1);

            mockTracer.spans.length = 0;

            // start
            await instrumented.start({});
            wfSpans = mockTracer.spans.filter(s => s.name === 'workflow:CustomEntryPointsTest');
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

    describe('Step.compute Zero-Microtask Tracing', () => {
        it('creates child spans with siglo.step.kind = compute and executes consecutive compute steps with zero extra microtask', async () => {
            const timeline: string[] = [];
            let spanAEndedWhenBStarted = false;

            const computeA = Step.compute('computeA', (ctx: { x: number }) => {
                timeline.push('computeA:exec');
                queueMicrotask(() => timeline.push('microtask:after-A'));
                return { a: ctx.x * 2 };
            });

            const computeB = Step.compute('computeB', (ctx: { a: number }) => {
                const spanA = mockTracer.spans.find(s => s.name === 'step:computeA');
                spanAEndedWhenBStarted = Boolean(spanA?.ended && spanA?.status?.code === SpanStatusCode.OK);
                timeline.push('computeB:exec');
                return { b: ctx.a + 5 };
            });

            const wf = instrumentWorkflow(flow(computeA, computeB), {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'compute-pipeline',
                allowNamespace: true,
            });

            const res = await wf.run({ x: 10 }, { namespace: 'ns-compute' });
            expect(res.b).to.equal(25);

            // Both compute steps ran synchronously before the microtask scheduled inside computeA!
            expect(timeline).to.deep.equal(['computeA:exec', 'computeB:exec', 'microtask:after-A']);
            expect(spanAEndedWhenBStarted).to.be.true;

            const wfSpan = mockTracer.spans.find(s => s.name === 'workflow:compute-pipeline');
            const spanA = mockTracer.spans.find(s => s.name === 'step:computeA');
            const spanB = mockTracer.spans.find(s => s.name === 'step:computeB');

            expect(wfSpan).to.exist;
            expect(spanA).to.exist;
            expect(spanB).to.exist;

            expect(spanA?.attributes[SemanticAttributes.STEP_KIND]).to.equal('compute');
            expect(spanA?.attributes[SemanticAttributes.STEP_NAME]).to.equal('computeA');
            expect(spanA?.attributes[SemanticAttributes.NAMESPACE]).to.equal('ns-compute');
            expect(spanA?.attributes[SemanticAttributes.CACHE_HIT]).to.be.undefined;
            expect(spanA?.status?.code).to.equal(SpanStatusCode.OK);
            expect(spanA?.ended).to.be.true;

            expect(spanB?.attributes[SemanticAttributes.STEP_KIND]).to.equal('compute');
            expect(spanB?.status?.code).to.equal(SpanStatusCode.OK);
            expect(spanB?.ended).to.be.true;
        });

        it('records siglo.cache.hit = false on miss and true on hit for cached Step.compute', async () => {
            let calls = 0;
            const scoreStep = Step.compute('scoreStep', (ctx: { base: number; bonus: number }) => {
                calls++;
                return { score: ctx.base + ctx.bonus };
            })
                .spec('bonus', { default: 10 })
                .cache({ ttl: '5m', maxEntries: 100 });

            const wf = instrumentWorkflow(flow(scoreStep), {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'cached-compute-flow',
            });

            // 1. Cache miss
            const r1 = await wf.run({ base: 50 });
            expect(r1.score).to.equal(60);
            expect(calls).to.equal(1);

            // 2. Cache hit (normalized post-.spec() input matches { base: 50, bonus: 10 })
            const r2 = await wf.run({ base: 50, bonus: 10 });
            expect(r2.score).to.equal(60);
            expect(calls).to.equal(1);

            const scoreSpans = mockTracer.spans.filter(s => s.name === 'step:scoreStep');
            expect(scoreSpans).to.have.lengthOf(2);

            expect(scoreSpans[0].attributes[SemanticAttributes.STEP_KIND]).to.equal('compute');
            expect(scoreSpans[0].attributes[SemanticAttributes.CACHE_HIT]).to.equal(false);
            expect(scoreSpans[0].status?.code).to.equal(SpanStatusCode.OK);
            expect(scoreSpans[0].ended).to.be.true;

            expect(scoreSpans[1].attributes[SemanticAttributes.STEP_KIND]).to.equal('compute');
            expect(scoreSpans[1].attributes[SemanticAttributes.CACHE_HIT]).to.equal(true);
            expect(scoreSpans[1].status?.code).to.equal(SpanStatusCode.OK);
            expect(scoreSpans[1].ended).to.be.true;
        });

        it('records exception and sets ERROR status when Step.compute .spec() or action() fails', async () => {
            const specFailStep = Step.compute('specFailStep', (ctx: { amount: number }) => ({
                total: ctx.amount,
            })).spec('amount', { require: true, validate: v => typeof v === 'number' && v > 0 });

            const wfSpec = instrumentWorkflow(flow(specFailStep), {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'spec-fail-flow',
            });

            let specErrThrown = false;
            try {
                await wfSpec.run({ amount: -5 });
            } catch {
                specErrThrown = true;
            }
            expect(specErrThrown).to.be.true;

            const specSpan = mockTracer.spans.find(s => s.name === 'step:specFailStep');
            expect(specSpan).to.exist;
            expect(specSpan?.attributes[SemanticAttributes.STEP_KIND]).to.equal('compute');
            expect(specSpan?.status?.code).to.equal(SpanStatusCode.ERROR);
            expect(specSpan?.exceptions).to.have.lengthOf(1);
            expect(specSpan?.ended).to.be.true;

            mockTracer.spans.length = 0;

            const actionFailStep = Step.compute('actionFailStep', () => {
                throw new Error('Division by zero in compute step');
            });

            const wfAction = instrumentWorkflow(flow(actionFailStep), {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'action-fail-flow',
            });

            let actionErrThrown = false;
            try {
                await wfAction.run({});
            } catch (err: any) {
                actionErrThrown = true;
                expect(err.message).to.include('Division by zero in compute step');
            }
            expect(actionErrThrown).to.be.true;

            const actionSpan = mockTracer.spans.find(s => s.name === 'step:actionFailStep');
            expect(actionSpan).to.exist;
            expect(actionSpan?.attributes[SemanticAttributes.STEP_KIND]).to.equal('compute');
            expect(actionSpan?.status?.code).to.equal(SpanStatusCode.ERROR);
            expect(actionSpan?.status?.message).to.include('Division by zero in compute step');
            expect(actionSpan?.exceptions).to.have.lengthOf(1);
            expect(actionSpan?.ended).to.be.true;
        });

        it('propagates parent-child OpenTelemetry context into Step.compute and nested custom spans', async () => {
            let capturedActiveSpanInCompute: Span | undefined;

            const computeWithChildSpan = Step.compute('computeWithChildSpan', (ctx: { val: number }) => {
                capturedActiveSpanInCompute = trace.getActiveSpan();
                const customChild = mockTracer.startSpan('custom:algorithm-substep');
                customChild.setAttribute('algorithm.input', ctx.val);
                customChild.end();
                return { out: ctx.val * 3 };
            });

            const wf = instrumentWorkflow(flow(computeWithChildSpan), {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'parent-child-compute',
            });

            const res = await wf.run({ val: 7 });
            expect(res.out).to.equal(21);

            const wfSpan = mockTracer.spans.find(s => s.name === 'workflow:parent-child-compute');
            const computeSpan = mockTracer.spans.find(s => s.name === 'step:computeWithChildSpan');
            const customChildSpan = mockTracer.spans.find(s => s.name === 'custom:algorithm-substep');

            expect(wfSpan).to.exist;
            expect(computeSpan).to.exist;
            expect(customChildSpan).to.exist;

            // Verify parent hierarchy: workflow -> computeSpan -> customChildSpan
            expect(computeSpan?.parentSpan).to.equal(wfSpan);
            expect(capturedActiveSpanInCompute).to.equal(computeSpan);
            expect(customChildSpan?.parentSpan).to.equal(computeSpan);
        });

        it('supports standalone instrumentStep(computeStep) without tripping the runtime thenable guard or duplicating spans in workflows', async () => {
            const standaloneCompute = Step.compute('standaloneCompute', (ctx: { n: number }) => ({
                squared: ctx.n * ctx.n,
            }));

            instrumentStep(standaloneCompute, { tracer: mockTracer as unknown as Tracer });

            // 1. Run without instrumentWorkflow
            const res1 = await standaloneCompute.run({ n: 6 });
            expect(res1.squared).to.equal(36);

            let spans = mockTracer.spans.filter(s => s.name === 'step:standaloneCompute');
            expect(spans).to.have.lengthOf(1);
            expect(spans[0].attributes[SemanticAttributes.STEP_KIND]).to.equal('compute');
            expect(spans[0].status?.code).to.equal(SpanStatusCode.OK);
            expect(spans[0].ended).to.be.true;

            mockTracer.spans.length = 0;

            // 2. Run inside instrumentWorkflow (must not create duplicate spans)
            const wf = instrumentWorkflow(flow(standaloneCompute), {
                tracer: mockTracer as unknown as Tracer,
                workflowName: 'mixed-compute-wf',
            });
            const res2 = await wf.run({ n: 9 });
            expect(res2.squared).to.equal(81);

            spans = mockTracer.spans.filter(s => s.name === 'step:standaloneCompute');
            expect(spans).to.have.lengthOf(1);
            expect(spans[0].attributes[SemanticAttributes.STEP_KIND]).to.equal('compute');

            // 3. Traces map() batch execution with Step.compute
            mockTracer.spans.length = 0;
            const batchItemStep = Step.compute('batchItemStep', (p: any) => ({ doubled: p.item * 2 }));
            const batchFlow = instrumentWorkflow(
                flow(
                    Step.create('seed', () => ({ items: [1, 2, 3] })),
                    map((ctx: any) => ctx.items, batchItemStep),
                ),
                {
                    tracer: mockTracer as unknown as Tracer,
                    workflowName: 'batch-compute-wf',
                },
            );
            await batchFlow.run({});
            const batchSpans = mockTracer.spans.filter(s => s.name === 'step:batchItemStep');
            expect(batchSpans).to.have.lengthOf(3);
            for (const s of batchSpans) {
                expect(s.attributes[SemanticAttributes.STEP_KIND]).to.equal('compute');
                expect(s.ended).to.be.true;
            }
        });

        it('records siglo.cache.hit and .spec() validation exceptions on standalone instrumentStep(computeStep)', async () => {
            let calls = 0;
            const standaloneCached = Step.compute('standaloneCached', (ctx: { qty: number }) => {
                calls++;
                return { total: ctx.qty * 10 };
            })
                .spec('qty', { require: true, validate: v => typeof v === 'number' && v > 0 })
                .cache('5m');

            instrumentStep(standaloneCached, { tracer: mockTracer as unknown as Tracer, allowNamespace: true });

            // 1. Standalone cache miss
            const r1 = await standaloneCached.run({ qty: 3 }, { namespace: 'tenant-1' });
            expect(r1.total).to.equal(30);
            expect(calls).to.equal(1);

            // 2. Standalone cache hit (must still emit a span with siglo.cache.hit = true!)
            const r2 = await standaloneCached.run({ qty: 3 }, { namespace: 'tenant-1' });
            expect(r2.total).to.equal(30);
            expect(calls).to.equal(1);

            // 3. Standalone .spec() validation failure (must record exception & ERROR status on span)
            let validationFailed = false;
            try {
                await standaloneCached.run({ qty: -5 }, { namespace: 'tenant-1' });
            } catch {
                validationFailed = true;
            }
            expect(validationFailed).to.be.true;

            const spans = mockTracer.spans.filter(s => s.name === 'step:standaloneCached');
            expect(spans).to.have.lengthOf(3);

            expect(spans[0].attributes[SemanticAttributes.STEP_KIND]).to.equal('compute');
            expect(spans[0].attributes[SemanticAttributes.CACHE_HIT]).to.equal(false);
            expect(spans[0].attributes[SemanticAttributes.NAMESPACE]).to.equal('tenant-1');
            expect(spans[0].status?.code).to.equal(SpanStatusCode.OK);

            expect(spans[1].attributes[SemanticAttributes.STEP_KIND]).to.equal('compute');
            expect(spans[1].attributes[SemanticAttributes.CACHE_HIT]).to.equal(true);
            expect(spans[1].status?.code).to.equal(SpanStatusCode.OK);

            expect(spans[2].attributes[SemanticAttributes.STEP_KIND]).to.equal('compute');
            expect(spans[2].status?.code).to.equal(SpanStatusCode.ERROR);
            expect(spans[2].exceptions).to.have.lengthOf(1);
            expect(spans[2].ended).to.be.true;
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
