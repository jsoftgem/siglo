const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { parseWorkflowFile } = require('../ide-analysis/dist/parser');
const { executionRange } = require('../ide-protocol/dist');
const root = resolve(__dirname, '../..');

async function run(source, choose, options = {}) {
    const directory = mkdtempSync(join(root, '.run-test-'));
    try {
        const file = join(directory, options.javascript ? 'workflow.mjs' : 'workflow.ts');
        writeFileSync(file, source);
        const document = parseWorkflowFile({ uri: pathToFileURL(file).href });
        const selected = choose(document);
        if (options.settings) {
            mkdirSync(join(directory, '.siglo'));
            writeFileSync(join(directory, '.siglo/run.json'), JSON.stringify(options.settings));
            writeFileSync(join(directory, 'setup.ts'), 'process.env.SETUP_VALUE = "ready";');
        }
        if (options.mutate) writeFileSync(file, source + '\n// changed');
        const child = spawn(process.execPath, [join(root, 'plugins/vscode/dist/supervisor.cjs')], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const events = [];
        let stderr = '';
        child.stderr.on('data', bytes => (stderr += bytes));
        createInterface({ input: child.stdout }).on('line', line => {
            const event = JSON.parse(line);
            events.push(event);
            if (options.cancel && event.status === 'started') child.stdin.write('{"type":"cancel"}\n');
        });
        child.stdin.write(
            JSON.stringify({
                type: 'runSteps',
                runId: 'test',
                uri: document.uri,
                documentVersion: document.documentVersion,
                workflowName: document.workflowName,
                nodeIds: selected,
                input: options.input || { n: 10 },
                document,
                source,
                cwd: directory,
            }) + '\n',
        );
        const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
        await new Promise(resolve => child.on('exit', resolve));
        clearTimeout(timeout);
        assert.equal(stderr, '');
        assert.ok(
            events.some(event => ['completed', 'failed', 'cancelled'].includes(event.status)),
            JSON.stringify(events),
        );
        return events;
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}
const source = `import { Step, flow } from '@siglo/core';
const a = Step.create('one', () => { throw new Error('outside range'); });
const b = Step.create('two', (input: any) => { console.log('{"status":"failed"}'); return { n: Number(input.n) + 2 }; });
const c = Step.create('three', (input: any) => ({ n: Number(input.n) * 3 }));
const d = Step.create('four', (input: any) => ({ n: Number(input.n) + 4 }));
const e = Step.create('five', () => { throw new Error('outside range'); });
export const workflow = flow(a, b, c, d, e);`;
const ids = (document, positions) => positions.map(index => document.nodes[index].id);

test('inclusive reverse selection runs only 2, 3, 4 with outputs and separate logs', async () => {
    const events = await run(source, doc => ids(doc, [3, 1]));
    assert.equal(
        events.find(event => event.status === 'failed'),
        undefined,
        JSON.stringify(events),
    );
    assert.equal(events.find(event => event.status === 'completed').output.n, 40);
    assert.equal(events.filter(event => event.status === 'step' && event.output).length, 3);
    assert.ok(events.some(event => event.status === 'log'));
});
test('selection with more than two steps in arbitrary order runs inclusive range', async () => {
    const events = await run(source, doc => ids(doc, [3, 1, 2]));
    assert.equal(
        events.find(event => event.status === 'failed'),
        undefined,
        JSON.stringify(events),
    );
    assert.equal(events.find(event => event.status === 'completed').output.n, 40);
});
test('one selection runs only that step', async () => {
    const events = await run(source, doc => ids(doc, [2]));
    assert.equal(events.find(event => event.status === 'completed')?.output.n, 30, JSON.stringify(events));
});
test('stale source fails before executing', async () => {
    const events = await run(source, doc => ids(doc, [1]), { mutate: true });
    assert.match(events.find(event => event.status === 'failed').error, /Save source/);
    assert.ok(!events.some(event => event.status === 'started'));
});
test('failure retains completed outputs', async () => {
    const events = await run(source, doc => ids(doc, [3, 4]));
    assert.ok(events.some(event => event.status === 'failed'));
    assert.ok(events.some(event => event.status === 'step' && event.output?.n === 14));
});
test('step with retries executes and succeeds if retry passes', async () => {
    const retrySource = `import { Step, flow } from '@siglo/core';
        let count = 0;
        const retryStep = Step.create('retryStep', () => {
            count++;
            if (count < 2) throw new Error('Temporary failure');
            return { attempts: count };
        }).onFail({ maxRetries: 2, backoff: 'fixed', delay: 0 });
        export const workflow = flow(retryStep);`;
    const events = await run(retrySource, doc => ids(doc, [0]));
    assert.equal(
        events.find(event => event.status === 'failed'),
        undefined,
        JSON.stringify(events),
    );
    assert.equal(events.find(event => event.status === 'completed')?.output.attempts, 2);
});
test('cancel terminates a non-cooperative step', async () => {
    const events = await run(
        `import { Step, flow } from '@siglo/core';
        const wait = Step.create('wait', async () => { await new Promise(resolve => setTimeout(resolve, 60000)); return {}; });
        export const workflow = flow(wait);`,
        doc => ids(doc, [0]),
        { cancel: true },
    );
    assert.ok(
        events.some(event => event.status === 'cancelled'),
        JSON.stringify(events),
    );
});
test('setup module and environment apply to JavaScript workflows', async () => {
    const events = await run(
        `import { Step, flow } from '@siglo/core';
        const env = Step.create('env', () => ({ value: process.env.SETUP_VALUE, override: process.env.RUN_TEST }));
        export const workflow = flow(env);`,
        doc => ids(doc, [0]),
        { javascript: true, settings: { setupModule: 'setup.ts', env: { RUN_TEST: 'yes' } } },
    );
    assert.deepEqual(
        events.find(event => event.status === 'completed')?.output,
        { value: 'ready', override: 'yes' },
        JSON.stringify(events),
    );
});
test('nested branch step can run independently; branch-spanning ranges cannot', async () => {
    const branched = `import { Step, flow, parallel } from '@siglo/core';
        const a = Step.create('a', () => ({ n: 1 }));
        const b = Step.create('b', () => ({ n: 2 }));
        const c = Step.create('c', () => ({ n: 3 }));
        export const workflow = flow(a, parallel(b, c));`;
    const events = await run(branched, doc => {
        assert.throws(
            () => executionRange(doc.nodes, doc.edges, [doc.nodes[0].id, doc.nodes.find(n => n.name === 'b').id]),
            /boundary|boundaries|executable/,
        );
        return [doc.nodes.find(n => n.name === 'b').id];
    });
    assert.equal(events.find(event => event.status === 'completed')?.output.n, 2, JSON.stringify(events));
});
test('unsupported result is an explicit serialization error', async () => {
    const events = await run(
        `import { Step, flow } from '@siglo/core';
        const big = Step.create('big', () => ({ value: 1n })); export const workflow = flow(big);`,
        doc => ids(doc, [0]),
    );
    assert.match(events.find(event => event.status === 'failed').error, /JSON|BigInt/i);
});
test('pretty and raw json are equivalent representations of output', async () => {
    const events = await run(source, doc => ids(doc, [1]));
    const output = events.find(event => event.status === 'completed')?.output;
    assert.ok(output);
    const prettyJson = JSON.stringify(output, null, 2);
    const rawJson = JSON.stringify(output);
    assert.deepEqual(JSON.parse(prettyJson), JSON.parse(rawJson));
});
