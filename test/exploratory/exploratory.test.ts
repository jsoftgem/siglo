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
});
