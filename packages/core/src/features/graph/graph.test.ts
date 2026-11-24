import { expect } from 'chai';
import {
    Step,
    flow,
    toGraph,
    validateGraph,
    assertValidGraph,
    inspectGraph,
    parallel,
    when,
    branch,
    map,
    waitForEvent,
    wait,
    toJSON,
    toMermaid,
    toDot,
    GraphValidationException,
} from '../../index';

describe('Workflow Graph Model Unit Tests', () => {
    it('toGraph converts steps, flows, arrays, functions, and combinators', () => {
        // Step
        const s1 = Step.create('step1');
        const g1 = toGraph(s1);
        expect(g1.type).to.equal('step');
        expect(g1.name).to.equal('step1');
        expect(g1.id).to.be.a('string');

        // Flow
        const f1 = flow(s1, Step.create('step2'));
        const g2 = toGraph(f1);
        expect(g2.type).to.equal('sequence');
        expect((g2 as any).children).to.have.length(2);

        // Single step flow
        const fSingle = flow(s1);
        const gSingle = toGraph(fSingle);
        expect(gSingle.type).to.equal('step');

        // Array
        const gArr = toGraph([s1, Step.create('step3')]);
        expect(gArr.type).to.equal('sequence');

        const gArrSingle = toGraph([s1]);
        expect(gArrSingle.type).to.equal('step');

        // Plain function
        const fn = function testAction() {};
        const gFn = toGraph(fn);
        expect(gFn.type).to.equal('step');
        expect(gFn.name).to.equal('testAction');

        // Anonymous function
        const gAnon = toGraph(() => {});
        expect(gAnon.type).to.equal('step');

        // Null / undefined
        const gNull = toGraph(null);
        expect(gNull.type).to.equal('step');
        expect(gNull.name).to.equal('empty');

        // Primitive string
        const gStr = toGraph('myString');
        expect(gStr.type).to.equal('step');
        expect(gStr.name).to.equal('myString');

        // Combinators
        const p = parallel(s1, Step.create('p2'));
        const gp = toGraph(p);
        expect(gp.type).to.equal('parallel');
        expect(gp.metadata?.runtimeStepId).to.equal(p.$stepId);

        const w = when(() => true, s1);
        const gw = toGraph(w);
        expect(gw.type).to.equal('branch');
        expect(gw.metadata?.runtimeStepId).to.equal(w.$stepId);

        const m = map([1, 2], s1);
        const gm = toGraph(m);
        expect(gm.type).to.equal('map');
        expect(gm.metadata?.runtimeStepId).to.equal(m.$stepId);

        const waitStep = waitForEvent('test.event', { correlationKey: 'k1' });
        const gWait = toGraph(waitStep);
        expect(gWait.type).to.equal('wait');

        // Sequence inside step
        const sSeq = Step.create('seqStep', () => {}, [s1, Step.create('subStep')]);
        const gSeq = toGraph(sSeq);
        expect(gSeq.type).to.equal('sequence');
    });

    it('Step and Flow instance methods .toGraph() and .inspect() work', () => {
        const s = Step.create('myStep');
        expect(s.toGraph().name).to.equal('myStep');
        const sInspection = s.inspect();
        expect(sInspection.totalNodes).to.equal(1);

        const f = flow(s);
        expect(f.toGraph().type).to.equal('step');
        const fInspection = f.inspect();
        expect(fInspection.totalNodes).to.equal(1);
    });

    it('validateGraph and assertValidGraph validate valid graphs', () => {
        const validFlow = flow(
            Step.create('s1'),
            parallel(Step.create('p1'), Step.create('p2')),
            when(() => true, Step.create('then1'), Step.create('else1')),
            branch(
                {
                    optA: Step.create('a'),
                    optB: Step.create('b'),
                },
                Step.create('def'),
            ),
            map([1, 2], Step.create('itemProcess'), { concurrency: 2 }),
            waitForEvent('approved', { correlationKey: 'order-1', timeoutMs: 5000 }),
            wait(100),
        );

        const graph = validFlow.toGraph();
        const res = validateGraph(graph);
        expect(res.valid).to.be.true;
        expect(res.errors).to.have.length(0);

        expect(() => assertValidGraph(graph)).to.not.throw();
    });

    it('validates dynamic wait and waitForEvent nodes and exports clean toJSON without functions', () => {
        const dynamicWaitFlow = flow(
            Step.create('prepare', () => ({ delay: '5m', sla: '1h', orderId: 'o-1' })),
            wait(ctx => ctx.delay),
            wait(0),
            waitForEvent('approval.requested', {
                correlationKey: ctx => ctx.orderId,
                timeout: ctx => ctx.sla,
            }),
            waitForEvent('static.event', {
                correlationKey: 'static-k',
                timeout: '30m',
            }),
        );

        const graph = dynamicWaitFlow.toGraph();
        const validation = validateGraph(graph);
        expect(validation.valid).to.be.true;
        expect(validation.errors).to.have.length(0);
        expect(() => assertValidGraph(graph)).to.not.throw();

        const jsonStr = toJSON(dynamicWaitFlow);
        const parsed = JSON.parse(jsonStr);
        expect(parsed.type).to.equal('sequence');
        expect(parsed.children).to.have.length(5);

        const dynamicTimerNode = parsed.children[1];
        expect(dynamicTimerNode.type).to.equal('wait');
        expect(dynamicTimerNode.name).to.equal('wait:dynamic');
        expect(dynamicTimerNode.durationMs).to.be.undefined;
        expect(dynamicTimerNode.duration).to.be.undefined;

        const dynamicEventNode = parsed.children[3];
        expect(dynamicEventNode.type).to.equal('wait');
        expect(dynamicEventNode.eventName).to.equal('approval.requested');
        expect(dynamicEventNode.correlationKey).to.be.undefined;
        expect(dynamicEventNode.timeout).to.be.undefined;

        const staticEventNode = parsed.children[4];
        expect(staticEventNode.timeoutMs).to.equal(1800000);
    });

    it('validateGraph catches structural defects and throws GraphValidationException', () => {
        // Null node
        const res1 = validateGraph(null as any);
        expect(res1.valid).to.be.false;

        // Invalid node id
        const res2 = validateGraph({ id: '', name: 'n', type: 'step' });
        expect(res2.valid).to.be.false;

        // Invalid node type
        const res3 = validateGraph({ id: '1', name: 'n', type: 'invalid' as any });
        expect(res3.valid).to.be.false;

        // Empty sequence
        const res4 = validateGraph({ id: '2', name: 's', type: 'sequence', children: [] });
        expect(res4.valid).to.be.false;

        // Empty parallel branches
        const res5 = validateGraph({ id: '3', name: 'p', type: 'parallel', branches: [] });
        expect(res5.valid).to.be.false;

        // Empty branch targets
        const res6 = validateGraph({ id: '4', name: 'b', type: 'branch', branches: {} });
        expect(res6.valid).to.be.false;

        // Map with missing itemNode and non-positive concurrency
        const res7 = validateGraph({ id: '5', name: 'm', type: 'map', itemNode: null as any, concurrency: -1 });
        expect(res7.valid).to.be.false;
        expect(res7.errors.some(e => e.includes('concurrency'))).to.be.true;

        // Wait node without eventName or duration
        const res8 = validateGraph({ id: '6', name: 'w', type: 'wait' });
        expect(res8.valid).to.be.false;

        expect(() => {
            assertValidGraph({ id: '7', name: 'p', type: 'parallel', branches: [] });
        }).to.throw(GraphValidationException);
    });

    it('detects cycles in workflow graphs', () => {
        const cycleNode: any = {
            id: 'node-cycle-1',
            name: 'cycle1',
            type: 'sequence',
            children: [],
        };
        const childNode: any = {
            id: 'node-cycle-2',
            name: 'cycle2',
            type: 'sequence',
            children: [cycleNode], // points back to cycleNode
        };
        cycleNode.children.push(childNode);

        const res = validateGraph(cycleNode);
        expect(res.valid).to.be.false;
        expect(res.errors.some(e => e.includes('Cycle detected'))).to.be.true;
    });

    it('inspectGraph traverses nodes, edges, entries, and exits accurately', () => {
        const f = flow(
            Step.create('step1'),
            parallel(Step.create('branchA'), Step.create('branchB')),
            branch(
                ctx => ctx.kind,
                {
                    fast: Step.create('fastStep'),
                    slow: flow(Step.create('slow1'), Step.create('slow2')),
                },
                Step.create('defaultStep'),
            ),
            map([1, 2], Step.create('processItem')),
            waitForEvent('done', { correlationKey: 'k' }),
        );

        const inspection = inspectGraph(f);
        expect(inspection.totalNodes).to.be.greaterThan(5);
        expect(inspection.edges.length).to.be.greaterThan(0);
        expect(inspection.entryNodeId).to.be.a('string');
        expect(inspection.exitNodeIds).to.be.an('array');
        expect(inspection.exitNodeIds.length).to.be.at.least(1);

        // Verify edge labels
        const labels = inspection.edges.map(e => e.label);
        expect(labels.some(l => l?.includes('branch-'))).to.be.true;
        expect(labels.some(l => l?.includes('when:'))).to.be.true;
    });
    it('handles toGraph on existing WorkflowNode and DAG diamond structures in validateGraph', () => {
        const existingNode = { id: 'custom-node', type: 'step' as const, name: 'custom' };
        expect(toGraph(existingNode)).to.equal(existingNode);

        const sharedExit = { id: 'shared-exit', type: 'step' as const, name: 'exit' };
        const diamondParallel = {
            id: 'diamond-par',
            type: 'parallel' as const,
            name: 'diamond',
            branches: [
                { id: 'b1', type: 'sequence' as const, name: 'seq1', children: [sharedExit] },
                { id: 'b2', type: 'sequence' as const, name: 'seq2', children: [sharedExit] },
            ],
        };
        const validDiamond = validateGraph(diamondParallel);
        expect(validDiamond.valid).to.be.true;
    });

    it('toGraph, toMermaid, toDot, and toJSON expose ComputeStep metadata and always-deny network policy', () => {
        const ioStep = Step.create('fetchCart', async () => ({ subtotal: 100 }));
        const calcStep = Step.compute('calculateTotals', (ctx: { subtotal: number }) => ({
            total: ctx.subtotal,
        })).cache({ ttl: '5m', maxEntries: 500 });
        const anonCompute = Step.compute(() => ({ ok: true }));

        const computeNode = toGraph(calcStep);
        expect(computeNode.type).to.equal('step');
        expect(computeNode.name).to.equal('calculateTotals');
        expect(computeNode.metadata?.compute).to.be.true;
        expect(computeNode.metadata?.cachedLast).to.equal(300000);
        expect(computeNode.metadata?.cacheOptions).to.deep.equal({ ttl: '5m', maxEntries: 500 });
        expect(computeNode.metadata?.networkPolicy).to.deep.equal({
            enabled: true,
            defaultPolicy: 'deny',
            allowedHosts: [],
            allowLocalhost: false,
        });
        expect((computeNode as any).step).to.equal(calcStep);

        expect(toGraph(anonCompute).name).to.equal('step');

        const mixedFlow = flow(ioStep, calcStep);
        expect(validateGraph(toGraph(mixedFlow)).valid).to.be.true;
        const inspection = inspectGraph(mixedFlow);
        expect(inspection.totalNodes).to.equal(3);

        const mermaid = toMermaid(mixedFlow);
        expect(mermaid).to.include('calculateTotals');
        expect(mermaid).to.include('compute');
        expect(mermaid).to.include('cache');

        const dot = toDot(mixedFlow);
        expect(dot).to.include('calculateTotals');
        expect(dot).to.include('compute');

        const jsonStr = toJSON(mixedFlow);
        const parsed = JSON.parse(jsonStr);
        expect(parsed.children[1].metadata.compute).to.be.true;
        expect(parsed.children[1].metadata.networkPolicy.defaultPolicy).to.equal('deny');
        expect(jsonStr).to.not.include('"step":');
    });
});
