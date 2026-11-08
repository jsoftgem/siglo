/** Executable synthetic cookbook; every transport boundary is supplied explicitly. */
import { describe, it } from 'mocha';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Step, flow, waitForEvent, defaultDurableManager, installNetworkInterceptors } from '@siglo/core';
import { createWorkflowHarness, replayExecution } from '@siglo/testing';
import { httpStep } from '@siglo/http';
import { createMockHttpServer } from '@siglo/http/testing';
import { aiStep, type AiProviderAdapter } from '@siglo/ai';
import { MockAiProvider } from '@siglo/ai/testing';
import {
    sendNotificationStep,
    sendInteractiveApprovalStep,
    handleNotificationCallback,
    type NotificationTransport,
} from '@siglo/notifications';
import { MockNotificationTransport } from '@siglo/notifications/testing';

export function createSyntheticFlow(ai: AiProviderAdapter, transport: NotificationTransport) {
    return flow(
        httpStep('loadTicket', { url: 'https://fixture.test/ticket', method: 'GET', maxRetries: 0 }),
        aiStep('triage', {
            model: { provider: 'openai', model: 'synthetic-model', adapter: ai },
            prompt: ctx => `Triage ticket ${ctx.id}`,
        }),
        sendNotificationStep('notify', {
            channel: 'email',
            recipient: 'fixture@example.test',
            transport,
            template: ctx => ctx.data,
        }),
    );
}

describe('offline ecosystem cookbook', () => {
    it('executes HTTP → AI → notification and replays the provider recording', async () => {
        installNetworkInterceptors();
        const original = globalThis.fetch;
        const http = createMockHttpServer();
        try {
            http.get('https://fixture.test')
                .intercept({ path: '/ticket', method: 'GET' })
                .reply(200, { id: 'synthetic-ticket' })
                .times(2);
            const ai = new MockAiProvider([{ text: 'APPROVE', promptTokens: 10, completionTokens: 5 }]);
            const notifications = new MockNotificationTransport();
            const harness = createWorkflowHarness(createSyntheticFlow(ai, notifications));
            const result = await harness.run({});
            assert.equal(result.data, 'APPROVE');
            assert.equal(notifications.messages[0].content, 'APPROVE');
            const recorded = ai.exportRecording();
            const replayTransport = new MockNotificationTransport();
            await createWorkflowHarness(createSyntheticFlow(MockAiProvider.replay(recorded), replayTransport)).run({});
            assert.equal(replayTransport.messages[0].content, 'APPROVE');
            ai.assertDone();
            http.assertDone();
            await assert.rejects(fetch('https://unexpected.test'), /No intercept matched/);
        } finally {
            http.close();
        }
        assert.equal(globalThis.fetch, original);
    });

    it('rejects exhausted AI fixtures, replay mismatch and notification failure, restoring fetch', async () => {
        installNetworkInterceptors();
        const original = globalThis.fetch;
        const http = createMockHttpServer();
        try {
            http.get('https://fixture.test').intercept({ path: '/ticket' }).reply(200, { id: 'fixture' }).times(2);
            await assert.rejects(
                createWorkflowHarness(createSyntheticFlow(new MockAiProvider(), new MockNotificationTransport())).run(
                    {},
                ),
                /exhausted/,
            );
            const failing: NotificationTransport = {
                channel: 'email',
                allowedHosts: [],
                async send() {
                    throw new Error('synthetic delivery failure');
                },
            };
            await assert.rejects(
                createWorkflowHarness(
                    createSyntheticFlow(
                        new MockAiProvider([{ text: 'APPROVE', promptTokens: 1, completionTokens: 1 }]),
                        failing,
                    ),
                ).run({}),
                /synthetic delivery failure/,
            );
            const replay = MockAiProvider.replay([
                {
                    request: { model: 'expected', messages: [{ role: 'user', content: 'fixture' }] },
                    outcome: { text: 'ok', promptTokens: 1, completionTokens: 1 },
                },
            ]);
            await assert.rejects(
                replay.generate({ model: 'different', messages: [], signal: new AbortController().signal }),
                /mismatch/,
            );
            http.assertDone();
        } finally {
            http.close();
        }
        assert.equal(globalThis.fetch, original);
    });

    it('substitutes an entire step without executing its original action', async () => {
        const original = flow(Step.create('syntheticStep', async () => ({ value: 42 })));
        const harness = createWorkflowHarness(original);
        await harness.run({});
        const record = harness.exportExecutionRecord();
        const prohibited = flow(
            Step.create('syntheticStep', async () => {
                throw new Error('must not run');
            }),
        );
        const replay = await replayExecution(record, prohibited, {
            substituteFixtures: { syntheticStep: { value: 42 } },
        });
        assert.equal(replay.matched, true);
    });

    it('dispatches approval, suspends durably and resumes through an authorized signed callback', async () => {
        const correlationKey = randomUUID();
        const transport = new MockNotificationTransport();
        let effects = 0;
        const workflow = flow(
            sendInteractiveApprovalStep('approval', {
                channel: 'email',
                transport,
                recipient: 'fixture@example.test',
                title: 'Synthetic approval',
                correlationKey,
                timeout: '1h',
                onApproveEvent: 'DECISION',
                onRejectEvent: 'DECISION',
                callbackBaseUrl: 'https://fixture.test/callback',
                signingSecret: 'synthetic-secret',
            }),
            waitForEvent('DECISION', { correlationKey, timeout: '1h' }),
            Step.create('effect', async () => {
                effects++;
                return { completed: true };
            }),
        );
        await workflow.run({}, { durable: true });
        assert.equal(defaultDurableManager.getWaiting(correlationKey)?.status, 'waiting');
        assert.equal(effects, 0);
        const token = new URL(transport.messages[0].interactiveActions!.approveUrl).searchParams.get('token')!;
        const result = await handleNotificationCallback(token, {
            workflow,
            signingSecret: 'synthetic-secret',
            authorize: payload => payload.correlationKey === correlationKey,
        });
        assert.equal(result.status, 200);
        assert.equal(effects, 1);
    });
});
