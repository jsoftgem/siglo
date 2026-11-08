import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { FakeClock } from '@siglo/testing';
import {
    Step,
    flow,
    defaultDurableManager,
    getCompensationHandler,
    WorkflowEventEmitter,
    emitMonitoringEvent,
    ExpiredWaitException,
} from '@siglo/core';
import { MemoryWaitPoller } from '@siglo/scheduler';
import {
    sendNotificationStep,
    sendInteractiveApprovalStep,
    registerNotificationTransport,
    clearNotificationTransports,
    getNotificationTransport,
    signActionToken,
    verifyActionToken,
    getApprovalRevocationStore,
    configureApprovalRevocationStore,
    InMemoryApprovalRevocationStore,
    PostgresApprovalRevocationStore,
    parseTwilioSmsReply,
    createNotificationExpressMiddleware,
    createNotificationFastifyHandler,
    createNotificationHonoHandler,
} from '../dist/index';
import { MockNotificationTransport } from '../dist/testing';
const approvalOptions = {
    channel: 'email' as const,
    recipient: 'person@example.com',
    title: 'Approve',
    correlationKey: 'cancel-request',
    timeout: '2h',
    onApproveEvent: 'DONE',
    onRejectEvent: 'DONE',
    callbackBaseUrl: 'https://example.com/callback',
    signingSecret: 'secret',
    autoCompensate: true,
};
describe('notification lifecycle completion', () => {
    afterEach(() => {
        clearNotificationTransports();
        configureApprovalRevocationStore(new InMemoryApprovalRevocationStore());
    });
    it('registers transports and runs named compensation including email revocation', async () => {
        assert.throws(() => getNotificationTransport('email'));
        const transport = new MockNotificationTransport();
        registerNotificationTransport(transport);
        assert.equal(getNotificationTransport('email'), transport);
        const output = await sendInteractiveApprovalStep('named', approvalOptions).execute({});
        await getCompensationHandler('cancelNotification')!(output, {});
        assert.equal(transport.cancellations.length, 1);
        assert.equal(await getApprovalRevocationStore().isRevoked('cancel-request'), true);
        registerNotificationTransport({
            channel: 'email',
            allowedHosts: [],
            send: async () => ({ id: 'email', timestamp: 0 }),
        });
        await getCompensationHandler('cancelNotification')!(output, {});
        await assert.rejects(
            Promise.resolve().then(() =>
                getCompensationHandler('cancelNotification')!({ ...output, correlationKey: undefined }, {}),
            ),
        );
    });
    it('executes automatic compensation and typed workflow notification monitoring', async () => {
        const transport = new MockNotificationTransport();
        const monitor = new WorkflowEventEmitter();
        const events: any[] = [];
        monitor.on('*', e => {
            events.push(e);
        });
        const workflow = flow(
            sendInteractiveApprovalStep('cancel', { ...approvalOptions, transport }),
            new Step('fail', async () => {
                throw new Error('downstream failure');
            }),
        );
        await assert.rejects(workflow.run({}, { monitor }));
        assert.equal(transport.cancellations.length, 1);
        assert.ok(events.some(e => e.type === 'approval:requested'));
        assert.ok(events.some(e => e.type === 'notification:dispatched'));
        assert.ok(!JSON.stringify(events).includes('token='));
        const output: any[] = [];
        const redactionMonitor = new WorkflowEventEmitter().on('*', e => {
            output.push(e);
        });
        emitMonitoringEvent({ monitor: redactionMonitor }, {
            type: 'step:complete',
            stackId: 's',
            stepId: 'id',
            stepName: 'step',
            durationMs: 0,
            timestamp: 0,
            outputSummary: {
                email: 'private@example.com',
                phone: '+123456789',
                approvalTokens: { approveUrl: 'secret' },
            },
        } as any);
        assert.equal(output[0].outputSummary.email, '[REDACTED]');
        assert.equal(output[0].outputSummary.approvalTokens, '[REDACTED]');
    });
    it('fast-forwards expiry and reclaims a durable wait with the scheduler', async () => {
        const clock = new FakeClock(1000);
        const token = await signActionToken(
            {
                stackId: 'clock',
                correlationKey: 'clock',
                expectedEvent: 'DONE',
                approved: true,
                expiresAt: clock.now() + 7200000,
            },
            'secret',
            clock.now(),
        );
        clock.advanceTime(7200001);
        await assert.rejects(verifyActionToken(token, 'secret', { now: clock.now() }));
        const record = {
            stackId: 'expired-approval',
            correlationKey: 'expired-approval',
            eventName: 'DONE',
            continuationStepIndex: 0,
            stepId: 'wait',
            status: 'waiting' as const,
            createdAt: 1,
            expiresAt: 2,
        };
        defaultDurableManager.registerWait(record);
        assert.throws(() => defaultDurableManager.resumeWait(record.correlationKey), ExpiredWaitException);
        defaultDurableManager.registerWait({ ...record, status: 'waiting' });
        const report = await new MemoryWaitPoller().pollOnce();
        assert.ok(report.resumed >= 1);
        assert.equal(defaultDurableManager.getWaiting(record.correlationKey)?.status, 'resumed');
    });
    it('shares revocations through parameterized PostgreSQL queries', async () => {
        const revoked = new Set<string>();
        const queries: string[] = [];
        const store = new PostgresApprovalRevocationStore({
            method: 'POST',
            query: async (sql, values) => {
                queries.push(sql);
                if (sql.startsWith('INSERT')) revoked.add(values![0] as string);
                return {
                    rows: sql.includes('pg_try_advisory_lock')
                        ? [{ locked: true }]
                        : sql.startsWith('SELECT') && revoked.has(values![0] as string)
                          ? [{}]
                          : [],
                };
            },
        });
        await store.initialize();
        assert.equal(await store.isRevoked('request'), false);
        await store.revoke('request');
        assert.equal(await store.isRevoked('request'), true);
        assert.ok(queries[1].includes('$1'));
    });
    it('validates signed Twilio replies including all webhook form fields', () => {
        const params = {
            MessageSid: 'SM123',
            From: '+123456789',
            To: '+198765432',
            Body: 'APPROVE request:123',
            FutureField: 'value',
        };
        const publicUrl = 'https://example.com/sms';
        const authToken = 'auth';
        const signature = createHmac('sha1', authToken)
            .update(
                publicUrl +
                    Object.keys(params)
                        .sort()
                        .map(k => k + (params as any)[k])
                        .join(''),
            )
            .digest('base64');
        assert.equal(parseTwilioSmsReply(params, { publicUrl, authToken, signature }).approved, true);
        assert.throws(() =>
            parseTwilioSmsReply({ ...params, Body: 'REJECT request:123' }, { publicUrl, authToken, signature }),
        );
        assert.throws(() => parseTwilioSmsReply(params, { publicUrl, authToken, signature: 'wrong' }));
    });
    it('renders confirmation pages and handles CORS preflight without resuming', async () => {
        const options = {
            workflow: flow(new Step('noop', async () => ({}))),
            allowBearerApproval: true,
            signingSecret: 'secret',
            responseFormat: 'html' as const,
            allowedOrigins: ['https://dashboard.example.com'],
        };
        const res: any = {
            headers: {} as any,
            setHeader(k: string, v: string) {
                this.headers[k] = v;
            },
            status(v: number) {
                this.statusCode = v;
                return this;
            },
            type() {
                return this;
            },
            send(v: string) {
                this.html = v;
            },
            end() {},
        };
        const express = createNotificationExpressMiddleware(options);
        await express({ method: 'GET', query: {}, headers: { origin: options.allowedOrigins[0] } }, res);
        assert.equal(res.statusCode, 400);
        assert.ok(res.html.includes('Invalid approval'));
        assert.equal(res.headers['Access-Control-Allow-Origin'], options.allowedOrigins[0]);
        assert.equal(res.headers['Cache-Control'], 'no-store');
        await express({ method: 'OPTIONS', headers: {} }, res);
        assert.equal(res.statusCode, 204);
        const reply: any = {
            header() {},
            code(v: number) {
                this.status = v;
                return this;
            },
            type() {
                return this;
            },
            send(v: string) {
                this.html = v;
            },
            redirect(v: string) {
                this.url = v;
            },
        };
        await createNotificationFastifyHandler(options)({ method: 'POST', query: {}, headers: {} }, reply);
        assert.ok(reply.html.includes('<!doctype html>'));
        await createNotificationFastifyHandler(options)({ method: 'OPTIONS' }, reply);
        assert.equal(reply.status, 204);
        await createNotificationFastifyHandler({ ...options, onErrorRedirect: 'https://example.com/error' })(
            { method: 'POST', query: {} },
            reply,
        );
        assert.equal(reply.status, 303);
        const context: any = {
            header() {},
            req: { header() {}, method: 'POST', query() {}, parseBody: async () => ({ token: 'invalid' }) },
            html: (body: string, status: number) => new Response(body, { status }),
            body: (_: any, status: number) => new Response(null, { status }),
            redirect: (_: string, status: number) => new Response(null, { status }),
        };
        assert.equal((await createNotificationHonoHandler(options)(context)).status, 400);
        context.req.method = 'OPTIONS';
        assert.equal((await createNotificationHonoHandler(options)(context)).status, 204);
        context.req.method = 'POST';
        assert.equal(
            (await createNotificationHonoHandler({ ...options, onErrorRedirect: 'https://example.com/error' })(context))
                .status,
            303,
        );
    });
});
