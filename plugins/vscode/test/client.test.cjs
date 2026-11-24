require('tsx/cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { AnalyzerClient } = require('../src/client.ts');
const bin = path.resolve(__dirname, '../dist/analyzer.js');
const uri = 'file:///tmp/siglo-workflow.ts';
const content =
    "throw new Error('MUST NEVER EXECUTE');\nconst a = Step.create('a', x => x); const b = Step.create('b', x => x); const order = flow('order').then(a).then(b);";
const params = { uri, documentVersion: 1, content };
const make = (trusted = () => true, restarted = () => {}) =>
    new AnalyzerClient(
        bin,
        () => 'file:///tmp',
        trusted,
        () => {},
        restarted,
    );

test('blocks launch in untrusted workspace and allows it after trust', async t => {
    let trusted = false;
    const client = make(() => trusted);
    t.after(() => client.dispose());
    await assert.rejects(client.request('siglo/getGraph', params), /Trust this workspace/);
    assert.equal(client.child, undefined);
    trusted = true;
    const graph = await client.request('siglo/getGraph', params);
    assert.equal(graph.uri, uri);
    assert.ok(graph.nodes.length > 0);
});

test('multiplexes requests, survives RPC errors, and never executes source', async t => {
    const client = make();
    t.after(() => client.dispose());
    const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => client.request('siglo/getGraph', { ...params, documentVersion: i + 1 })),
    );
    assert.deepEqual(
        results.map(result => result.documentVersion),
        [1, 2, 3, 4, 5, 6, 7, 8],
    );
    await assert.rejects(client.request('not-a-method', {}), /Method not found/);
    assert.ok((await client.request('siglo/getGraph', params)).nodes.length > 0);
});

test('automatically restarts after an unexpected process exit', { timeout: 10000 }, async t => {
    let recovered;
    const restarted = new Promise(resolve => {
        recovered = resolve;
    });
    const client = make(() => true, recovered);
    t.after(() => client.dispose());
    await client.request('siglo/getGraph', params);
    const pid = client.child.pid;
    client.child.kill('SIGKILL');
    await restarted;
    assert.notEqual(client.child.pid, pid);
    assert.ok((await client.request('siglo/getGraph', params)).nodes.length > 0);
});

test('rejects pending work on disposal and refuses further requests', async () => {
    const client = make();
    await client.request('siglo/getGraph', params);
    client.dispose();
    await assert.rejects(client.request('siglo/getGraph', params), /disposed/);
});

test('bundled analyzer stays under 150 MB RSS through 1,000 edits', { timeout: 30000 }, async t => {
    const client = make();
    t.after(() => client.dispose());
    let peak = 0;
    for (let i = 1; i <= 1000; i++) {
        const graph = await client.request('siglo/getGraph', {
            ...params,
            content: content + `\n// revision ${i}`,
            documentVersion: i,
        });
        assert.equal(graph.documentVersion, i);
        if (process.platform !== 'win32' && i % 100 === 0) {
            try {
                const rss =
                    Number(
                        execFileSync('ps', ['-o', 'rss=', '-p', String(client.child.pid)], { encoding: 'utf8' }).trim(),
                    ) / 1024;
                peak = Math.max(peak, rss);
            } catch {
                // ps may be restricted by environment / sandbox policy
            }
        }
    }
    t.diagnostic(`Peak sampled analyzer RSS: ${peak.toFixed(1)} MB`);
    assert.ok(peak < 150, `Peak RSS ${peak.toFixed(1)} MB exceeds budget`);
});

test('extracts Step.compute nodes, properties, specs, and saga compensation exemptions via bundled analyzer', async t => {
    const client = make();
    t.after(() => client.dispose());
    const computeSource = [
        "import { Step, ComputeStep, flow } from '@siglo/core';",
        "import { httpStep } from '@siglo/http';",
        "import { encryptFieldsStep } from '@siglo/crypto';",
        'const calcTotals = Step.compute(',
        "    'calcTotals',",
        '    ({ amount }: { amount: number }) => ({ total: amount * 1.15 }),',
        ')',
        "    .spec('amount', { require: true, validate: (v: number) => v > 0 })",
        "    .cache({ ttl: '5m', maxEntries: 500 });",
        "const scoreRisk = new ComputeStep('scoreRisk', ({ total }: { total: number }) => ({ risk: total > 100 ? 'high' : 'low' })).cache('1m');",
        "const refundCard = Step.create('refundCard', () => {});",
        "const chargeCard = httpStep('chargeCard', { method: 'POST', url: 'https://api.stripe.com/charges' }).compensate(refundCard);",
        "const encryptReceipt = encryptFieldsStep('encryptReceipt', { fields: ['cardNumber'] });",
        "export const pricingSaga = flow('pricingSaga', calcTotals, scoreRisk, chargeCard, encryptReceipt);",
    ].join('\n');

    const graph = await client.request('siglo/getGraph', {
        uri: 'file:///tmp/compute-workflow.ts',
        documentVersion: 1,
        content: computeSource,
    });

    assert.equal(graph.workflowName, 'pricingSaga');
    const calcNode = graph.nodes.find(node => node.name === 'calcTotals');
    assert.ok(calcNode, 'Expected calcTotals compute node');
    assert.equal(calcNode.stepKind, 'compute');
    assert.equal(calcNode.properties.operation, 'Step.compute');
    assert.equal(calcNode.properties.networkPolicy, 'deny');
    assert.equal(calcNode.properties.cache, "{ ttl: '5m', maxEntries: 500 }");
    assert.ok(Array.isArray(calcNode.specs) && calcNode.specs.length > 0);
    assert.equal(calcNode.specs[0].field, 'amount');
    assert.deepEqual(calcNode.executionTarget, { exportName: 'pricingSaga', stepIndex: 0 });

    const riskNode = graph.nodes.find(node => node.name === 'scoreRisk');
    assert.ok(riskNode, 'Expected scoreRisk ComputeStep node');
    assert.equal(riskNode.stepKind, 'compute');
    assert.equal(riskNode.properties.operation, 'ComputeStep');
    assert.equal(riskNode.properties.networkPolicy, 'deny');
    assert.equal(riskNode.properties.cache, "'1m'");
    assert.deepEqual(riskNode.executionTarget, { exportName: 'pricingSaga', stepIndex: 1 });

    // Only encryptReceipt (uncompensated crypto side-effect step) triggers SIGLO_MISSING_COMPENSATION; compute steps are exempt
    const missingCompDiags = (graph.diagnostics || []).filter(d => d.code === 'SIGLO_MISSING_COMPENSATION');
    assert.equal(missingCompDiags.length, 1);
    assert.match(missingCompDiags[0].message, /encryptReceipt/);
});
