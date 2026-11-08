import { runCombinatorsCharter, CharterResult } from './charters/combinators.explore';
import { runSagasCharter } from './charters/sagas.explore';
import { runDurableOccCharter } from './charters/durable-occ.explore';
import { runIdempotencyCharter } from './charters/idempotency.explore';
import { runQueuesBatchCharter } from './charters/queues-batch.explore';
import { runHttpAbortCharter } from './charters/http-abort.explore';
import { runCliDiagramsCharter } from './charters/cli-diagrams.explore';
import { runGraphAstCharter } from './charters/graph-ast.explore';
import { runOpenTelemetryCharter } from './charters/opentelemetry.explore';
import { runAiCharter } from './charters/ai.explore';
import { runNotificationsCharter } from './charters/notifications.explore';
import { runClusterFailoverCharter } from './charters/cluster-failover.explore';

export interface ExploratoryRunOptions {
    iterations?: number;
    seed?: number;
    charterFilter?: string;
}

export async function runAllExploratoryCharters(
    options: ExploratoryRunOptions = {},
): Promise<{ passed: boolean; results: CharterResult[] }> {
    const iterations = options.iterations ?? 10;
    const seed = options.seed ?? Date.now();
    const filter = options.charterFilter?.toLowerCase();

    console.log(`\n======================================================`);
    console.log(`🚀 Starting Automated Exploratory Testing Suite`);
    console.log(`   Iterations per charter: ${iterations}`);
    console.log(`   Global Seed:            ${seed}`);
    console.log(`======================================================\n`);

    const allCharters: Array<() => Promise<CharterResult>> = [
        () => runCombinatorsCharter(iterations, seed + 1),
        () => runSagasCharter(iterations, seed + 2),
        () => runDurableOccCharter(iterations, seed + 3),
        () => runIdempotencyCharter(iterations, seed + 4),
        () => runQueuesBatchCharter(iterations, seed + 5),
        () => runHttpAbortCharter(iterations, seed + 6),
        () => runCliDiagramsCharter(iterations, seed + 7),
        () => runGraphAstCharter(iterations, seed + 8),
        () => runOpenTelemetryCharter(iterations, seed + 9),
        () => runAiCharter(iterations, seed + 10),
        () => runNotificationsCharter(iterations, seed + 11),
        () => runClusterFailoverCharter(iterations, seed + 12),
    ];

    const results: CharterResult[] = [];
    let allPassed = true;

    for (const runCharter of allCharters) {
        try {
            const res = await runCharter();
            if (filter && !res.charterName.toLowerCase().includes(filter)) {
                continue;
            }
            results.push(res);

            const statusSymbol = res.passed ? '✅ PASSED' : '❌ FAILED';
            console.log(`${statusSymbol} | ${res.charterName} (${res.durationMs}ms, ${res.iterations} iterations)`);

            if (!res.passed) {
                allPassed = false;
                for (const err of res.errors) {
                    console.error(`   ⚠️  ${err}`);
                }
            }
        } catch (fatalErr: any) {
            allPassed = false;
            console.error(`   💥 Fatal execution error in charter: ${fatalErr.message}`);
        }
    }

    console.log(`\n======================================================`);
    console.log(`🏁 Exploratory Test Summary:`);
    console.log(`   Total Charters:   ${results.length}`);
    console.log(`   Passed:           ${results.filter(r => r.passed).length}`);
    console.log(`   Failed:           ${results.filter(r => !r.passed).length}`);
    console.log(`   Total Time:       ${results.reduce((acc, r) => acc + r.durationMs, 0)}ms`);
    console.log(`======================================================\n`);

    return { passed: allPassed, results };
}

// Allow direct CLI execution: `npx tsx test/exploratory/runner.ts`
const isEntryScript =
    process.argv[1] && (process.argv[1].endsWith('runner.ts') || process.argv[1].endsWith('runner.js'));

if (isEntryScript) {
    const keepAlive = setInterval(() => {}, 1000);
    const rawArgs = process.argv.slice(2);
    // Strip npm pass-through '--' if present
    const args = rawArgs.filter(a => a !== '--');

    let iterations = 10;
    let seed = 42;
    let charterFilter: string | undefined;

    for (const arg of args) {
        if (arg.startsWith('--iterations=')) {
            iterations = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--seed=')) {
            seed = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--charter=')) {
            charterFilter = arg.split('=')[1];
        }
    }

    runAllExploratoryCharters({ iterations, seed, charterFilter })
        .then(({ passed }) => {
            clearInterval(keepAlive);
            process.exit(passed ? 0 : 1);
        })
        .catch(err => {
            clearInterval(keepAlive);
            console.error('Fatal runner error:', err);
            process.exit(1);
        });
}
