import { describe, it } from 'mocha';
import assert from 'node:assert/strict';
import {
    flow,
    Step,
    WorkflowEventEmitter,
    stepInspectionStorage,
    observeEcosystem,
    sanitizeInspection,
    redactEvent,
    setDefaultMonitor,
} from '@siglo/core';
import { httpStep } from '@siglo/http';
import { createMockHttpServer } from '@siglo/http/testing';
import { verifyWebhookStep } from '@siglo/crypto';
import { aiStep } from '@siglo/ai';
import { MockAiProvider } from '@siglo/ai/testing';
import { sendNotificationStep } from '@siglo/notifications';
import { MockNotificationTransport } from '@siglo/notifications/testing';
import { installNetworkInterceptors } from '@siglo/core';
import { WorkflowExecutionStore } from './store';
import { createMonitorServer } from './server';

describe('ecosystem inspection', () => {
    it('bounds and allowlists inspection data before persistence', () => {
        const data = sanitizeInspection({
            version: 1,
            kind: 'http',
            outcome: 'success',
            url: 'https://user:password@example.test/private/token?api_key=secret',
            method: 'POST',
            headers: { authorization: 'secret' },
            body: 'secret',
            status: 200,
            prompt: 'secret',
        });
        assert.equal((data as any).url, 'https://example.test');
        assert.equal(JSON.stringify(data).includes('secret'), false);
        assert.equal(sanitizeInspection({ version: 2, kind: 'http', outcome: 'success' }), undefined);
        const long = sanitizeInspection({ version: 1, kind: 'ai', outcome: 'success', model: 'x'.repeat(1024) });
        assert.equal(long?.truncated, true);
        const store = new WorkflowExecutionStore();
        store.addEvent({
            type: 'step:complete',
            stackId: 's',
            stepId: 'id',
            stepName: 'same',
            timestamp: 1,
            durationMs: 1,
            outputSummary: { secret: 'secret', headers: { authorization: 'secret' } },
        });
        assert.equal(JSON.stringify(store.getRun('s')).includes('"secret":"secret"'), false);
        assert.equal(
            (
                redactEvent(
                    {
                        type: 'context:change',
                        stackId: 's',
                        stepId: 'id',
                        timestamp: 1,
                        field: 'token',
                        value: 'secret',
                    },
                    { redactKeys: ['custom'] },
                ) as any
            ).value,
            '[REDACTED]',
        );
    });

    it('preserves identity for repeated names, nested flows and failures', async () => {
        const store = new WorkflowExecutionStore();
        const emitter = new WorkflowEventEmitter();
        emitter.on('*', event => store.addEvent(event));
        const create = (fail = false) =>
            Step.create('same', async () =>
                observeEcosystem({ version: 1, kind: 'crypto', outcome: 'success' }, async () => {
                    assert.ok(stepInspectionStorage.getStore()?.stepId);
                    if (fail) throw new Error('synthetic failure');
                    return { ok: true };
                }),
            );
        await flow(create(), flow(create())).run({}, { monitor: emitter });
        const records = store
            .listRuns()
            .flatMap(run => Object.values(run.steps))
            .filter(step => step.inspections?.length);
        assert.equal(records.length, 2);
        assert.notEqual(records[0].stepId, records[1].stepId);
        await assert.rejects(() => flow(create(true)).run({}, { monitor: emitter }));
        assert.ok(
            store
                .listRuns()
                .some(run => Object.values(run.steps).some(step => step.inspections?.[0].data.outcome === 'failure')),
        );
        assert.equal(stepInspectionStorage.getStore(), undefined);
    });

    it('correlates workflow retries by step ID and attempt', async () => {
        const store = new WorkflowExecutionStore();
        const emitter = new WorkflowEventEmitter().on('*', event => store.addEvent(event));
        let calls = 0;
        const step = Step.create('retried', async () =>
            observeEcosystem({ version: 1, kind: 'crypto', outcome: 'success' }, () => {
                if (++calls === 1) throw new Error('retry');
                return {};
            }),
        ).onFail({ maxAttempts: 2, delayMs: 1 });
        await flow(step).run({}, { monitor: emitter });
        const records = store
            .listRuns()
            .flatMap(run => Object.values(run.steps))
            .filter(record => record.inspections?.length);
        assert.equal(records.length, 1);
        assert.deepEqual(
            records[0].inspections?.map(entry => entry.attempt),
            [1, 2],
        );
    });

    it('emits package metadata, reuses AI completion and preserves outcomes with failing observers', async () => {
        installNetworkInterceptors();
        const original = globalThis.fetch;
        const http = createMockHttpServer();
        const events: any[] = [];
        const emitter = new WorkflowEventEmitter();
        emitter.on('*', event => {
            events.push(event);
        });
        emitter.on('*', async () => {
            throw new Error('observer failed');
        });
        try {
            http.get('https://example.test')
                .intercept({ path: '/private?token=secret', method: 'GET' })
                .reply(200, { ok: true });
            await flow(httpStep('request', { url: 'https://example.test/private?token=secret' })).run(
                {},
                { monitor: emitter },
            );
            const ai = new MockAiProvider([{ text: 'fixture', promptTokens: 1, completionTokens: 2 }]);
            await flow(
                aiStep('ai', {
                    model: { provider: 'openai', model: 'synthetic', adapter: ai },
                    prompt: 'secret prompt',
                }),
            ).run({}, { monitor: emitter });
            await flow(
                sendNotificationStep('notify', {
                    channel: 'email',
                    recipient: 'fixture@example.test',
                    template: 'secret content',
                    transport: new MockNotificationTransport(),
                }),
            ).run({}, { monitor: emitter });
            await assert.rejects(() =>
                flow(
                    verifyWebhookStep('verify', {
                        provider: 'stripe',
                        secret: 'secret',
                        payload: () => '{}',
                        signature: () => 'bad',
                    }),
                ).run({}, { monitor: emitter }),
            );
            const inspections = events.filter(e => e.type === 'step:inspection');
            assert.deepEqual(
                inspections.map(e => e.inspection.kind),
                ['http', 'http', 'ai', 'notification', 'crypto'],
            );
            assert.equal(events.filter(e => e.type === 'ai:complete').length, 1);
            assert.ok(events.find(e => e.type === 'ai:complete').inspection);
            assert.equal(JSON.stringify(inspections).includes('secret'), false);
            assert.equal(inspections[4].inspection.outcome, 'failure');
            http.assertDone();
            ai.assertDone();
        } finally {
            http.close();
            setDefaultMonitor(undefined);
        }
        assert.equal(globalThis.fetch, original);
    });

    it('sanitizes ingestion before storage and emits each HTTP event once', async () => {
        const server = await createMonitorServer({
            port: 0,
            host: '127.0.0.1',
            security: { redactedKeys: ['custom'] },
        });
        try {
            const event = {
                type: 'step:inspection',
                stackId: 'external',
                stepId: 'id',
                stepName: 'step',
                attempt: 1,
                timestamp: 1,
                inspection: {
                    version: 1,
                    kind: 'http',
                    outcome: 'failure',
                    url: 'https://example.test/secret?token=secret',
                    headers: { authorization: 'secret' },
                },
            };
            const response = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
                method: 'POST',
                body: JSON.stringify(event),
            });
            assert.equal(response.status, 202);
            const invalid = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
                method: 'POST',
                body: JSON.stringify({ ...event, inspection: { ...event.inspection, version: 999 } }),
            });
            assert.equal(invalid.status, 400);
            const run = server.store.getRun('external')!;
            assert.equal(run.events.length, 1);
            assert.equal(JSON.stringify(run).includes('secret'), false);
            assert.equal(run.steps.id.inspections?.length, 1);
        } finally {
            await server.close();
        }
    });
});
