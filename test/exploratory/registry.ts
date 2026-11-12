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

import { runIdeTelemetryCharter } from './charters/ide-telemetry.explore';
import { runSecurityBoundariesCharter } from './charters/security-boundaries.explore';
import { runPersistentRecoveryCharter } from './charters/persistent-recovery.explore';
import type { CharterResult } from './engine/charter';

export interface CharterDefinition {
    id: string;
    run: (iterations: number, seed: number) => Promise<CharterResult>;
    smokeIterations: number;
    seedOffset: number;
    integration?: boolean;
}

export const charterRegistry: CharterDefinition[] = [
    { id: 'combinators', run: runCombinatorsCharter, smokeIterations: 15, seedOffset: 1, integration: false },
    { id: 'sagas', run: runSagasCharter, smokeIterations: 15, seedOffset: 2, integration: false },
    { id: 'durable-occ', run: runDurableOccCharter, smokeIterations: 12, seedOffset: 3, integration: false },
    { id: 'idempotency', run: runIdempotencyCharter, smokeIterations: 12, seedOffset: 4, integration: false },
    { id: 'queues-batch', run: runQueuesBatchCharter, smokeIterations: 12, seedOffset: 5, integration: false },
    { id: 'http-abort', run: runHttpAbortCharter, smokeIterations: 12, seedOffset: 6, integration: false },
    { id: 'cli-diagrams', run: runCliDiagramsCharter, smokeIterations: 12, seedOffset: 7, integration: false },
    { id: 'graph-ast', run: runGraphAstCharter, smokeIterations: 20, seedOffset: 8, integration: false },
    { id: 'opentelemetry', run: runOpenTelemetryCharter, smokeIterations: 15, seedOffset: 9, integration: false },
    { id: 'ai', run: runAiCharter, smokeIterations: 15, seedOffset: 10, integration: false },
    { id: 'notifications', run: runNotificationsCharter, smokeIterations: 15, seedOffset: 11, integration: false },
    { id: 'cluster-failover', run: runClusterFailoverCharter, smokeIterations: 15, seedOffset: 12, integration: false },
    { id: 'ide-telemetry', run: runIdeTelemetryCharter, smokeIterations: 15, seedOffset: 13, integration: false },
    {
        id: 'security-boundaries',
        run: runSecurityBoundariesCharter,
        smokeIterations: 15,
        seedOffset: 14,
        integration: false,
    },
    {
        id: 'persistent-recovery',
        run: runPersistentRecoveryCharter,
        smokeIterations: 3,
        seedOffset: 15,
        integration: true,
    },
];
