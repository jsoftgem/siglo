import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAllExploratoryCharters, replayFailure, selectCharters, parseArguments } from '../runner';
import type { CharterDefinition } from '../registry';
import { exploreCases } from './charter';
import { ChaosStorageProxy } from './chaos-proxy';
import { RandomSource } from './property-generators';
import { FlowAstGenerator } from './ast-generator';
import { within } from './deadline';
import { assertExactIds } from './assertions';
import { InvariantEvaluator } from './invariant-evaluator';

const result = { charterName: 'fake', passed: true, iterations: 1, errors: [], durationMs: 0, invariantsChecked: [] };
describe('Exploratory runner regressions', () => {
    it('selects before executing and prefers exact IDs over overlapping names', async () => {
        const calls: string[] = [];
        const registry = ['ai', 'cluster-failover'].map((id, seedOffset) => ({
            id,
            smokeIterations: 1,
            seedOffset,
            run: async () => {
                calls.push(id);
                return result;
            },
        }));
        const run = await runAllExploratoryCharters({ charterFilter: 'ai' }, registry);
        assert.equal(run.passed, true);
        assert.deepEqual(calls, ['ai']);
        assert.throws(() => selectCharters({ charterFilter: 'missing' }, registry), /Unknown charter/);
        assert.deepEqual(calls, ['ai']);
    });
    it('rejects invalid arguments and requires explicit integration services', () => {
        for (const iterations of [0, -1, NaN, 1.5, Infinity]) assert.throws(() => selectCharters({ iterations }));
        for (const seed of [-1, NaN, Infinity, 2 ** 32, 1.5]) assert.throws(() => selectCharters({ seed }));
        assert.throws(() => parseArguments(['--unknown=1']));
        assert.throws(() => parseArguments(['--replay=x', '--seed=1']));
        assert.throws(() => selectCharters({ charterFilter: 'persistent-recovery' }), /--integration/);
        const old = process.env.SIGLO_TEST_POSTGRES_URL;
        delete process.env.SIGLO_TEST_POSTGRES_URL;
        try {
            assert.throws(() => selectCharters({ integration: true }), /SIGLO_TEST_POSTGRES_URL/);
        } finally {
            if (old !== undefined) process.env.SIGLO_TEST_POSTGRES_URL = old;
        }
    });
    it('captures generated inputs and fault schedules and reproduces them from a fixture', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'siglo-replay-'));
        const seen: unknown[] = [];
        const definition: CharterDefinition = {
            id: 'fake',
            seedOffset: 3,
            smokeIterations: 2,
            run: (iterations, seed) =>
                exploreCases('fake', iterations, seed, [], async (rng, _iteration, record) => {
                    const input = { value: rng.string(8), fault: rng.nextBoolean() };
                    seen.push(input);
                    record(input);
                    throw new Error('deliberate injected failure');
                }),
        };
        try {
            const first = await runAllExploratoryCharters({ seed: 12, iterations: 2, failureDir: directory }, [
                definition,
            ]);
            assert.equal(first.passed, false);
            const files = await readdir(directory);
            assert.equal(files.length, 1);
            const file = join(directory, files[0]);
            const artifact = JSON.parse(await readFile(file, 'utf8'));
            assert.equal(artifact.seed, 15);
            assert.equal(artifact.executionTrace.length, 2);
            assert.ok(artifact.executionTrace[0].trace[0].value);
            const replay = await replayFailure(file, { failureDir: directory }, [definition]);
            assert.equal(replay.passed, false);
            assert.equal((await readdir(directory)).length, 2);
            assert.deepEqual(seen.slice(0, 2), seen.slice(2));
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('reports thrown charter errors and incomplete metadata as failed results', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'siglo-fatal-'));
        try {
            const run = await runAllExploratoryCharters({ failureDir: directory }, [
                {
                    id: 'fatal',
                    seedOffset: 0,
                    smokeIterations: 1,
                    run: async () => {
                        throw new Error('fatal');
                    },
                },
                {
                    id: 'metadata',
                    seedOffset: 1,
                    smokeIterations: 1,
                    run: async () => ({ ...result, charterName: '' }),
                },
            ]);
            assert.equal(run.passed, false);
            assert.equal(run.results.length, 2);
            assert.equal((await readdir(directory)).length, 2);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('uses seeded chaos decisions and deterministic topology choices', async () => {
        async function faults() {
            const proxy = new ChaosStorageProxy(
                { name: 'fake', getCachedStep: async () => 1 },
                { failureRate: 0.5 },
                new RandomSource(123),
            );
            const decisions = [];
            for (let i = 0; i < 12; i++) {
                try {
                    await proxy.getCachedStep('key');
                    decisions.push('ok');
                } catch {
                    decisions.push('fault');
                }
            }
            return decisions;
        }
        assert.deepEqual(await faults(), await faults());
        assert.ok((await faults()).includes('fault'));
        const a = new FlowAstGenerator(9).generateFlow('same', 4);
        const b = new FlowAstGenerator(9).generateFlow('same', 4);
        assert.deepEqual(a.metadata, b.metadata);
    });
    it('bounds stalled test waits', async () => {
        await assert.rejects(within(new Promise(() => {}), 5, 'stalled fixture'), /stalled fixture/);
        assert.equal(await within(Promise.resolve(42), 100, 'unexpected deadline'), 42);
    });
    it('detects wrong batch IDs with equal counts and excessive concurrency', () => {
        assert.throws(() => assertExactIds(['wrong'], ['poison']));
        assert.throws(() => assertExactIds(['poison', 'poison'], ['poison']));
        assert.throws(() => InvariantEvaluator.assertBoundedConcurrency(4, 3));
    });
});
