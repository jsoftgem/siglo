import { flow, Step } from '@siglo/core';
import { matchTelemetryRecord, sanitizeTelemetryDocument, type EcosystemTelemetryEnvelope } from '@siglo/ide-protocol';

export interface InvestigationTarget {
    workflowName: string;
    workflowVersion?: string | number;
    nodes: Array<{ id: string; name: string }>;
}

/** Import data only: never execute the recorded workflow or expose the original recording. */
export function investigateTelemetry(raw: unknown, target: InvestigationTarget) {
    const document = sanitizeTelemetryDocument(raw);
    if (!document) return { accepted: false, matched: [], unmatched: 0, ambiguous: 0 };
    const matched: Array<{ nodeId: string; inspection: EcosystemTelemetryEnvelope['inspection'] }> = [];
    let unmatched = 0;
    let ambiguous = 0;
    for (const record of document.records) {
        const candidates = target.nodes.filter(node =>
            matchTelemetryRecord(record, target.workflowName, target.workflowVersion, node),
        );
        if (candidates.length === 1) matched.push({ nodeId: candidates[0].id, inspection: record.inspection });
        else if (candidates.length > 1) ambiguous++;
        else unmatched++;
    }
    return { accepted: true, matched, unmatched, ambiguous };
}

export const offlineInvestigationTarget: InvestigationTarget = {
    workflowName: 'checkout',
    workflowVersion: '1',
    nodes: [{ id: 'charge', name: 'charge' }],
};

export const offlineInvestigationRecording = {
    version: 1,
    records: [
        {
            version: 1,
            workflowName: 'checkout',
            workflowVersion: '1',
            stepIdentity: 'charge',
            inspection: {
                version: 1,
                kind: 'http',
                outcome: 'failure',
                method: 'POST',
                status: 429,
                url: 'https://demo:synthetic-secret@payments.example/charge?token=synthetic-secret',
                headers: { authorization: 'Bearer synthetic-secret' },
                payload: { card: 'synthetic-secret' },
            },
        },
        {
            version: 1,
            workflowName: 'checkout',
            workflowVersion: 'old',
            stepIdentity: 'charge',
            inspection: { version: 1, kind: 'http', outcome: 'success' },
        },
        { version: 99, inspection: {} },
    ],
};

/** Source definition for IDE navigation. Investigation never needs to run it. */
export function createOfflineCheckoutWorkflow() {
    return flow(
        'checkout',
        Step.create('charge', async () => ({ charged: true })),
    ).version('1');
}
