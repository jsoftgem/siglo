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
});
