import { appendInspection } from '../ui/src/hooks/inspectionUpdates';
import { describe, it } from 'mocha';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EcosystemInspector } from '../ui/src/components/workflows/Dag/EcosystemInspector';
import { sanitizedCurl } from '../ui/src/components/workflows/Dag/curl';

describe('safe inspector presentation', () => {
  it('escapes malicious model values and labels unknown cost and missing data', () => {
    const html = renderToStaticMarkup(createElement(EcosystemInspector, { step: {
      stepId: 's', status: 'COMPLETED', inspections: [{ attempt: 1, timestamp: 1,
        data: { version: 1, kind: 'ai', outcome: 'success', model: '<img src=x onerror=alert(1)>', promptTokens: 0 } }]
    } }));
    assert.equal(html.includes('<img'), false);
    assert.ok(html.includes('&lt;img'));
    assert.match(html, /Estimated cost \(USD\).*Unavailable/);
    const missing = renderToStaticMarkup(createElement(EcosystemInspector, { step: { stepId: 's', status: 'RUNNING' } }));
    assert.match(missing, /diagnostics unavailable/);
  });
  it('shows approval expiry in UTC and supports older records without expiry', () => {
    const render = (approvalExpiresAt?: number) => renderToStaticMarkup(createElement(EcosystemInspector, { step: {
      stepId: 's', status: 'COMPLETED', inspections: [{ attempt: 1, timestamp: 1,
        data: { version: 1, kind: 'notification', outcome: 'success', approval: true, approvalState: 'requested', tokenStatus: 'issued', approvalExpiresAt } }]
    } }));
    assert.ok(render(1800000000000).includes(new Date(1800000000000).toISOString()));
    assert.match(render(), /Approval expires \(UTC\).*Unavailable/);
    assert.match(render(), /Approval state.*requested/);
    assert.match(render(), /does not imply approval completion/);
  });
  it('applies live updates immutably and bounds history without changing step status', () => {
    const step = { stepId: 'runtime-id', stepName: 'same', status: 'RUNNING' as const, attempts: 2 };
    let updated = appendInspection(step, { type: 'step:inspection', stepId: 'runtime-id', attempt: 2, timestamp: 1,
      inspection: { version: 1, kind: 'ai', outcome: 'success' } });
    for (let i = 0; i < 60; i++) updated = appendInspection(updated, { type: 'ai:complete', stepId: 'runtime-id', inspection: { version: 1, kind: 'ai', outcome: 'success' } });
    assert.equal(updated.inspections?.length, 50);
    assert.equal(updated.status, 'RUNNING');
    assert.equal('inspections' in step, false);
    assert.equal(appendInspection(updated, { type: 'step:inspection', stepId: 'other' }), updated);
  });
  it('displays parsed Retry-After and the selected retry delay source', () => {
    const html = renderToStaticMarkup(createElement(EcosystemInspector, { step: {
      stepId: 's', status: 'RUNNING', inspections: [{ attempt: 1, timestamp: 1,
        data: { version: 1, kind: 'http', outcome: 'failure', status: 503, requestAttempt: 1,
          durationMs: 10, retryAfterMs: 2000, retryDelayMs: 2000, retryDelaySource: 'retry-after' } }]
    } }));
    assert.match(html, /Retry delay source.*retry-after/);
    assert.match(html, /Retry-After \(ms\).*2000/);
    assert.match(html, /Request attempt.*1/);
  });
  it('exports only a sanitized origin and validated method', () => {
    assert.equal(sanitizedCurl({ version: 1, kind: 'http', outcome: 'success', method: 'POST', url: 'https://user:secret@example.test/private?token=secret' }), "curl --request POST --url 'https://example.test'");
    assert.equal(sanitizedCurl({ version: 1, kind: 'http', outcome: 'failure', method: 'GET; echo stolen', url: 'https://example.test' }), undefined);
    assert.equal(sanitizedCurl({ version: 1, kind: 'http', outcome: 'failure', method: 'GET', url: 'javascript:alert(1)' }), undefined);
  });
});
