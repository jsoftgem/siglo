import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { stepInspectionStorage, WorkflowEventEmitter, sanitizeInspection } from '@siglo/core';
import { executeHttpRequest } from '../src/client/fetch';
import { parseRetryAfter } from '../src/client/retry';

describe('safe HTTP retry inspections', () => {
    const originTime = Date.UTC(2026, 10, 4);
    for (const [status, header, expected] of [
        [429, '2', 2000],
        [503, new Date(originTime + 3000).toUTCString(), 2990],
        [503, '0', 0],
        [429, 'private-invalid-header', undefined],
        [502, undefined, undefined],
    ] as const) {
        it(`records the actual delay for ${status} / ${header ?? 'absent'} without header content`, async () => {
            let time = originTime;
            let calls = 0;
            const events: any[] = [],
                sleeps: number[] = [];
            const monitor = new WorkflowEventEmitter().on('*', event => {
                events.push(event);
            });
            monitor.on('*', async () => {
                throw new Error('observer failed');
            });
            await stepInspectionStorage.run(
                { stackId: 's', stepId: 'runtime', stepName: 'same', attempt: 2, monitor },
                () =>
                    executeHttpRequest({
                        stepName: 'same',
                        url: 'https://example.test/private-path?token=private-query',
                        maxRetries: 1,
                        clock: { now: () => time },
                        sleep: async ms => {
                            sleeps.push(ms);
                            time += ms;
                        },
                        customFetch: (async () => {
                            time += 10;
                            return ++calls === 1
                                ? new Response('private-body', {
                                      status,
                                      headers: header ? { 'retry-after': header } : {},
                                  })
                                : new Response('{"ok":true}', { status: 200 });
                        }) as typeof fetch,
                    }),
            );
            const inspections = events.map(event => event.inspection);
            assert.deepEqual(
                inspections.map(data => data.requestAttempt),
                [1, 2],
            );
            assert.deepEqual(
                inspections.map(data => data.durationMs),
                [10, 10],
            );
            assert.equal(inspections[0].retryAfterMs, expected);
            assert.equal(inspections[0].retryDelaySource, expected === undefined ? 'backoff' : 'retry-after');
            assert.equal(inspections[0].retryDelayMs, sleeps[0]);
            if (expected !== undefined) assert.equal(sleeps[0], expected);
            assert.equal(inspections[1].retryDelayMs, undefined);
            assert.ok(events.every(event => event.stepId === 'runtime' && event.attempt === 2));
            assert.equal(JSON.stringify(events).includes('private-'), false);
        });
    }

    it('records network backoff exactly once and omits delays after retry exhaustion', async () => {
        const events: any[] = [],
            sleeps: number[] = [];
        const monitor = new WorkflowEventEmitter().on('*', event => {
            events.push(event);
        });
        await assert.rejects(() =>
            stepInspectionStorage.run({ stackId: 's', stepId: 'runtime', stepName: 'same', attempt: 1, monitor }, () =>
                executeHttpRequest({
                    stepName: 'same',
                    url: 'https://example.test',
                    maxRetries: 1,
                    sleep: async ms => {
                        sleeps.push(ms);
                    },
                    customFetch: (async () => {
                        throw Object.assign(new Error('private-network-error'), { code: 'ECONNRESET' });
                    }) as typeof fetch,
                }),
            ),
        );
        assert.equal(events.length, 2);
        assert.equal(events[0].inspection.retryDelayMs, sleeps[0]);
        assert.equal(events[0].inspection.retryDelaySource, 'backoff');
        assert.equal(events[1].inspection.retryDelayMs, undefined);
        assert.equal(events[1].inspection.requestAttempt, 2);
        assert.equal(JSON.stringify(events).includes('private-'), false);
    });

    it('rejects non-finite parsed delays and untrusted inspection delay values', () => {
        for (const header of ['Infinity', '1e309', '1e308']) assert.equal(parseRetryAfter(header), undefined);
        const base = { version: 1, kind: 'http', outcome: 'failure' };
        for (const value of [-1, Infinity, NaN, 'private']) {
            assert.equal((sanitizeInspection({ ...base, retryAfterMs: value }) as any).retryAfterMs, undefined);
        }
        assert.equal((sanitizeInspection({ ...base, retryDelaySource: 'private' }) as any).retryDelaySource, undefined);
    });
});
