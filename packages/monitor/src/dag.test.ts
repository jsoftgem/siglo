import { describe, it } from 'mocha';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { flow, Step, parallel, race, when, branch, map, WorkflowEventEmitter, setDefaultMonitor } from '@siglo/core';
import { WorkflowExecutionStore } from './store';
import {
    layoutWorkflow,
    matchSteps,
    routeHighlights,
    NODE_HEIGHT,
    NODE_WIDTH,
} from '../ui/src/components/workflows/Dag/layout';
import { DagView } from '../ui/src/components/workflows/Dag/DagView';
import { createOrderRoutingWorkflow } from '../../../examples/src/kafka-order-routing/workflow';

describe('live workflow graph', () => {
    for (const giftWrap of [false, true]) {
        it(`highlights the ${giftWrap ? 'then action' : 'else bypass'} before shipOrder, independently of captured output`, async () => {
            const events: any[] = [];
            const emitter = new WorkflowEventEmitter().on('*', event => {
                events.push(event);
            });
            setDefaultMonitor(emitter);
            try {
                await createOrderRoutingWorkflow(async outcome => outcome)
                    .monitor(emitter)
                    .run(
                        {
                            eventId: 'route',
                            type: 'order.placed',
                            orderId: 'order',
                            tenant: 'test',
                            amountCents: 5000,
                            giftWrap,
                        },
                        { pojo: true },
                    );
                // Replay the event stream with application content removed, as for ecosystem steps.
                const store = new WorkflowExecutionStore();
                for (const event of events)
                    store.addEvent(
                        event.type === 'step:complete' ? { ...event, outputSummary: '[Content not captured]' } : event,
                    );
                const run = store.getRun(events[0].stackId)!;
                const graph = layoutWorkflow(run.ast);
                const matches = matchSteps(graph.nodes, run.steps);
                const highlights = routeHighlights(graph, matches);
                const optional = graph.nodes.find(node => node.name === 'wrapGift')!;
                const bypass = graph.nodes.find(node => node.kind === 'skip')!;
                assert.equal(highlights.nodes.get(optional.key), giftWrap ? 'taken' : 'skipped');
                assert.equal(highlights.nodes.get(bypass.key), giftWrap ? 'skipped' : 'taken');
                const splitEdge = graph.edges.findIndex(edge => edge.to === bypass.key);
                assert.equal(highlights.edges[splitEdge], giftWrap ? 'skipped' : 'taken');
                const ship = graph.nodes.find(node => node.name === 'shipOrder')!;
                assert.equal(matches.get(ship.key)?.status, 'COMPLETED');
                assert.ok(graph.edges.some((edge, i) => edge.to === ship.key && highlights.edges[i] === 'taken'));
                const decisions = events.filter(event => event.type === 'branch:selected');
                assert.equal(decisions.length, 3);
                assert.deepEqual(
                    decisions.map(event => event.route),
                    ['order.placed', 'else', giftWrap ? 'then' : 'else'],
                );
                assert.ok(
                    events.indexOf(decisions[2]) <
                        events.findIndex(
                            event =>
                                event.type === 'step:start' && event.stepName === (giftWrap ? 'wrapGift' : 'shipOrder'),
                        ),
                );
                const html = renderToStaticMarkup(createElement(DagView, { ast: run.ast, steps: run.steps }));
                assert.ok(html.includes('data-route-state="taken"'));
                assert.ok(html.includes('Not taken'));
                assert.ok(!html.includes('Merge route'));
            } finally {
                setDefaultMonitor(undefined);
            }
        });
    }

    it('retains a selected route when its action fails', async () => {
        const store = new WorkflowExecutionStore();
        const emitter = new WorkflowEventEmitter().on('*', event => store.addEvent(event));
        const action = Step.create('failure', () => {
            throw new Error('failed');
        });
        const workflow = flow(when(() => true, action));
        await assert.rejects(workflow.run({}, { monitor: emitter, stackId: 'failed-route' }));
        const run = store.getRun('failed-route')!;
        const graph = layoutWorkflow(run.ast);
        const highlights = routeHighlights(graph, matchSteps(graph.nodes, run.steps));
        assert.equal(highlights.nodes.get(graph.nodes.find(node => node.name === 'failure')!.key), 'taken');
        assert.equal(run.steps[workflow.steps[0].$stepId!].selectedRoute, 'then');
    });

    it('uses older output metadata for a completed bypass and clears decisions on retry', () => {
        const control = when(() => false, Step.create('optional'));
        const graph = layoutWorkflow(control.toGraph());
        const step = {
            stepId: control.$stepId!,
            stepName: 'when',
            status: 'COMPLETED' as const,
            outputSummary: { $skipped: true, $skippedBranches: ['then'] },
        };
        const matches = matchSteps(graph.nodes, { [step.stepId]: step });
        assert.equal(
            routeHighlights(graph, matches).nodes.get(graph.nodes.find(node => node.kind === 'skip')!.key),
            'taken',
        );
        const store = new WorkflowExecutionStore();
        store.addEvent({
            type: 'branch:selected',
            stackId: 'retry',
            timestamp: 1,
            stepId: step.stepId,
            stepName: 'when',
            route: 'else',
        });
        store.addEvent({
            type: 'step:start',
            stackId: 'retry',
            timestamp: 2,
            stepId: step.stepId,
            stepName: 'when',
            attempt: 2,
        });
        assert.equal(store.getRun('retry')!.steps[step.stepId].selectedRoute, undefined);
    });

    it('retains the root definition when nested flows start on the same stack', async () => {
        const store = new WorkflowExecutionStore();
        const starts: any[] = [];
        const emitter = new WorkflowEventEmitter().on('*', event => {
            if (event.type === 'flow:start') starts.push(event);
            store.addEvent(event);
        });
        setDefaultMonitor(emitter);
        try {
            const workflow = createOrderRoutingWorkflow(async outcome => outcome).monitor(emitter);
            await workflow.run(
                {
                    eventId: 'e1',
                    type: 'order.placed',
                    orderId: 'o1',
                    tenant: 'test',
                    amountCents: 5000,
                    giftWrap: true,
                },
                { pojo: true },
            );
            assert.ok(starts.length > 1);
            assert.equal(new Set(starts.map(event => event.stackId)).size, 1);
            const run = store.getRun(starts[0].stackId)!;
            assert.deepEqual(run.ast, starts[0].ast);
            const graph = layoutWorkflow(run.ast);
            const matches = matchSteps(graph.nodes, run.steps);
            const controls = graph.nodes.filter(node => node.name === 'when');
            assert.equal(controls.length, 2);
            assert.notEqual(matches.get(controls[0].key)?.stepId, matches.get(controls[1].key)?.stepId);
            assert.ok(controls.every(node => matches.get(node.key)?.status === 'COMPLETED'));
            assert.equal(matches.size, Object.keys(run.steps).length);
            const html = renderToStaticMarkup(createElement(DagView, { steps: run.steps, ast: run.ast }));
            for (const label of [
                'order.placed',
                'order.cancelled',
                'default',
                'then',
                'else',
                'wrapGift',
                'queueReview',
                'Not taken',
            ]) {
                assert.ok(html.includes(label), `missing ${label}`);
            }
            assert.ok(!html.includes('Other observed steps'));
            assert.ok(!html.includes('Merge route'));
        } finally {
            setDefaultMonitor(undefined);
        }
    });

    for (const mode of ['parallel', 'race', 'map'] as const) {
        it(`lays out ${mode} fan-out and fan-in before the following step`, () => {
            const a = Step.create('a', async () => ({}));
            const b = Step.create('b', async () => ({}));
            const control =
                mode === 'parallel' ? parallel(a, b) : mode === 'race' ? race(a, b) : map([1, 2], flow(a, b));
            const graph = layoutWorkflow(flow(control, Step.create('after')).toGraph());
            const split = graph.nodes.find(node => node.name === mode)!;
            const join = graph.nodes.find(node => node.kind === 'join')!;
            const after = graph.nodes.find(node => node.name === 'after')!;
            const outgoing = graph.edges.filter(edge => edge.from === split.key);
            assert.equal(outgoing.length, mode === 'map' ? 1 : 2);
            assert.equal(graph.edges.filter(edge => edge.to === join.key).length, mode === 'map' ? 1 : 2);
            assert.ok(graph.edges.some(edge => edge.from === join.key && edge.to === after.key));
            assert.ok(after.y > join.y);
            assert.equal(
                join.name,
                mode === 'race' ? 'First result' : mode === 'map' ? 'Collect results' : 'Wait for all',
            );
            if (mode !== 'map') {
                const lanes = outgoing.map(edge => graph.nodes.find(node => node.key === edge.to)!);
                assert.equal(lanes[0].y, lanes[1].y);
                assert.notEqual(lanes[0].x, lanes[1].x);
            }
            // No cards overlap, including nested sequences and joins.
            for (let i = 0; i < graph.nodes.length; i++) {
                for (const other of graph.nodes.slice(i + 1)) {
                    const node = graph.nodes[i];
                    assert.ok(Math.abs(node.x - other.x) >= NODE_WIDTH || Math.abs(node.y - other.y) >= NODE_HEIGHT);
                }
            }
        });
    }

    it('shows implicit skip, explicit else, and fallback routes without inventing executed status', () => {
        const ast = flow(
            when(() => true, Step.create('yes')),
            when(() => false, Step.create('yes'), Step.create('no')),
            branch(() => 'a', { a: Step.create('a') }, Step.create('fallback')),
        ).toGraph();
        const graph = layoutWorkflow(ast);
        assert.equal(graph.nodes.filter(node => node.kind === 'skip').length, 1);
        assert.equal(graph.edges.filter(edge => edge.label === 'else').length, 2);
        assert.ok(graph.edges.some(edge => edge.label === 'default'));
        const html = renderToStaticMarkup(createElement(DagView, { steps: {}, ast }));
        assert.ok(html.includes('Continue without action'));
        assert.ok(html.includes('Not observed'));
        assert.ok(!html.includes('In progress'));
    });

    it('matches repeated names by ID and avoids ambiguous legacy name matches', () => {
        const a = Step.create('same');
        const b = Step.create('same');
        const nodes = layoutWorkflow(parallel(a, b).toGraph()).nodes;
        const steps = {
            [a.$stepId!]: { stepId: a.$stepId!, stepName: 'same', status: 'COMPLETED' as const },
            [b.$stepId!]: { stepId: b.$stepId!, stepName: 'same', status: 'FAILED' as const },
        };
        const matches = matchSteps(nodes, steps);
        assert.equal(matches.get(nodes.find(node => node.stepId === a.$stepId)!.key)?.status, 'COMPLETED');
        assert.equal(matches.get(nodes.find(node => node.stepId === b.$stepId)!.key)?.status, 'FAILED');
        assert.equal(
            matchSteps(
                nodes.map(node => ({ ...node, stepId: 'unknown' })),
                steps,
            ).size,
            0,
        );
    });

    it('renders runs without a definition without fabricating sequential edges', () => {
        const html = renderToStaticMarkup(
            createElement(DagView, {
                steps: {
                    a: { stepId: 'a', stepName: 'a', status: 'COMPLETED' },
                    b: { stepId: 'b', stepName: 'b', status: 'RUNNING' },
                },
            }),
        );
        assert.ok(html.includes('without inferred connections'));
        assert.ok(!html.includes('Workflow connections'));
    });

    it('supports unambiguous legacy combinators without matching unrelated step IDs', () => {
        const nodes = layoutWorkflow({ id: 'old-graph-id', name: 'parallel', type: 'parallel', branches: [] }).nodes;
        const step = { stepId: 'runtime-id', stepName: 'parallel', status: 'COMPLETED' as const };
        assert.equal(matchSteps(nodes, { [step.stepId]: step }).get('root'), step);
        const leaf = layoutWorkflow({ id: 'different-step', name: 'parallel', type: 'step' }).nodes;
        assert.equal(matchSteps(leaf, { [step.stepId]: step }).size, 0);
    });
});
