import { expect } from 'chai';
import {
    Step,
    ComputeStep,
    COMPUTE_NETWORK_POLICY,
    SyncSpec,
    runSpecsSync,
    ComputeCache,
    clearComputeCaches,
    executeComputeStepSync,
    flow,
    isFlow,
    parallel,
    all,
    allSettled,
    race,
    when,
    branch,
    map,
    waitForEvent,
    resumeWorkflow,
    clearStorage,
    useStorage,
    defaultCompensationManager,
    ExecutionPhase,
    SigloError,
    ValidationException,
    CancellationException,
    FlowTimeoutException,
    StepExecutionHook,
    WorkflowExecutionEvent,
} from '../../index';

describe('Step.compute — Synchronous Compute Steps', () => {
    beforeEach(() => {
        clearStorage();
        defaultCompensationManager.clear();
    });

    afterEach(() => {
        clearStorage();
        defaultCompensationManager.clear();
    });

    describe('Factory, Surface & Type Guards', () => {
        it('creates named and anonymous ComputeStep instances with always-deny network policy', () => {
            const named = Step.compute('calc', (x: { a: number }) => ({ doubled: x.a * 2 }));
            expect(named).to.be.instanceOf(ComputeStep);
            expect(named.isCompute).to.be.true;
            expect(named.name).to.equal('calc');
            expect(named.func).to.equal('calc');
            expect(named.$stepId).to.be.a('string');
            expect(named.specs).to.deep.equal([]);
            expect(named.networkPolicyConfig).to.equal(COMPUTE_NETWORK_POLICY);
            expect(named.networkPolicyConfig.enabled).to.be.true;
            expect(named.networkPolicyConfig.defaultPolicy).to.equal('deny');
            expect(named.networkPolicyConfig.allowedHosts).to.deep.equal([]);
            expect(named.networkPolicyConfig.allowLocalhost).to.be.false;

            const anon = Step.compute((x: { a: number }) => ({ tripled: x.a * 3 }));
            expect(anon).to.be.instanceOf(ComputeStep);
            expect(anon.name).to.equal('');
            expect(anon.func).to.equal('');

            expect(isFlow(named)).to.be.false;
            expect(isFlow({ isCompute: true, run: () => Promise.resolve() })).to.be.false;

            // Lifecycle & I/O hooks are omitted from ComputeStep
            expect((named as any).onBefore).to.be.undefined;
            expect((named as any).onAfter).to.be.undefined;
            expect((named as any).onFail).to.be.undefined;
            expect((named as any).onSkip).to.be.undefined;
            expect((named as any).compensate).to.be.undefined;
            expect((named as any).timeout).to.be.undefined;
            expect((named as any).idempotent).to.be.undefined;
            expect((named as any).allowNetwork).to.be.undefined;
            expect((named as any).allowUnixSockets).to.be.undefined;
            expect((named as any).networkPolicy).to.be.undefined;
            expect((named as any).withDependencies).to.be.undefined;
        });

        it('throws when Step.compute is constructed without a function action', () => {
            expect(() => new (ComputeStep as any)('broken', null)).to.throw(
                "Step.compute 'broken' requires a synchronous action function.",
            );
            expect(() => new (ComputeStep as any)('', undefined)).to.throw(
                "Step.compute 'anonymous' requires a synchronous action function.",
            );
        });
    });

    describe('Synchronous Execution, Context Accumulation & Fast Path', () => {
        it('executes standalone via .run() and Step.start()', async () => {
            const add = Step.compute('add', (ctx: { a: number; b: number }) => ({ sum: ctx.a + ctx.b }));

            const res1 = await add.run({ a: 2, b: 3 });
            expect(res1.sum).to.equal(5);
            expect((res1 as any).$steps.add).to.deep.equal({ sum: 5 });
            expect((res1 as any).$steps('add')).to.deep.equal({ sum: 5 });
            expect((res1 as any).$steps()).to.have.property('add');

            const res2 = await Step.start(add, { a: 10, b: 20 });
            expect(res2.sum).to.equal(30);

            // Empty/omitted param & explicit options without ast
            const constant = Step.compute(() => ({ ok: true }));
            const res3 = await constant.run(undefined, { namespace: 'ns-standalone' });
            expect(res3.ok).to.be.true;
            expect((res3 as any).$steps.step_0).to.deep.equal({ ok: true });
        });

        it('handles primitive, array, and undefined return values cleanly', async () => {
            const returnPrimitive = Step.compute('prim', (ctx: { n: number }) => ctx.n * 2);
            const returnArray = Step.compute('arr', (ctx: { n: number }) => [ctx.n, ctx.n + 1]);
            const returnUndef = Step.compute('noop', () => undefined);

            expect(await returnPrimitive.run({ n: 7 })).to.equal(14);
            expect(await returnArray.run({ n: 3 })).to.deep.equal([3, 4]);
            expect(await returnUndef.run({ n: 1 })).to.be.undefined;

            // In a flow: primitive/array as intermediate and final steps, and undefined as final step
            const f1 = flow(
                Step.compute('makeNum', (ctx: { n: number }) => ctx.n + 1),
                Step.compute('readVal', (ctx: any) => ({
                    doubled: ctx.value * 2,
                    fromSteps: ctx.$steps.makeNum.value,
                })),
                Step.compute('audit', () => undefined),
            );
            const r1: any = await f1.run({ n: 5 });
            expect(r1.doubled).to.equal(12);
            expect(r1.fromSteps).to.equal(6);

            const f2 = flow(
                Step.compute('prep', (ctx: { x: number }) => ({ y: ctx.x + 1 })),
                Step.compute('finalArr', (ctx: { y: number }) => [ctx.y, ctx.y * 2]),
            );
            const r2 = await f2.run({ x: 4 });
            expect(r2).to.deep.equal([5, 10]);

            const f3 = flow(
                Step.compute('prep', (ctx: { x: number }) => ({ y: ctx.x + 1 })),
                Step.compute('finalPrim', (ctx: { y: number }) => ctx.y * 10),
            );
            expect(await f3.run({ x: 3 })).to.equal(40);
        });

        it('batches consecutive ComputeSteps synchronously with zero macrotask or microtask hops', async () => {
            const trace: string[] = [];

            const s1 = Step.compute('s1', (ctx: { n: number }) => {
                trace.push('s1');
                return { a: ctx.n + 1 };
            });
            const s2 = Step.compute('s2', (ctx: { a: number }) => {
                trace.push('s2');
                return { b: ctx.a * 2 };
            });
            const s3 = Step.compute('s3', (ctx: { b: number; $steps: any }) => {
                trace.push('s3');
                return { c: ctx.b + ctx.$steps.s1.a };
            });

            const wf = flow(s1, s2, s3);

            // Schedule a microtask and macrotask right after starting the flow
            const p = wf.run({ n: 5 });
            Promise.resolve().then(() => trace.push('microtask'));
            setTimeout(() => trace.push('macrotask'), 0);

            const result = await p;
            expect(result.a).to.equal(6);
            expect(result.b).to.equal(12);
            expect(result.c).to.equal(18);
            expect(result.$steps.s1).to.deep.equal({ a: 6 });
            expect(result.$steps.s2).to.deep.equal({ b: 12 });
            expect(result.$steps.s3).to.deep.equal({ c: 18 });

            // All three compute steps executed synchronously before the scheduled microtask!
            expect(trace.slice(0, 4)).to.deep.equal(['s1', 's2', 's3', 'microtask']);
        });

        it('interoperates seamlessly in mixed Step.create + Step.compute flows', async () => {
            const fetchCart = Step.create('fetchCart', async (ctx: { cartId: string }) => ({
                subtotal: ctx.cartId === 'c1' ? 100 : 50,
            }));
            const calculateTotals = Step.compute(
                'calculateTotals',
                (ctx: { subtotal: number; discount: number; taxRate: number }) => {
                    const taxable = Math.max(0, ctx.subtotal - ctx.discount);
                    const tax = Math.round(taxable * ctx.taxRate * 100) / 100;
                    return { tax, total: taxable + tax };
                },
            )
                .spec('subtotal', { require: true, validate: v => typeof v === 'number' && v >= 0 })
                .spec('discount', { default: 0, transform: v => Math.max(0, Number(v)) })
                .spec('taxRate', { default: 0.08 });
            const formatReceipt = Step.compute('formatReceipt', (ctx: { total: number; $steps: any }) => ({
                receipt: `PAID:${ctx.total}:SUB:${ctx.$steps.fetchCart.subtotal}`,
            }));
            const chargeCard = Step.create('chargeCard', async (ctx: { total: number; receipt: string }) => ({
                charged: true,
                chargeAmount: ctx.total,
                receiptCopy: ctx.receipt,
            }));

            const checkoutFlow = flow(fetchCart, calculateTotals, formatReceipt, chargeCard);
            const result = await checkoutFlow.run({ cartId: 'c1', discount: -10 });

            expect(result.subtotal).to.equal(100);
            expect(result.tax).to.equal(8);
            expect(result.total).to.equal(108);
            expect(result.charged).to.be.true;
            expect(result.receiptCopy).to.equal('PAID:108:SUB:100');
            expect(result.$steps.calculateTotals).to.deep.equal({ tax: 8, total: 108 });
        });

        it('works inside parallel, all, allSettled, race, when, branch, and map combinators', async () => {
            const scoreA = Step.compute('scoreA', (ctx: { x: number }) => ({ a: ctx.x + 1 }));
            const scoreB = Step.compute('scoreB', (ctx: { x: number }) => ({ b: ctx.x * 10 }));
            const doubleItem = Step.compute('doubleItem', (ctx: { item: number }) => ({ v: ctx.item * 2 }));

            const pRes: any = await flow(parallel(scoreA, scoreB)).run({ x: 3 });
            expect(pRes.a).to.equal(4);
            expect(pRes.b).to.equal(30);

            const allRes: any = await flow(all([scoreA, scoreB])).run({ x: 2 });
            expect(allRes.a).to.equal(3);
            expect(allRes.b).to.equal(20);

            const settledRes: any = await flow(allSettled([scoreA, scoreB])).run({ x: 4 });
            expect(settledRes.scoreA.a).to.equal(5);
            expect(settledRes.scoreB.b).to.equal(40);

            const raceRes: any = await flow(race(scoreA, scoreB)).run({ x: 5 });
            expect(raceRes.a === 6 || raceRes.b === 50).to.be.true;

            const whenRes: any = await flow(when(ctx => ctx.x > 0, scoreA, scoreB)).run({ x: 7 });
            expect(whenRes.a).to.equal(8);

            const branchRes: any = await flow(
                branch(ctx => ctx.mode, {
                    add: scoreA,
                    mul: scoreB,
                }),
            ).run({ mode: 'mul', x: 6 });
            expect(branchRes.b).to.equal(60);

            const mapRes: any = await flow(map([1, 2, 3], doubleItem)).run({});
            expect(mapRes.items).to.deep.equal([{ v: 2 }, { v: 4 }, { v: 6 }]);
            expect(mapRes.count).to.equal(3);
        });
    });

    describe('Synchronous .spec() Engine', () => {
        it('executes default -> require -> validate -> transform -> translate -> schema in exact order', async () => {
            const order: string[] = [];

            const step = Step.compute('orderedSpec', (ctx: any) => ({
                amount: ctx.amount,
                cents: ctx.cents,
                tagged: ctx.tagged,
            })).spec('amount', {
                defaultValue: 10,
                require: () => {
                    order.push('require');
                    return true;
                },
                validator: v => {
                    order.push('validate');
                    return typeof v === 'number' && v >= 0;
                },
                transformer: v => {
                    order.push('transform');
                    return v * 2;
                },
                translator: (v, ctx) => {
                    order.push('translate');
                    ctx!.cents = v * 100;
                },
                schema: (v: number) => {
                    order.push('schema');
                    return v === 20;
                },
            });

            const res = await step.run({});
            expect(order).to.deep.equal(['require', 'validate', 'transform', 'translate', 'schema']);
            expect(res.amount).to.equal(20);
            expect(res.cents).to.equal(2000);
        });

        it('handles require failures, custom requireMessage, and allows 0 / false', async () => {
            const step = Step.compute('reqStep', (ctx: { count: number; flag: boolean }) => ({
                count: ctx.count,
                flag: ctx.flag,
            }))
                .spec('count', { require: true, requireMessage: 'Count is mandatory' })
                .spec('flag', { require: true });

            // 0 and false are valid values
            const ok = await step.run({ count: 0, flag: false });
            expect(ok.count).to.equal(0);
            expect(ok.flag).to.be.false;

            // Missing values fail with ValidationException
            try {
                await step.run({ count: '' } as any);
                expect.fail('Expected ValidationException');
            } catch (err: any) {
                expect(err).to.be.instanceOf(ValidationException);
                expect(err.phase).to.equal(ExecutionPhase.VALIDATION);
                expect(err.stepName).to.equal('reqStep');
                expect(err.retryable).to.be.false;
                expect(err.message).to.include('Count is mandatory');
                expect(err.message).to.include('Field flag is required.');
            }
        });

        it('handles validate returning false, throwing Error, and throwing primitive', async () => {
            const predFail = Step.compute('predFail', (ctx: { x: number }) => ({ x: ctx.x })).spec('x', {
                validate: v => v > 0,
            });
            try {
                await predFail.run({ x: -1 });
                expect.fail('Should fail validation');
            } catch (err: any) {
                expect(err).to.be.instanceOf(ValidationException);
                expect(err.message).to.include('Validation failed for field "x"');
            }

            const throwErr = Step.compute('throwErr', (ctx: { x: number }) => ({ x: ctx.x })).spec('x', {
                validate: () => {
                    throw new Error('custom validate boom');
                },
            });
            try {
                await throwErr.run({ x: 1 });
                expect.fail('Should fail validation');
            } catch (err: any) {
                expect(err).to.be.instanceOf(ValidationException);
                expect(err.message).to.include('custom validate boom');
            }

            const throwPrim = Step.compute('throwPrim', (ctx: { x: number }) => ({ x: ctx.x })).spec('x', {
                validate: () => {
                    throw 'raw-string-error';
                },
            });
            try {
                await throwPrim.run({ x: 1 });
                expect.fail('Should fail validation');
            } catch (err: any) {
                expect(err).to.be.instanceOf(ValidationException);
                expect(err.message).to.include('raw-string-error');
            }
        });

        it('supports transform, translate, and skips them when field is undefined', async () => {
            const step = Step.compute('optTransform', (ctx: any) => ({
                label: ctx.label,
                upper: ctx.upper,
            })).spec('label', {
                transform: (v: string) => v.trim(),
                translate: (v: string, ctx) => {
                    ctx!.upper = v.toUpperCase();
                },
            });

            const skipped = await step.run({});
            expect(skipped.label).to.be.undefined;
            expect(skipped.upper).to.be.undefined;

            const applied = await step.run({ label: '  hello  ' });
            expect(applied.label).to.equal('hello');
            expect(applied.upper).to.equal('HELLO');
        });

        it('supports synchronous Standard Schema, safeParse, parse, validate, and predicate schemas', async () => {
            // 1. Standard Schema (~standard) — root & field + failure
            const stdRoot = {
                '~standard': {
                    version: 1,
                    vendor: 'test',
                    validate: (v: any) => ({ value: { ...v, normalized: true } }),
                },
            };
            const stdField = {
                '~standard': {
                    version: 1,
                    vendor: 'test',
                    validate: (v: string) => ({ value: v.toUpperCase() }),
                },
            };
            const sStd = Step.compute('stdStep', (ctx: any) => ({
                code: ctx.code,
                normalized: ctx.normalized,
            }))
                .spec(stdRoot)
                .spec('code', stdField);
            const rStd = await sStd.run({ code: 'abc' });
            expect(rStd.code).to.equal('ABC');
            expect(rStd.normalized).to.be.true;

            const sStdFail = Step.compute('stdFail', (ctx: any) => ctx).spec('age', {
                '~standard': {
                    version: 1,
                    vendor: 'test',
                    validate: () => ({
                        issues: [{ path: ['age'], message: 'Too young' }, { message: '' }],
                    }),
                },
            });
            try {
                await sStdFail.run({ age: 12 });
                expect.fail('Should fail');
            } catch (err: any) {
                expect(err).to.be.instanceOf(ValidationException);
                expect(err.message).to.include('age: Too young');
                expect(err.message).to.include('Validation failed');
            }

            // 2. safeParse (Zod-like) — root, field, failure with issues, error.message, and default message
            const sSafe = Step.compute('safeStep', (ctx: any) => ({
                email: ctx.email,
                verified: ctx.verified,
            }))
                .spec({
                    safeParse: (v: any) => ({ success: true, data: { ...v, verified: true } }),
                })
                .spec('email', {
                    safeParse: (v: string) => ({ success: true, data: v.toLowerCase() }),
                });
            const rSafe = await sSafe.run({ email: 'TEST@EXAMPLE.COM' });
            expect(rSafe.email).to.equal('test@example.com');
            expect(rSafe.verified).to.be.true;

            for (const failSchema of [
                { safeParse: () => ({ success: false, error: { issues: [{ path: ['x'], message: 'bad x' }] } }) },
                { safeParse: () => ({ success: false, error: { message: 'direct safeParse err' } }) },
                { safeParse: () => ({ success: false }) },
            ]) {
                const sFail = Step.compute('safeFail', (c: any) => c).spec('x', failSchema);
                try {
                    await sFail.run({ x: 1 });
                    expect.fail('Should fail');
                } catch (err: any) {
                    expect(err).to.be.instanceOf(ValidationException);
                }
            }

            // 3. parse() — root, field, throw
            const sParse = Step.compute('parseStep', (ctx: any) => ({ n: ctx.n, extra: ctx.extra }))
                .spec({ parse: (v: any) => ({ ...v, extra: 1 }) })
                .spec('n', { parse: (v: number) => v + 10 });
            const rParse = await sParse.run({ n: 5 });
            expect(rParse.n).to.equal(15);
            expect(rParse.extra).to.equal(1);

            const sParseFail = Step.compute('parseFail', (c: any) => c).spec('n', {
                parse: () => {
                    throw new Error('parse boom');
                },
            });
            try {
                await sParseFail.run({ n: 1 });
                expect.fail('Should fail');
            } catch (err: any) {
                expect(err).to.be.instanceOf(ValidationException);
                expect(err.message).to.include('parse boom');
            }

            // 4. validate() schema — root, field, throw
            const sVal = Step.compute('valStep', (ctx: any) => ({ flag: ctx.flag, ok: ctx.ok }))
                .spec({ validate: (v: any) => ({ ...v, ok: true }) })
                .spec('flag', { schema: { validate: (v: boolean) => !v } });
            const rVal = await sVal.run({ flag: false });
            expect(rVal.flag).to.be.true;
            expect(rVal.ok).to.be.true;

            const sValFail = Step.compute('valFail', (c: any) => c).spec('flag', {
                schema: {
                    validate: () => {
                        throw new Error('validate schema boom');
                    },
                },
            });
            try {
                await sValFail.run({ flag: true });
                expect.fail('Should fail');
            } catch (err: any) {
                expect(err).to.be.instanceOf(ValidationException);
                expect(err.message).to.include('validate schema boom');
            }

            // 5. Function predicate schema — pass & fail
            const sPred = Step.compute('predSchema', (ctx: any) => ({ code: ctx.code })).spec('code', {
                schema: (v: number) => v === 42,
            });
            expect((await sPred.run({ code: 42 })).code).to.equal(42);
            try {
                await sPred.run({ code: 99 });
                expect.fail('Should fail');
            } catch (err: any) {
                expect(err).to.be.instanceOf(ValidationException);
                expect(err.message).to.include('Validation failed for field "code"');
            }

            // 6. SyncSpec direct edge cases (empty field, empty schema, non-object input, schema returning undefined)
            expect(() => new SyncSpec('')).to.throw('Field name is required.');
            const emptySchemaSpec = new SyncSpec('f');
            emptySchemaSpec.schema(undefined);
            expect(runSpecsSync([emptySchemaSpec], null as any, 'edge')).to.deep.equal({});

            const undefValSpec = new SyncSpec('f');
            undefValSpec.schema({ parse: () => undefined });
            expect(runSpecsSync([undefValSpec], { f: 1 }, 'edge')).to.deep.equal({ f: 1 });
        });

        it('rejects async callbacks and async schemas at runtime with ValidationException', async () => {
            const cases: Array<{ label: string; step: ComputeStep }> = [
                {
                    label: 'async require',
                    step: Step.compute('aReq', (c: any) => c).spec('x', {
                        require: (async () => true) as any,
                    }),
                },
                {
                    label: 'async validate',
                    step: Step.compute('aVal', (c: any) => c).spec('x', {
                        validate: (async () => true) as any,
                    }),
                },
                {
                    label: 'async transform',
                    step: Step.compute('aTrans', (c: any) => c).spec('x', {
                        transform: (async (v: any) => v) as any,
                    }),
                },
                {
                    label: 'async translate',
                    step: Step.compute('aTlate', (c: any) => c).spec('x', {
                        translate: (async () => {}) as any,
                    }),
                },
                {
                    label: 'async ~standard schema',
                    step: Step.compute('aStd', (c: any) => c).spec('x', {
                        '~standard': { version: 1, vendor: 't', validate: async () => ({ value: 1 }) },
                    }),
                },
                {
                    label: 'async safeParse schema',
                    step: Step.compute('aSafe', (c: any) => c).spec('x', {
                        safeParse: async () => ({ success: true, data: 1 }),
                    }),
                },
                {
                    label: 'async parse schema',
                    step: Step.compute('aParse', (c: any) => c).spec('x', {
                        parse: async () => 1,
                    }),
                },
                {
                    label: 'async validate schema',
                    step: Step.compute('aValSchema', (c: any) => c).spec('x', {
                        schema: { validate: async () => 1 },
                    }),
                },
                {
                    label: 'async predicate schema',
                    step: Step.compute('aPredSchema', (c: any) => c).spec('x', {
                        schema: async () => true,
                    }),
                },
                {
                    label: 'rejected Promise thenable in validate',
                    step: Step.compute('aRejVal', (c: any) => c).spec('x', {
                        validate: (() => Promise.reject(new Error('ignored'))) as any,
                    }),
                },
            ];

            for (const c of cases) {
                try {
                    await c.step.run({ x: 1 });
                    expect.fail(`Expected async rejection for ${c.label}`);
                } catch (err: any) {
                    expect(err, c.label).to.be.instanceOf(ValidationException);
                    expect(err.phase, c.label).to.equal(ExecutionPhase.VALIDATION);
                    expect(err.retryable, c.label).to.be.false;
                    expect(err.message, c.label).to.include('forbidden in Step.compute');
                }
            }
        });
    });

    describe('Synchronous In-Memory .cache() Memoization', () => {
        it('shares cross-run hits, respects post-.spec() normalization, and isolates by namespace', async () => {
            let calls = 0;
            const calc = Step.compute('calcTotals', (ctx: { subtotal: number; discount: number }) => {
                calls++;
                return { total: ctx.subtotal - ctx.discount };
            })
                .spec('discount', { default: 0, transform: v => Math.max(0, Number(v)) })
                .cache('5m');

            expect(calc.cachedLast).to.equal(300000);

            const wf = flow(calc);

            // Run 1: discount omitted -> defaults to 0
            const r1 = await wf.run({ subtotal: 100 });
            expect(r1.total).to.equal(100);
            expect(calls).to.equal(1);

            // Run 2 (different stackId): explicit discount: 0 -> same post-.spec() key -> HIT!
            const r2 = await wf.run({ subtotal: 100, discount: 0 });
            expect(r2.total).to.equal(100);
            expect(calls).to.equal(1);

            // Run 3: negative discount transformed to 0 -> same normalized key -> HIT!
            const r3 = await wf.run({ discount: -5, subtotal: 100 });
            expect(r3.total).to.equal(100);
            expect(calls).to.equal(1);

            // Run 4: different namespace -> MISS!
            const r4 = await wf.run({ subtotal: 100 }, { namespace: 'tenant-a' });
            expect(r4.total).to.equal(100);
            expect(calls).to.equal(2);

            // Run 5: same namespace -> HIT!
            const r5 = await wf.run({ subtotal: 100 }, { namespace: 'tenant-a' });
            expect(r5.total).to.equal(100);
            expect(calls).to.equal(2);

            // Run 6: another namespace -> MISS!
            const r6 = await wf.run({ subtotal: 100 }, { namespace: 'tenant-b' });
            expect(r6.total).to.equal(100);
            expect(calls).to.equal(3);

            // clearStorage() clears compute caches
            clearStorage();
            const r7 = await wf.run({ subtotal: 100 });
            expect(r7.total).to.equal(100);
            expect(calls).to.equal(4);
        });

        it('supports map() batch hits with custom keySerializer and enforces LRU maxEntries + TTL expiration', async () => {
            let calls = 0;
            const scoreItem = Step.compute('scoreItem', (ctx: { item: string }) => {
                calls++;
                return { score: ctx.item.length * 10 };
            }).cache({
                ttl: 30,
                maxEntries: 2,
                keySerializer: (_stepId, p) => String(p.item),
            });

            expect(scoreItem.cachedLast).to.equal(30);
            expect(scoreItem.cacheOptions?.maxEntries).to.equal(2);

            // Duplicate items in map() hit cache synchronously
            const batch = await flow(map(['aa', 'bbb', 'aa', 'bbb'], scoreItem, { concurrency: 1 })).run({});
            expect(batch.items).to.deep.equal([{ score: 20 }, { score: 30 }, { score: 20 }, { score: 30 }]);
            expect(calls).to.equal(2);

            // Touch 'aa' so 'bbb' becomes the LRU entry, then insert 'cccc' -> evicts 'bbb'
            await scoreItem.run({ item: 'aa' });
            expect(calls).to.equal(2);

            await scoreItem.run({ item: 'cccc' });
            expect(calls).to.equal(3);

            // 'aa' is still cached
            await scoreItem.run({ item: 'aa' });
            expect(calls).to.equal(3);

            // 'bbb' was evicted -> recomputes
            await scoreItem.run({ item: 'bbb' });
            expect(calls).to.equal(4);

            // Wait past 30ms TTL -> expires and recomputes
            await new Promise(r => setTimeout(r, 45));
            await scoreItem.run({ item: 'bbb' });
            expect(calls).to.equal(5);
        });

        it('never invokes external StorageAdapter getCachedStep/setCachedStep even when registered', async () => {
            let externalReads = 0;
            let externalWrites = 0;
            useStorage({
                name: 'spy-redis',
                getCachedStep: async () => {
                    externalReads++;
                    throw new Error('ComputeStep must never call external getCachedStep');
                },
                setCachedStep: async () => {
                    externalWrites++;
                    throw new Error('ComputeStep must never call external setCachedStep');
                },
            });

            let calls = 0;
            const pure = Step.compute('pureMemo', (ctx: { n: number }) => {
                calls++;
                return { sq: ctx.n * ctx.n };
            }).cache(); // default 1500ms TTL

            expect(pure.cachedLast).to.equal(1500);

            const r1 = await pure.run({ n: 9 });
            const r2 = await pure.run({ n: 9 });
            expect(r1.sq).to.equal(81);
            expect(r2.sq).to.equal(81);
            expect(calls).to.equal(1);
            expect(externalReads).to.equal(0);
            expect(externalWrites).to.equal(0);
        });

        it('emits cache:miss and cache:hit events and sets StepExecutionContext.cacheHit', async () => {
            const events: WorkflowExecutionEvent[] = [];
            const hookCacheHits: Array<boolean | undefined> = [];

            const hook: StepExecutionHook = (ctx, next) => {
                const res = next();
                hookCacheHits.push(ctx.cacheHit);
                return res;
            };

            const cached = Step.compute('trackedCompute', (ctx: { v: number }) => ({ out: ctx.v + 1 })).cache('1m');
            const wf = flow(cached)
                .hook(hook)
                .monitor(e => events.push(e));

            await wf.run({ v: 1 });
            await wf.run({ v: 1 });

            expect(hookCacheHits).to.deep.equal([false, true]);
            const cacheTypes = events.filter(e => e.type === 'cache:hit' || e.type === 'cache:miss').map(e => e.type);
            expect(cacheTypes).to.deep.equal(['cache:miss', 'cache:hit']);
        });

        it('rejects async keySerializer and covers ComputeCache direct API edge cases', async () => {
            const asyncKeyStep = Step.compute('asyncKey', (ctx: { x: number }) => ({ x: ctx.x })).cache({
                keySerializer: (async () => 'k') as any,
            });

            try {
                await asyncKeyStep.run({ x: 1 });
                expect.fail('Should reject async keySerializer');
            } catch (err: any) {
                expect(err).to.be.instanceOf(SigloError);
                expect(err.retryable).to.be.false;
                expect(err.message).to.include('keySerializer');
            }

            // Direct ComputeCache API checks (primitive input, internal key stripping, overwrite existing key, clear, size, TTL expiry cleanup)
            const c = new ComputeCache({ ttl: 15, maxEntries: 2 });
            expect(c.buildKey('s', 42)).to.equal('s:42');
            expect(
                c.buildKey('s', {
                    x: 42,
                    $steps: () => ({}),
                    $history: () => ({}),
                    $stackId: 'stack-1',
                    $namespace: 'ns-ignored',
                    $attempt: 2,
                    $retryDelay: 100,
                    $isDurable: true,
                    $workflowId: 'wf-1',
                }),
            ).to.equal(c.buildKey('s', { x: 42 }));
            c.set('k1', undefined);
            c.set('k1', 'updated');
            expect(c.size).to.equal(1);
            expect(c.get('k1')).to.deep.equal({ hit: true, value: 'updated' });

            await new Promise(r => setTimeout(r, 25));
            expect(c.get('k1')).to.deep.equal({ hit: false });
            expect(c.size).to.equal(0);

            c.set('k2', 2);
            clearComputeCaches();
            expect(c.size).to.equal(0);

            // Default cache options object with no ttl/maxEntries
            const cDefault = new ComputeCache();
            expect(cDefault.ttlMs).to.equal(1500);
            expect(cDefault.maxEntries).to.equal(1000);
        });
    });

    describe('Runtime Sync Guard, Hooks, Monitoring, Sagas & Cancellation', () => {
        it('rejects a ComputeStep action returning a Promise or custom thenable at runtime', async () => {
            const badAsync = Step.compute('badAsync', (async () => ({ nope: true })) as any);
            try {
                await badAsync.run({});
                expect.fail('Should reject Promise return');
            } catch (err: any) {
                expect(err).to.be.instanceOf(SigloError);
                expect(err.retryable).to.be.false;
                expect(err.phase).to.equal(ExecutionPhase.ACTION);
                expect(err.stepName).to.equal('badAsync');
                expect(err.message).to.include(
                    "Step.compute 'badAsync' must be synchronous and cannot return a Promise",
                );
            }

            const badRejected = Step.compute('badRejected', (() => Promise.reject(new Error('async boom'))) as any);
            try {
                await badRejected.run({});
                expect.fail('Should reject Promise return');
            } catch (err: any) {
                expect(err).to.be.instanceOf(SigloError);
                expect(err.message).to.include('must be synchronous');
            }

            const badThenable = Step.compute('badThenable', (() => ({ then: () => {} })) as any);
            try {
                await flow(badThenable).run({});
                expect.fail('Should reject thenable return');
            } catch (err: any) {
                expect(err).to.be.instanceOf(SigloError);
                expect(err.message).to.include("Step.compute 'badThenable' must be synchronous");
            }
        });

        it('gracefully supports third-party async stepExecutionHook in both ArrayChain and StartChain', async () => {
            const seen: string[] = [];
            const asyncHook: StepExecutionHook = async (ctx, next) => {
                seen.push(`before:${ctx.stepName}`);
                const res = await Promise.resolve(next());
                seen.push(`after:${ctx.stepName}`);
                return res;
            };

            const c1 = Step.compute('c1', (ctx: { n: number }) => ({ a: ctx.n + 1 }));
            const c2 = Step.compute('c2', (ctx: { a: number }) => ({ b: ctx.a * 2 }));

            // Multi-step ArrayChain with async hook (both intermediate and final compute steps)
            const rFlow = await flow(c1, c2).hook(asyncHook).run({ n: 5 });
            expect(rFlow.b).to.equal(12);
            expect(seen).to.deep.equal(['before:c1', 'after:c1', 'before:c2', 'after:c2']);

            // Single-step StartChain with async hook
            seen.length = 0;
            const rSingle = await c1.run({ n: 9 }, { stepExecutionHook: asyncHook });
            expect(rSingle.a).to.equal(10);
            expect(seen).to.deep.equal(['before:c1', 'after:c1']);

            // Async hook rejecting inside ArrayChain
            const failingHook: StepExecutionHook = async () => {
                throw new Error('async hook failure');
            };
            try {
                await flow(c1, c2).hook(failingHook).run({ n: 1 });
                expect.fail('Should propagate async hook error');
            } catch (err: any) {
                expect(err.message).to.include('async hook failure');
            }
        });

        it('emits step:start, step:complete, step:error monitoring events and invokes onStepResult', async () => {
            const events: WorkflowExecutionEvent[] = [];
            const observed: Array<{ name: string; output: any }> = [];

            const good = Step.compute('goodCompute', (ctx: { x: number }) => ({ y: ctx.x + 1 }));
            const bad = Step.compute('badCompute', () => {
                throw new Error('compute failure');
            });

            await flow(good).run(
                { x: 10 },
                {
                    monitor: e => events.push(e),
                    onStepResult: (name, output) => observed.push({ name, output }),
                },
            );

            expect(events.map(e => e.type)).to.include.members(['step:start', 'step:complete']);
            expect(observed).to.deep.equal([{ name: 'goodCompute', output: { y: 11 } }]);

            events.length = 0;
            try {
                await flow(bad).run({}, { monitor: e => events.push(e) });
                expect.fail('Should fail');
            } catch (err: any) {
                expect(err.message).to.include('compute failure');
                expect(err.phase).to.equal(ExecutionPhase.ACTION);
                expect(err.stepName).to.equal('badCompute');
            }
            const errEvt = events.find(e => e.type === 'step:error') as any;
            expect(errEvt).to.exist;
            expect(errEvt.stepName).to.equal('badCompute');
            expect(errEvt.error.message).to.equal('compute failure');

            // Primitive throw in compute action
            const primThrow = Step.compute('primThrow', () => {
                throw 'string-failure';
            });
            try {
                await primThrow.run({});
                expect.fail('Should fail');
            } catch (err: any) {
                expect(err.message).to.include('string-failure');
            }
        });

        it('triggers automatic LIFO Saga compensations on upstream steps when a ComputeStep throws', async () => {
            const compensated: string[] = [];

            const reserveInventory = Step.create('reserveInventory', async () => ({
                reservationId: 'res-1',
            })).compensate(async () => {
                compensated.push('reserveInventory');
            });
            const holdFunds = Step.create('holdFunds', async () => ({ holdId: 'hold-1' })).compensate(async () => {
                compensated.push('holdFunds');
            });
            const scoreRisk = Step.compute('scoreRisk', () => {
                throw new Error('Risk threshold exceeded');
            });

            const wf = flow(reserveInventory, holdFunds, scoreRisk);

            try {
                await wf.run({});
                expect.fail('Should have failed at scoreRisk');
            } catch (err: any) {
                expect(err.message).to.include('Risk threshold exceeded');
                expect(err.stepName).to.equal('scoreRisk');
                expect(err.phase).to.equal(ExecutionPhase.ACTION);
            }

            // LIFO rollback of upstream I/O steps
            expect(compensated).to.deep.equal(['holdFunds', 'reserveInventory']);
        });

        it('honors cooperative AbortSignal cancellation immediately', async () => {
            let ran = false;
            const compute = Step.compute('cancellable', () => {
                ran = true;
                return { ok: true };
            });

            const ac1 = new AbortController();
            ac1.abort(new CancellationException('User cancelled'));
            try {
                await compute.run({}, { signal: ac1.signal });
                expect.fail('Should have cancelled');
            } catch (err: any) {
                expect(err).to.be.instanceOf(CancellationException);
                expect(err.message).to.include('User cancelled');
                expect(ran).to.be.false;
            }

            // Direct executeComputeStepSync cancellation with default reason (undefined reason)
            const fakeAbortedSignal = { aborted: true, reason: undefined };
            expect(() => executeComputeStepSync(compute, {}, { signal: fakeAbortedSignal })).to.throw(
                CancellationException,
            );
            expect(() =>
                executeComputeStepSync(compute, {}, { signal: { aborted: true, reason: new Error('custom abort') } }),
            ).to.throw('custom abort');

            // Direct executeComputeStepSync with non-object input and anonymous step
            const anon = Step.compute((n: any) => n);
            expect(executeComputeStepSync(anon, 123)).to.equal(123);
            expect(executeComputeStepSync(anon, [1, 2])).to.deep.equal([1, 2]);
        });
    });

    describe('Exploratory Cross-Feature Interactions & Edge Cases', () => {
        it('isolates cached return values from direct in-place mutations and supports non-plain class instances', () => {
            let buildCalls = 0;
            const fixedDate = new Date('2026-01-01T00:00:00.000Z');
            const buildPayload = Step.compute('buildPayload', (ctx: { userId: string }) => {
                buildCalls++;
                return {
                    tags: ['core', ctx.userId],
                    meta: { attempts: [1], verified: true },
                    createdAt: fixedDate,
                };
            }).cache('5m');

            const out1 = executeComputeStepSync(buildPayload, { userId: 'u1' });
            expect(buildCalls).to.equal(1);
            // Mutate returned arrays and nested objects directly in-place
            out1.tags.push('mutated-in-place');
            out1.meta.attempts.push(999);
            out1.meta.verified = false;

            // Second call with the same input hits the cache; cached value must NOT be poisoned by out1's mutations!
            const out2 = executeComputeStepSync(buildPayload, { userId: 'u1' });
            expect(buildCalls).to.equal(1);
            expect(out2.tags).to.deep.equal(['core', 'u1']);
            expect(out2.meta).to.deep.equal({ attempts: [1], verified: true });
            expect(out2.createdAt).to.equal(fixedDate);

            // Mutating a cache hit result also must not poison subsequent cache hits
            out2.tags.push('second-mutation');
            const out3 = executeComputeStepSync(buildPayload, { userId: 'u1' });
            expect(out3.tags).to.deep.equal(['core', 'u1']);
        });

        it('preserves pre-wait $steps history across durable waitForEvent and resumeWorkflow with multiple ComputeSteps', async () => {
            const preCompute = Step.compute('preCompute', (ctx: { orderId: string; amount: number }) => ({
                tax: Math.round(ctx.amount * 0.1),
                subtotal: ctx.amount,
            }));

            const approvalWait = waitForEvent('manager.approved', {
                correlationKey: (ctx: any) => `order:${ctx.orderId}`,
                timeout: '10m',
            });

            const postCompute1 = Step.compute('postCompute1', (ctx: any) => ({
                totalWithTax: ctx.$steps.preCompute.subtotal + ctx.$steps.preCompute.tax,
                approvedBy: ctx.approver,
            }));

            const postCompute2 = Step.compute('postCompute2', (ctx: any) => ({
                summary: `${ctx.orderId}:${ctx.$steps.preCompute.tax}:${ctx.$steps.postCompute1.totalWithTax}:${ctx.approvedBy}`,
            }));

            const durableFlow = flow(preCompute, approvalWait, postCompute1, postCompute2);

            const suspended: any = await durableFlow.run({ orderId: 'ORD-77', amount: 200 }, { durable: true });
            expect(suspended.status).to.equal('waiting');
            expect(suspended.correlationKey).to.equal('order:ORD-77');

            const resumed: any = await resumeWorkflow(durableFlow, 'order:ORD-77', {
                approver: 'alice',
            });

            expect(resumed.totalWithTax).to.equal(220);
            expect(resumed.summary).to.equal('ORD-77:20:220:alice');
            expect(resumed.$steps.preCompute).to.deep.equal({ tax: 20, subtotal: 200 });
            expect(resumed.$steps.postCompute1).to.deep.equal({ totalWithTax: 220, approvedBy: 'alice' });
            expect(resumed.$steps.postCompute2).to.deep.equal({ summary: 'ORD-77:20:220:alice' });
        });

        it('composes nested sub-flows and Step.create(subFlow) containing ComputeSteps with flow-level idempotency and timeout', async () => {
            let computeRuns = 0;
            const innerA = Step.compute('innerA', (ctx: { base: number }) => {
                computeRuns++;
                return { a: ctx.base + 5 };
            });
            const innerB = Step.compute('innerB', (ctx: { a: number }) => ({
                b: ctx.a * 2,
            }));
            const subFlow = flow(innerA, innerB);
            const wrappedSubFlow = Step.create(subFlow);
            const finalCompute = Step.compute('finalCompute', (ctx: { b: number }) => ({
                final: ctx.b + 1,
            }));

            const masterFlow = flow(wrappedSubFlow, finalCompute).timeout(500);

            // 1. Flow-level idempotency short-circuits repeat runs with identical idempotencyKey
            const res1 = await masterFlow.run({ base: 10 }, { idempotencyKey: 'idem-compute-1' });
            expect(res1.final).to.equal(31);
            expect(computeRuns).to.equal(1);

            const res2 = await masterFlow.run({ base: 999 }, { idempotencyKey: 'idem-compute-1' });
            expect(res2.final).to.equal(31);
            expect(computeRuns).to.equal(1);

            // 2. Direct nested flow(computeA, flow(computeB, computeC))
            const directNested = flow(
                innerA,
                flow(
                    innerB,
                    Step.compute('innerC', (ctx: { b: number }) => ({ c: ctx.b + 100 })),
                ),
            );
            const nestedRes: any = await directNested.run({ base: 3 });
            expect(nestedRes.c).to.equal(116);

            // 3. Flow-level timeout triggers FlowTimeoutException when an async step exceeds budget after ComputeStep
            const slowStep = Step.create('slowStep', async () => {
                await new Promise(r => setTimeout(r, 60));
                return { slow: true };
            });
            const timedFlow = flow(innerA, slowStep, finalCompute).timeout(15);
            try {
                await timedFlow.run({ base: 1 });
                expect.fail('Should have timed out');
            } catch (err: any) {
                expect(err).to.be.instanceOf(FlowTimeoutException);
            }
        });

        it('accumulates multi-field validation failures into a single ValidationException in runSpecsSync', async () => {
            const multiSpecStep = Step.compute('multiSpecStep', (ctx: any) => ctx)
                .spec('email', {
                    require: true,
                    requireMessage: 'Email is required',
                })
                .spec('age', {
                    validate: (v: number) => typeof v === 'number' && v >= 18,
                })
                .spec('code', {
                    safeParse: () => ({
                        success: false,
                        error: { issues: [{ path: ['code'], message: 'Invalid promo code' }] },
                    }),
                });

            try {
                await multiSpecStep.run({ email: '', age: 12, code: 'BAD' });
                expect.fail('Should throw accumulated ValidationException');
            } catch (err: any) {
                expect(err).to.be.instanceOf(ValidationException);
                expect(err.errors).to.have.lengthOf(3);
                expect(err.errors.map((e: any) => e.field)).to.deep.equal(['email', 'age', 'code']);
                expect(err.message).to.include('Email is required');
                expect(err.message).to.include('Validation failed for field "age"');
                expect(err.message).to.include('code: Invalid promo code');
            }
        });

        it('supports ttl: 0 immediate expiry and non-primitive cache keySerializer values', async () => {
            let zeroTtlRuns = 0;
            const zeroTtlStep = Step.compute('zeroTtlStep', (ctx: { x: number }) => {
                zeroTtlRuns++;
                return { out: ctx.x + zeroTtlRuns };
            }).cache({ ttl: 0 });

            const r1 = await zeroTtlStep.run({ x: 10 });
            await new Promise(r => setTimeout(r, 2));
            const r2 = await zeroTtlStep.run({ x: 10 });
            expect(r1.out).to.equal(11);
            expect(r2.out).to.equal(12);
            expect(zeroTtlRuns).to.equal(2);

            let objKeyRuns = 0;
            const objKeyStep = Step.compute('objKeyStep', (ctx: { a: number; b: number }) => {
                objKeyRuns++;
                return { sum: ctx.a + ctx.b };
            }).cache({
                ttl: 5000,
                keySerializer: (_id, ctx) => ({ b: ctx.b, a: ctx.a }) as unknown as string,
            });

            await objKeyStep.run({ a: 1, b: 2 });
            await objKeyStep.run({ a: 1, b: 2 });
            expect(objKeyRuns).to.equal(1);
        });
    });
});
