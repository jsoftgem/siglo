import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    investigateTelemetry,
    offlineInvestigationRecording,
    offlineInvestigationTarget,
} from './usecase-25-offline-telemetry-investigation';

test('offline investigation sanitizes secrets and excludes mismatched versions and malformed records', () => {
    const report = investigateTelemetry(offlineInvestigationRecording, offlineInvestigationTarget);
    assert.equal(report.accepted, true);
    assert.equal(report.matched.length, 1);
    assert.equal(report.unmatched, 1);
    assert.equal(JSON.stringify(report).includes('synthetic-secret'), false);
    assert.equal(report.matched[0].inspection.kind, 'http');
});
test('offline investigation rejects unsupported documents and avoids ambiguous source attachment', () => {
    assert.equal(investigateTelemetry({ version: 99, records: [] }, offlineInvestigationTarget).accepted, false);
    const report = investigateTelemetry(offlineInvestigationRecording, {
        ...offlineInvestigationTarget,
        nodes: [
            { id: 'one', name: 'charge' },
            { id: 'two', name: 'charge' },
        ],
    });
    assert.equal(report.matched.length, 0);
    assert.equal(report.ambiguous, 1);
});
