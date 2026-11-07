/// <reference types="mocha" />
import { expect } from 'chai';
import { runCombinatorsCharter } from './charters/combinators.explore';
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

describe('Automated Exploratory Testing Suite', function () {
    // Generative and chaos tests require slightly more timeout headroom
    this.timeout(30000);

    it('Charter 1: Core Combinator & Parallelism Stress', async () => {
        const result = await runCombinatorsCharter(15, 101);
        if (!result.passed) {
            expect.fail(`Charter 1 failed with errors:\n${result.errors.join('\n')}`);
        }
        expect(result.passed).to.be.true;
    });

    it('Charter 2: Saga Rollbacks & Cascading Failure Chaos', async () => {
        const result = await runSagasCharter(15, 202);
        if (!result.passed) {
            expect.fail(`Charter 2 failed with errors:\n${result.errors.join('\n')}`);
        }
        expect(result.passed).to.be.true;
    });

    it('Charter 3: Durable Waits & Checkpoint Resumption Under OCC Contention', async () => {
        const result = await runDurableOccCharter(12, 303);
        if (!result.passed) {
            expect.fail(`Charter 3 failed with errors:\n${result.errors.join('\n')}`);
        }
        expect(result.passed).to.be.true;
    });

    it('Charter 4: Idempotency Key Collisions & TTL Expiry', async () => {
        const result = await runIdempotencyCharter(12, 404);
        if (!result.passed) {
            expect.fail(`Charter 4 failed with errors:\n${result.errors.join('\n')}`);
        }
        expect(result.passed).to.be.true;
    });

    it('Charter 5: Streaming & Message Queue Batch Processing', async () => {
        const result = await runQueuesBatchCharter(12, 505);
        if (!result.passed) {
            expect.fail(`Charter 5 failed with errors:\n${result.errors.join('\n')}`);
        }
        expect(result.passed).to.be.true;
    });

    it('Charter 6: Web / Edge Adapter Disconnects & Abort Propagation', async () => {
        const result = await runHttpAbortCharter(12, 606);
        if (!result.passed) {
            expect.fail(`Charter 6 failed with errors:\n${result.errors.join('\n')}`);
        }
        expect(result.passed).to.be.true;
    });

    it('Charter 7: CLI Tooling, Diagram Export & Validation', async () => {
        const result = await runCliDiagramsCharter(12, 707);
        if (!result.passed) {
            expect.fail(`Charter 7 failed with errors:\n${result.errors.join('\n')}`);
        }
        expect(result.passed).to.be.true;
    });

    it('Charter 8: Graph AST Generation & Network Policy Reflection (toGraph)', async () => {
        const result = await runGraphAstCharter(20, 808);
        if (!result.passed) {
            expect.fail(`Charter 8 failed with errors:\n${result.errors.join('\n')}`);
        }
        expect(result.passed).to.be.true;
    });

    it('Charter 9: Observability, W3C Trace Context & Metric Fidelity', async () => {
        const result = await runOpenTelemetryCharter(15, 909);
        if (!result.passed) {
            expect.fail(`Charter 9 failed with errors:\n${result.errors.join('\n')}`);
        }
        expect(result.passed).to.be.true;
    });

    it('Charter 10: Agentic AI Orchestration & Token Budget Stress', async () => {
        const result = await runAiCharter(15, 1010);
        if (!result.passed) {
            expect.fail(`Charter 10 failed with errors:\n${result.errors.join('\n')}`);
        }
        expect(result.passed).to.be.true;
    });

    it('Charter 11: Notification Dispatch Cascades & Provider Failover', async () => {
        const result = await runNotificationsCharter(15, 1111);
        if (!result.passed) {
            expect.fail(`Charter 11 failed with errors:\n${result.errors.join('\n')}`);
        }
        expect(result.passed).to.be.true;
    });

    it('Charter 12: Distributed Multi-Node Worker Failover & Split-Brain Contention', async () => {
        const result = await runClusterFailoverCharter(15, 1212);
        if (!result.passed) {
            expect.fail(`Charter 12 failed with errors:\n${result.errors.join('\n')}`);
        }
        expect(result.passed).to.be.true;
    });
});
