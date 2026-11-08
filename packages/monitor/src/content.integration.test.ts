import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { flow, WorkflowEventEmitter, InspectionCapturePolicy, installNetworkInterceptors } from '@siglo/core';
import { httpStep } from '@siglo/http';
import { createMockHttpServer } from '@siglo/http/testing';
import { aiStep, AiProviderError } from '@siglo/ai';
import { MockAiProvider } from '@siglo/ai/testing';
import { sendNotificationStep } from '@siglo/notifications';
import { MockNotificationTransport } from '@siglo/notifications/testing';
import { createMonitorServer } from './server';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EcosystemInspector } from '../ui/src/components/workflows/Dag/EcosystemInspector';
import { previewDocument } from '../ui/src/components/workflows/Dag/InspectionContent';
import { sanitizedCurl } from '../ui/src/components/workflows/Dag/curl';

const capture: InspectionCapturePolicy = {
    fields: [
        'requestHeaders',
        'requestBody',
        'responseHeaders',
        'responseBody',
        'prompt',
        'output',
        'parsedOutput',
        'preview',
    ],
    maxBytes: 256,
    redact: (_, value) => JSON.parse(JSON.stringify(value ?? null).replaceAll('private-content', '[REDACTED]')),
};
describe('opt-in ecosystem content integration', () => {
    it('captures redacted HTTP/AI/notification content before store, API and live transport', async () => {
        const server = await createMonitorServer({ port: 0, host: '127.0.0.1' });
        const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
        const live: any[] = [];
        socket.addEventListener('message', event => live.push(JSON.parse(String(event.data))));
        await new Promise<void>((resolve, reject) => {
            socket.addEventListener('open', () => resolve(), { once: true });
            socket.addEventListener('error', () => reject(new Error('open failed')), { once: true });
        });
        installNetworkInterceptors();
        const http = createMockHttpServer();
        const inspections: any[] = [];
        server.emitter.on('*', event => {
            if (event.type === 'step:inspection' || event.type === 'ai:complete') inspections.push(event);
        });
        try {
            http.get('https://example.test')
                .intercept({ path: '/capture', method: 'POST' })
                .reply(200, { value: 'private-content', safe: 'response' });
            await flow(
                httpStep('http', {
                    url: 'https://example.test/capture',
                    method: 'POST',
                    capture,
                    headers: { authorization: 'private-content', 'content-type': 'application/json' },
                    body: { value: 'private-content', safe: 'request' },
                }),
                aiStep('ai', {
                    capture,
                    model: {
                        provider: 'openai',
                        model: 'synthetic',
                        adapter: new MockAiProvider([
                            { text: 'private-content output', promptTokens: 1, completionTokens: 2 },
                        ]),
                    },
                    prompt: 'private-content prompt',
                }),
                sendNotificationStep('notification', {
                    capture,
                    channel: 'email',
                    recipient: 'fixture@example.test',
                    template: '<p>private-content</p><script>alert(1)</script>',
                    transport: new MockNotificationTransport(),
                }),
            ).run({}, { monitor: server.emitter });
            http.assertDone();
            const content = inspections.filter(event => event.inspection?.content);
            assert.ok(content.some(event => event.inspection.content.requestBody));
            assert.ok(content.some(event => event.inspection.content.responseBody));
            assert.ok(content.some(event => event.inspection.content.prompt));
            assert.ok(content.some(event => event.inspection.content.output));
            assert.ok(content.some(event => event.inspection.content.parsedOutput));
            assert.ok(content.some(event => event.inspection.content.preview));
            assert.equal(inspections.filter(event => event.type === 'ai:complete').length, 1);
            assert.equal(JSON.stringify(inspections).includes('private-content'), false);
            const run = server.store.listRuns()[0];
            assert.equal(JSON.stringify(run).includes('private-content'), false);
            // Close the fetch mock before querying the actual local monitor server.
            http.close();
            const response = await fetch(`http://127.0.0.1:${server.port}/api/workflows/${run.stackId}`);
            assert.equal(response.status, 200);
            assert.equal((await response.text()).includes('private-content'), false);
            // HTTP response serves as a round trip while the ordered event stream drains.
            assert.ok(live.some(event => event.inspection?.content));
            assert.equal(JSON.stringify(live).includes('private-content'), false);
            const request = content.find(event => event.inspection.kind === 'http').inspection;
            assert.equal(sanitizedCurl(request), "curl --request POST --url 'https://example.test'");
            const notification = content.find(event => event.inspection.kind === 'notification');
            const html = renderToStaticMarkup(
                createElement(EcosystemInspector, {
                    step: {
                        stepId: notification.stepId,
                        status: 'COMPLETED',
                        inspections: [{ attempt: 1, timestamp: 1, data: notification.inspection }],
                    },
                }),
            );
            assert.ok(html.includes('sandbox=""'));
            assert.equal(html.includes('<script>'), false);
            assert.equal(html.includes('private-content'), false);
        } finally {
            http.close();
            socket.close();
            await server.close();
        }
    });

    it('renders only inert formatting in HTML previews and escapes Slack markup', () => {
        const attack =
            '<p>Safe</p><script>alert(1)</script><img src=x onerror=alert(1)><meta http-equiv=refresh content="0;url=https://evil.test"><a href="javascript:alert(1)">click</a><iframe srcdoc="<script>alert(2)</script>"></iframe>';
        const document = previewDocument(attack);
        assert.ok(document.includes('<p>Safe</p>'));
        assert.ok(document.includes("default-src 'none'"));
        assert.equal(/<(script|img|meta http-equiv=refresh|a |iframe)/i.test(document), false);
        const html = renderToStaticMarkup(
            createElement(EcosystemInspector, {
                step: {
                    stepId: 's',
                    status: 'RUNNING',
                    inspections: [
                        {
                            attempt: 1,
                            timestamp: 1,
                            data: {
                                version: 1,
                                kind: 'notification',
                                outcome: 'success',
                                channel: 'slack',
                                content: { preview: { text: attack, truncated: true } },
                            },
                        },
                    ],
                },
            }),
        );
        assert.equal(html.includes('<script>'), false);
        assert.equal(html.includes('<iframe'), false);
        assert.ok(html.includes('Capture truncated'));
    });

    it('reports pre-action HTTP and AI failures without sending requests or copying errors', async () => {
        const events: any[] = [];
        const monitor = new WorkflowEventEmitter().on('*', event => {
            events.push(event);
        });
        await assert.rejects(() =>
            flow(
                httpStep('http', {
                    url: () => {
                        throw new Error('private-content');
                    },
                }),
            ).run({}, { monitor }),
        );
        const ai = new MockAiProvider([]);
        await assert.rejects(() =>
            flow(
                aiStep('ai', {
                    model: { provider: 'openai', model: 'synthetic', adapter: ai },
                    prompt: 'private-content',
                    temperature: -1,
                }),
            ).run({}, { monitor }),
        );
        const inspections = events.filter(event => event.type === 'step:inspection');
        assert.deepEqual(
            inspections.map(event => event.inspection.kind),
            ['http', 'ai'],
        );
        assert.equal(inspections[1].inspection.phase, 'preflight');
        assert.equal(JSON.stringify(inspections).includes('private-content'), false);
        assert.ok(inspections.every(event => event.stepId && event.attempt === 1));
    });

    it('records separate AI inference attempts for fallback and keeps completion unique', async () => {
        const events: any[] = [];
        const monitor = new WorkflowEventEmitter().on('*', event => {
            events.push(event);
        });
        await flow(
            aiStep('fallback', {
                capture,
                prompt: 'private-content',
                model: {
                    provider: 'openai',
                    model: 'synthetic',
                    adapter: {
                        generate: async () => {
                            throw new AiProviderError('private-content', 503);
                        },
                    },
                },
                fallbackModels: [
                    {
                        provider: 'openai',
                        model: 'backup',
                        adapter: new MockAiProvider([
                            { text: 'private-content', promptTokens: 1, completionTokens: 1 },
                        ]),
                    },
                ],
            }),
        ).run({}, { monitor });
        const attempts = events.filter(
            event => event.type === 'step:inspection' && event.inspection.phase === 'attempt',
        );
        assert.deepEqual(
            attempts.map(event => event.inspection.inferenceAttempt),
            [1, 2],
        );
        assert.deepEqual(
            attempts.map(event => event.inspection.outcome),
            ['failure', 'success'],
        );
        assert.equal(events.filter(event => event.type === 'ai:complete').length, 1);
        assert.equal(JSON.stringify(attempts).includes('private-content'), false);
    });
});

describe('content failure and repair boundaries', () => {
    it('records repair prompt/output attempts and completion parsed output separately', async () => {
        const events: any[] = [];
        const monitor = new WorkflowEventEmitter().on('*', event => {
            events.push(event);
        });
        const adapter = new MockAiProvider([
            { text: 'private-content invalid json', promptTokens: 1, completionTokens: 1 },
            { text: '{"ok":true,"secret":"private-content"}', promptTokens: 1, completionTokens: 1 },
        ]);
        const result = await flow(
            aiStep('repair', {
                capture,
                model: { provider: 'openai', model: 'synthetic', adapter },
                prompt: 'private-content',
                enforceNativeStructuredOutputs: false,
                schema: { '~standard': { version: 1 as const, vendor: 'test', validate: (value: any) => ({ value }) } },
            }),
        ).run({}, { monitor });
        assert.equal(result.data.ok, true);
        const attempts = events.filter(event => event.type === 'step:inspection');
        assert.deepEqual(
            attempts.map(event => event.inspection.inferenceAttempt),
            [1, 2],
        );
        assert.ok(attempts[1].inspection.content.prompt.truncated);
        assert.equal(JSON.stringify(attempts).includes('private-content'), false);
        const completed = events.filter(event => event.type === 'ai:complete');
        assert.equal(completed.length, 1);
        assert.equal(completed[0].inspection.repairAttempts, 1);
        assert.equal(JSON.stringify(completed).includes('private-content'), false);
    });

    it('includes a safe preview on delivery failure and omits failing captures without changing success', async () => {
        const events: any[] = [];
        const monitor = new WorkflowEventEmitter().on('*', event => {
            events.push(event);
        });
        const transport = new MockNotificationTransport();
        transport.send = async () => {
            throw new Error('private-content');
        };
        await assert.rejects(() =>
            flow(
                sendNotificationStep('failure', {
                    capture,
                    transport,
                    channel: 'email',
                    recipient: 'fixture@example.test',
                    template: 'private-content',
                }),
            ).run({}, { monitor }),
        );
        const failure = events.find(event => event.type === 'step:inspection');
        assert.equal(failure.inspection.outcome, 'failure');
        assert.equal(failure.inspection.content.preview.text, '[REDACTED]');
        assert.equal(JSON.stringify(events).includes('private-content'), false);
        const result = await flow(
            sendNotificationStep('success', {
                capture: {
                    ...capture,
                    redact: () => {
                        throw new Error('private-content');
                    },
                },
                transport: new MockNotificationTransport(),
                channel: 'email',
                recipient: 'fixture@example.test',
                template: 'private-content',
            }),
        ).run({}, { monitor });
        assert.ok(result.notificationId);
        const last = events.filter(event => event.type === 'step:inspection').at(-1);
        assert.equal(last.inspection.content, undefined);
    });
});
