import type { WorkflowEventEmitter } from '@siglo/core';
import { runStepLatenciesScenario } from './scenarios/1-step-latencies';
import { runRetriesScenario } from './scenarios/2-retries';
import { runSagaRollbackScenario } from './scenarios/3-saga-rollback';
import { runDistributedCallsScenario } from './scenarios/4-distributed-calls';
import { flushTelemetry, shutdownTelemetry } from './tracer';

export async function runAllScenarios(options: { emitter?: WorkflowEventEmitter } = {}): Promise<void> {
    console.log(`\n==============================================================================`);
    console.log(`       🌊 siglo OpenTelemetry APM & Live Monitoring Demo                `);
    console.log(`==============================================================================\n`);

    console.log('  Traces export through the configured OTLP/HTTP endpoint (default: localhost:4318).');
    console.log('  Terminal spans are also available when the collector is offline.');
    console.log(`\n------------------------------------------------------------------------------\n`);

    // 1. Step Latencies & Concurrency
    console.log(`▶ Running Scenario 1: Step Latencies & Parallel Fan-Out...`);
    await runStepLatenciesScenario(options);
    await flushTelemetry();

    // 2. Retries & Backoff
    console.log(`▶ Running Scenario 2: Transient Failures & Retry Attempt Spans...`);
    await runRetriesScenario(options);
    await flushTelemetry();

    // 3. Sagas & Compensation Rollbacks
    console.log(`▶ Running Scenario 3: Distributed Saga & LIFO Compensation Rollbacks...`);
    await runSagaRollbackScenario(options);
    await flushTelemetry();

    // 4. Distributed Parent-Child Tracing Across Services
    console.log(`▶ Running Scenario 4: Cross-Service Parent-Child Tracing (W3C)...`);
    await runDistributedCallsScenario(options);
    await flushTelemetry();

    console.log(`==============================================================================`);
    console.log(`  ✨ All 4 APM Monitoring Scenarios Completed Successfully!                   `);
    console.log(`==============================================================================`);
    console.log(`\n  Dashboard Access Points:`);
    console.log(`  • Jaeger Tracing UI:     http://localhost:16686`);
    console.log(`  • Grafana Dashboard:     http://localhost:3000   (user: admin / admin)`);
    console.log(`  • Prometheus Metrics:    http://localhost:9090`);
    console.log(`\n  Useful Queries in Jaeger:`);
    console.log(`  • Service: order-service            -> View parallel latency waterfalls`);
    console.log(`  • Service: billing-service          -> View retry attempts (#1, #2, #3)`);
    console.log(`  • Service: travel-booking-service   -> View saga compensation rollbacks`);
    console.log(`  • Service: checkout-api             -> View cross-service distributed trace`);
    console.log(`==============================================================================\n`);
}

if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('src')) {
    runAllScenarios()
        .then(async () => {
            await shutdownTelemetry();
            process.exit(0);
        })
        .catch(async (err) => {
            console.error('Execution failed:', err);
            await shutdownTelemetry();
            process.exit(1);
        });
}
