import { readFile } from 'node:fs/promises';
import {
    clearStorage,
    getStorageAdapter,
    useStorage,
    defaultDurableManager,
    defaultCompensationManager,
} from '@siglo/core';
import { charterRegistry, type CharterDefinition } from './registry';
import { FailureShrinker } from './engine/shrinker';
import type { CharterResult } from './engine/charter';

export interface ExploratoryRunOptions {
    iterations?: number;
    seed?: number;
    charterFilter?: string;
    integration?: boolean;
    failureDir?: string;
}
export interface RunResult extends CharterResult {
    charterId: string;
    seed: number;
}

export function selectCharters(options: ExploratoryRunOptions, registry = charterRegistry) {
    if (options.iterations !== undefined && (!Number.isSafeInteger(options.iterations) || options.iterations < 1))
        throw new Error('iterations must be a positive safe integer');
    if (
        options.seed !== undefined &&
        (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff)
    )
        throw new Error('seed must be an integer between 0 and 4294967295');
    if (options.charterFilter !== undefined && !options.charterFilter.trim())
        throw new Error('charter filter must not be empty');
    const filter = options.charterFilter?.toLowerCase();
    const exact = registry.find(c => c.id === filter);
    const selected = exact ? [exact] : filter ? registry.filter(c => c.id.includes(filter)) : registry;
    if (!selected.length) throw new Error(`Unknown charter: ${filter}`);
    if (filter && !options.integration && selected.some(c => c.integration))
        throw new Error('Selected charter requires --integration');
    if (options.integration && (!process.env.SIGLO_TEST_POSTGRES_URL || !process.env.SIGLO_TEST_REDIS_URL))
        throw new Error('Integration mode requires SIGLO_TEST_POSTGRES_URL and SIGLO_TEST_REDIS_URL');
    return selected.filter(c => options.integration || !c.integration);
}

export async function runAllExploratoryCharters(
    options: ExploratoryRunOptions = {},
    registry: CharterDefinition[] = charterRegistry,
): Promise<{ passed: boolean; results: RunResult[] }> {
    const selected = selectCharters(options, registry);
    const seed = options.seed ?? 42;
    const results: RunResult[] = [];
    for (const charter of selected) {
        const charterSeed = (seed + charter.seedOffset) >>> 0;
        const iterations = options.iterations ?? 10;
        const previous = getStorageAdapter();
        const started = Date.now();
        let result: CharterResult;
        try {
            clearStorage();
            defaultDurableManager.clear();
            defaultCompensationManager.clear();
            result = await charter.run(iterations, charterSeed);
            if (!result.charterName || !Number.isFinite(result.durationMs) || !Array.isArray(result.invariantsChecked))
                throw new Error('Charter returned incomplete result metadata');
        } catch (error) {
            result = {
                charterName: charter.id,
                iterations,
                passed: false,
                errors: [error instanceof Error ? error.message : String(error)],
                durationMs: Date.now() - started,
                invariantsChecked: [],
            };
        } finally {
            clearStorage();
            defaultDurableManager.clear();
            defaultCompensationManager.clear();
            useStorage(previous as any);
        }
        const complete = { ...result, charterId: charter.id, seed: charterSeed };
        results.push(complete);
        console.log(`${result.passed ? 'PASS' : 'FAIL'} ${charter.id} (seed ${charterSeed}, ${result.durationMs}ms)`);
        if (!result.passed) {
            const file = await FailureShrinker.captureAndSaveFailure(options.failureDir ?? 'test/fixtures', {
                charterName: charter.id,
                iteration: -1,
                seed: charterSeed,
                error: result.errors.join('\n'),
                flowName: charter.id,
                executionTrace: result.evidence ?? [],
                timestamp: new Date().toISOString(),
                topologyMetadata: {
                    replayVersion: 1,
                    iterations,
                    integration: !!charter.integration,
                    globalSeed: seed,
                },
            });
            console.error(`${result.errors.join('\n')}\nReplay: npm run explore -- --replay=${file}`);
        }
    }
    return { passed: results.every(r => r.passed), results };
}

export async function replayFailure(
    file: string,
    overrides: Pick<ExploratoryRunOptions, 'failureDir'> = {},
    registry = charterRegistry,
) {
    const snapshot = JSON.parse(await readFile(file, 'utf8'));
    const metadata = snapshot.topologyMetadata;
    if (metadata?.replayVersion !== 1 || typeof snapshot.charterName !== 'string')
        throw new Error('Unsupported exploratory replay fixture');
    const definition = registry.find(c => c.id === snapshot.charterName);
    if (!definition || snapshot.seed !== (metadata.globalSeed + definition.seedOffset) >>> 0)
        throw new Error('Replay seed or charter does not match registry');
    return runAllExploratoryCharters(
        {
            iterations: metadata.iterations,
            seed: metadata.globalSeed,
            charterFilter: snapshot.charterName,
            integration: metadata.integration,
            ...overrides,
        },
        registry,
    );
}

export function parseArguments(args: string[]): ExploratoryRunOptions & { replay?: string } {
    const options: ExploratoryRunOptions & { replay?: string } = {};
    for (const arg of args.filter(a => a !== '--')) {
        if (arg === '--integration') options.integration = true;
        else if (arg.startsWith('--iterations=')) options.iterations = Number(arg.slice('--iterations='.length));
        else if (arg.startsWith('--seed=')) options.seed = Number(arg.slice('--seed='.length));
        else if (arg.startsWith('--charter=')) options.charterFilter = arg.slice('--charter='.length);
        else if (arg.startsWith('--replay=')) options.replay = arg.slice('--replay='.length);
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (options.replay !== undefined && (!options.replay || Object.keys(options).length !== 1))
        throw new Error('--replay requires a file and cannot be combined with other options');
    return options;
}

if (require.main === module) {
    // Some runtime timers are unref'ed; keep the standalone process alive until all charters settle.
    const keepAlive = setInterval(() => {}, 1000);
    Promise.resolve()
        .then(() => {
            const options = parseArguments(process.argv.slice(2));
            return options.replay ? replayFailure(options.replay) : runAllExploratoryCharters(options);
        })
        .then(({ passed, results }) => {
            console.log(`${results.filter(r => r.passed).length}/${results.length} charters passed`);
            process.exitCode = passed ? 0 : 1;
        })
        .catch(error => {
            console.error(error.message);
            process.exitCode = 1;
        })
        .finally(() => clearInterval(keepAlive));
}
