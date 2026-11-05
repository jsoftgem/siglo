import { expect } from 'chai';
import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';
import { flow, Step, WorkflowEventEmitter, waitForEvent } from '@siglo/core';
import {
    WorkflowExecutionStore,
    SSEBroadcaster,
    createSSEHandler,
    WebSocketBroadcaster,
    RedisMonitoringAdapter,
    PrometheusExporter,
    createMonitorServer,
    getActiveMonitorServer,
    getMonitorEmitter,
    createMonitorClient,
    attachToMonitorServer,
    getDashboardHtml,
    createExpressMonitorMiddleware,
    fastifyMonitorPlugin,
    honoMonitorMiddleware
} from './index';

describe('@siglo/monitor Suite', () => {
    describe('WorkflowExecutionStore', () => {
        it('records and tracks execution events in memory', () => {
            const store = new WorkflowExecutionStore(10);
            expect(store.listRuns()).to.be.an('array').with.lengthOf(0);

            // Flow start
            store.addEvent({
                type: 'flow:start',
                stackId: 'stk-1',
                flowName: 'OrderFlow',
                version: '1.0',
                namespace: 'tenant-a',
                timestamp: 1000
            });

            const r1 = store.getRun('stk-1');
            expect(r1).to.not.be.undefined;
            expect(r1!.flowName).to.equal('OrderFlow');
            expect(r1!.status).to.equal('RUNNING');

            // Step start
            store.addEvent({
                type: 'step:start',
                stackId: 'stk-1',
                stepId: 'stp-1',
                stepName: 'chargeCard',
                attempt: 1,
                timestamp: 1010
            });
            expect(r1!.steps['stp-1'].status).to.equal('RUNNING');

            // Step complete
            store.addEvent({
                type: 'step:complete',
                stackId: 'stk-1',
                stepId: 'stp-1',
                stepName: 'chargeCard',
                durationMs: 15,
                timestamp: 1025
            });
            expect(r1!.steps['stp-1'].status).to.equal('COMPLETED');
            expect(r1!.steps['stp-1'].durationMs).to.equal(15);

            // Context mutation diff
            store.addEvent({
                type: 'context:change',
                stackId: 'stk-1',
                field: 'orderStatus',
                value: 'PAID',
                timestamp: 1026
            });
            expect(r1!.context.orderStatus).to.equal('PAID');
            expect(r1!.contextDiffs).to.have.lengthOf(1);
            expect(r1!.contextDiffs[0].field).to.equal('orderStatus');

            // Flow complete
            store.addEvent({
                type: 'flow:complete',
                stackId: 'stk-1',
                status: 'COMPLETED',
                durationMs: 30,
                timestamp: 1030
            });
            expect(r1!.status).to.equal('COMPLETED');
            expect(r1!.durationMs).to.equal(30);

            // Verify list runs with filters
            expect(store.listRuns()).to.have.lengthOf(1);
            expect(store.listRuns({ namespace: 'tenant-a' })).to.have.lengthOf(1);
            expect(store.listRuns({ namespace: 'unknown' })).to.have.lengthOf(0);
            expect(store.listRuns({ status: 'COMPLETED' })).to.have.lengthOf(1);
            expect(store.listRuns({ status: 'FAILED' })).to.have.lengthOf(0);
        });

        it('evicts oldest runs when capacity is reached', () => {
            const store = new WorkflowExecutionStore(2);
            store.addEvent({ type: 'flow:start', stackId: 's1', timestamp: 1 });
            store.addEvent({ type: 'flow:start', stackId: 's2', timestamp: 2 });
            store.addEvent({ type: 'flow:start', stackId: 's3', timestamp: 3 });

            const runs = store.listRuns();
            expect(runs).to.have.lengthOf(2);
            expect(store.getRun('s1')).to.be.undefined;
            expect(store.getRun('s2')).to.not.be.undefined;
            expect(store.getRun('s3')).to.not.be.undefined;
        });
    });

    describe('SSEBroadcaster Transport', () => {
        it('manages clients and broadcasts redacted events with heartbeat', (done) => {
            const sse = new SSEBroadcaster({
                redaction: { redactKeys: ['token', 'password'] },
                heartbeatIntervalMs: 50
            });

            const writtenChunks: string[] = [];
            const mockRes = {
                writeHead: (status: number, headers: any) => {
                    expect(status).to.equal(200);
                    expect(headers['Content-Type']).to.equal('text/event-stream');
                },
                write: (chunk: string) => {
                    writtenChunks.push(chunk);
                },
                on: (_event: string, _cb: (...args: any[]) => void) => {}
            };

            sse.addClient(mockRes as any, 'tenant-x');
            expect(sse.getClientCount()).to.equal(1);

            // Initial connected message sent
            expect(writtenChunks.some(c => c.includes('connected'))).to.be.true;

            // Broadcast matching event with sensitive context field
            sse.broadcast({
                type: 'context:change',
                namespace: 'tenant-x',
                stackId: 'stk-x',
                field: 'token',
                value: 'secret123'
            });

            // Verify event is redacted
            const eventChunk = writtenChunks.find(c => c.includes('context:change'));
            expect(eventChunk).to.not.be.undefined;
            expect(eventChunk).to.include('[REDACTED]');
            expect(eventChunk).to.not.include('secret123');

            // Broadcast non-matching namespace
            const countBefore = writtenChunks.length;
            sse.broadcast({
                type: 'flow:start',
                namespace: 'other-tenant',
                stackId: 'stk-other'
            });
            expect(writtenChunks.length).to.equal(countBefore);

            // Test heartbeat
            setTimeout(() => {
                expect(writtenChunks.some(c => c.startsWith(':keepalive'))).to.be.true;
                sse.close();
                expect(sse.getClientCount()).to.equal(0);
                done();
            }, 80);
        });

        it('supports createSSEHandler', (done) => {
            const sse = new SSEBroadcaster();
            const handler = createSSEHandler(sse);
            const req = { url: '/events?namespace=ns1', headers: { host: 'localhost' } };
            const res = {
                writeHead: () => {},
                write: () => {},
                on: () => {}
            };
            handler(req as any, res as any);
            expect(sse.getClientCount()).to.equal(1);
            sse.close();
            done();
        });
    });

    describe('WebSocketBroadcaster Transport', () => {
        let server: http.Server;
        let ws: WebSocketBroadcaster;
        let port: number;

        before((done) => {
            server = http.createServer();
            ws = new WebSocketBroadcaster({
                redaction: { redactKeys: ['secret'] }
            });
            ws.attach(server, '/ws');
            server.listen(0, () => {
                port = (server.address() as any).port;
                done();
            });
        });

        after((done) => {
            ws.close();
            server.close(done);
        });

        it('performs RFC 6455 upgrade, handles ping/pong, and receives text frame', (done) => {
            const clientKey = crypto.randomBytes(16).toString('base64');
            const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
                socket.write(
                    `GET /ws HTTP/1.1\r\n` +
                    `Host: 127.0.0.1:${port}\r\n` +
                    `Upgrade: websocket\r\n` +
                    `Connection: Upgrade\r\n` +
                    `Sec-WebSocket-Key: ${clientKey}\r\n` +
                    `Sec-WebSocket-Version: 13\r\n\r\n`
                );
            });

            let upgraded = false;
            socket.on('data', (data) => {
                const response = data.toString('utf8');
                if (!upgraded && response.includes('HTTP/1.1 101 Switching Protocols')) {
                    upgraded = true;
                    expect(ws.getClientCount()).to.equal(1);

                    // Send masked WebSocket text frame: JSON subscribe action
                    const jsonPayload = JSON.stringify({ action: 'subscribe', namespace: 'test-ns' });
                    const payloadBuffer = Buffer.from(jsonPayload, 'utf8');
                    const maskKey = Buffer.from([0x12, 0x34, 0x56, 0x78]);
                    const maskedPayload = Buffer.alloc(payloadBuffer.length);
                    for (let i = 0; i < payloadBuffer.length; i++) {
                        maskedPayload[i] = payloadBuffer[i] ^ maskKey[i % 4];
                    }

                    const frameHeader = Buffer.from([0x81, 0x80 | payloadBuffer.length]);
                    const fullFrame = Buffer.concat([frameHeader, maskKey, maskedPayload]);
                    socket.write(fullFrame);

                    // Send Ping frame (opcode 0x09)
                    const pingFrame = Buffer.from([0x89, 0x84, 0x01, 0x02, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
                    socket.write(pingFrame);

                    // Broadcast event
                    setTimeout(() => {
                        ws.broadcast({
                            type: 'flow:start',
                            stackId: 'ws-stk',
                            namespace: 'test-ns'
                        });
                    }, 20);
                } else if (upgraded) {
                    // Check received broadcast
                    if (data.length > 2) {
                        socket.destroy();
                        done();
                    }
                }
            });
        });
    });

    describe('RedisMonitoringAdapter Transport', () => {
        it('publishes and receives events via pub/sub', async () => {
            let publishedChannel = '';
            let publishedMessage = '';
            let subscriberCallback: ((msg: string) => void) | null = null;

            const mockPublisher = {
                publish: async (channel: string, message: string) => {
                    publishedChannel = channel;
                    publishedMessage = message;
                },
                subscribe: () => {}
            };

            const mockSubscriber = {
                publish: () => {},
                subscribe: (channel: string, cb: any) => {
                    subscriberCallback = cb;
                }
            };

            const adapter = new RedisMonitoringAdapter({
                publisher: mockPublisher,
                subscriber: mockSubscriber,
                channel: 'test:events',
                redaction: { redactKeys: ['pass'] }
            });

            // Publishing
            await adapter.publish({
                type: 'context:change',
                stackId: 'redis-1',
                field: 'pass',
                value: 'mySecret'
            });

            expect(publishedChannel).to.equal('test:events');
            expect(publishedMessage).to.include('[REDACTED]');
            expect(publishedMessage).to.not.include('mySecret');

            // Receiving
            const emitter = new WorkflowEventEmitter();
            adapter.attachToEmitter(emitter);

            let receivedEvent: any = null;
            emitter.on('flow:start', (ev) => {
                receivedEvent = ev;
            });

            subscriberCallback!(JSON.stringify({
                type: 'flow:start',
                stackId: 'redis-incoming'
            }));

            expect(receivedEvent).to.not.be.null;
            expect(receivedEvent.stackId).to.equal('redis-incoming');
        });
    });

    describe('PrometheusExporter', () => {
        it('aggregates events into Prometheus exposition text', () => {
            const exporter = new PrometheusExporter();

            exporter.handleEvent({ type: 'flow:start', stackId: 's1', timestamp: 100 });
            exporter.handleEvent({ type: 'step:retry', stackId: 's1', stepId: 'stp-1', attempt: 2 });
            exporter.handleEvent({ type: 'step:complete', stackId: 's1', stepId: 'stp-1', durationMs: 12 });
            exporter.handleEvent({ type: 'flow:complete', stackId: 's1', status: 'COMPLETED', durationMs: 50, timestamp: 150 });

            const text = exporter.getMetricsAsText();
            expect(text).to.include('siglo_active_flows 0');
            expect(text).to.include('siglo_flows_total{status="completed"} 1');
            expect(text).to.include('siglo_step_retries_total 1');
            expect(text).to.include('siglo_steps_total{status="completed"} 1');
        });
    });

    describe('Web Dashboard & DevTools Server', () => {
        let monitorServer: any;

        before(async () => {
            monitorServer = await createMonitorServer({ port: 0 });
        });

        after(async () => {
            await monitorServer.close();
        });

        it('serves dashboard HTML on GET /', async () => {
            const res = await fetch(`http://127.0.0.1:${monitorServer.port}/`);
            expect(res.status).to.equal(200);
            expect(res.headers.get('content-type')).to.include('text/html');
            const html = await res.text();
            expect(html).to.include('Siglo Live Monitor');
        });

        it('serves Prometheus metrics on GET /metrics', async () => {
            const res = await fetch(`http://127.0.0.1:${monitorServer.port}/metrics`);
            expect(res.status).to.equal(200);
            expect(res.headers.get('content-type')).to.include('text/plain');
            const text = await res.text();
            expect(text).to.include('siglo_active_flows');
        });

        it('serves workflow API list and details', async () => {
            monitorServer.store.addEvent({
                type: 'flow:start',
                stackId: 'server-stk',
                flowName: 'APIFlow',
                timestamp: 100
            });

            const listRes = await fetch(`http://127.0.0.1:${monitorServer.port}/api/workflows`);
            expect(listRes.status).to.equal(200);
            const list = await listRes.json();
            expect(list.some((r: any) => r.stackId === 'server-stk')).to.be.true;

            const detailRes = await fetch(`http://127.0.0.1:${monitorServer.port}/api/workflows/server-stk`);
            expect(detailRes.status).to.equal(200);
            const detail = await detailRes.json();
            expect(detail.flowName).to.equal('APIFlow');

            const notFoundRes = await fetch(`http://127.0.0.1:${monitorServer.port}/api/workflows/unknown-id`);
            expect(notFoundRes.status).to.equal(404);
        });

        it('handles resume and replay endpoints', async () => {
            const replayRes = await fetch(`http://127.0.0.1:${monitorServer.port}/api/workflows/server-stk/replay`, {
                method: 'POST'
            });
            expect(replayRes.status).to.equal(200);

            let suspendedStackId = '';
            const waitingFlow = flow(waitForEvent('token.verified', { correlationKey: 'token-123' }));
            try {
                await waitingFlow.run({}, {
                    durable: true,
                    monitor: (ev) => {
                        if (ev.type === 'flow:start') suspendedStackId = ev.stackId;
                    }
                });
            } catch {
                // Expected workflow suspension
            }
            monitorServer.workflows.set(suspendedStackId, waitingFlow);

            const resumeRes = await fetch(`http://127.0.0.1:${monitorServer.port}/api/workflows/${suspendedStackId}/resume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ payload: { tokenValid: true } })
            });
            expect(resumeRes.status).to.equal(200);
            const resData = await resumeRes.json();
            expect(resData.ok).to.be.true;
        });

        it('ingests external events via POST /api/events', async () => {
            const postRes = await fetch(`http://127.0.0.1:${monitorServer.port}/api/events`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([
                    {
                        type: 'flow:start',
                        stackId: 'ingested-flow-1',
                        flowName: 'IngestedFlow',
                        timestamp: Date.now()
                    },
                    {
                        type: 'step:complete',
                        stackId: 'ingested-flow-1',
                        stepId: 'step-a',
                        durationMs: 42
                    }
                ])
            });

            expect(postRes.status).to.equal(202);
            const resData = await postRes.json();
            expect(resData.ok).to.be.true;
            expect(resData.count).to.equal(2);

            const run = monitorServer.store.getRun('ingested-flow-1');
            expect(run).to.not.be.undefined;
            expect(run.flowName).to.equal('IngestedFlow');
            expect(run.steps['step-a'].status).to.equal('COMPLETED');
            expect(run.steps['step-a'].durationMs).to.equal(42);
        });

        it('tracks active servers in registry and supports reuseExisting', async () => {
            const active = getActiveMonitorServer(monitorServer.port);
            expect(active).to.equal(monitorServer);

            const emitter = getMonitorEmitter(monitorServer.port);
            expect(emitter).to.equal(monitorServer.emitter);

            // Reusing existing server
            const reused = await createMonitorServer({
                port: monitorServer.port,
                reuseExisting: true
            });
            expect(reused).to.equal(monitorServer);
        });

        it('attaches to running server using createMonitorClient and attachToMonitorServer', async () => {
            // Using attachToMonitorServer with instance
            const monitorHook = attachToMonitorServer(monitorServer);
            expect(monitorHook).to.be.a('function');

            // Send event via monitor hook
            monitorHook({
                type: 'flow:start',
                stackId: 'attached-run-1',
                flowName: 'AttachedWorkflow',
                timestamp: Date.now()
            });

            // Verify server received the event
            const run = monitorServer.store.getRun('attached-run-1');
            expect(run).to.not.be.undefined;
            expect(run.flowName).to.equal('AttachedWorkflow');

            // Using createMonitorClient with URL over HTTP
            const client = createMonitorClient({
                url: `http://127.0.0.1:${monitorServer.port}`,
                batchSize: 1
            });

            await client.sendEvent({
                type: 'flow:start',
                stackId: 'remote-client-run-1',
                flowName: 'RemoteWorkflow',
                timestamp: Date.now()
            });

            await client.flush();

            const remoteRun = monitorServer.store.getRun('remote-client-run-1');
            expect(remoteRun).to.not.be.undefined;
            expect(remoteRun.flowName).to.equal('RemoteWorkflow');

            await client.close();
        });
    });

    describe('Framework Middlewares', () => {
        it('supports Express middleware', () => {
            const middleware = createExpressMonitorMiddleware();
            let sentHtml = false;
            const req = { url: '/' };
            const res = {
                setHeader: () => {},
                send: (html: string) => {
                    sentHtml = html.includes('Siglo Live Monitor');
                }
            };
            middleware(req, res, () => {});
            expect(sentHtml).to.be.true;
        });

        it('supports Fastify plugin', (done) => {
            const mockFastify = {
                routes: {} as Record<string, any>,
                get: function (path: string, handler: any) {
                    this.routes[path] = handler;
                }
            };
            fastifyMonitorPlugin(mockFastify, {}, () => {
                expect(mockFastify.routes['/']).to.be.a('function');
                expect(mockFastify.routes['/events']).to.be.a('function');
                expect(mockFastify.routes['/api/workflows']).to.be.a('function');
                done();
            });
        });

        it('supports Hono middleware', async () => {
            const middleware = honoMonitorMiddleware();
            let htmlCalled = false;
            const mockContext = {
                req: { path: '/dashboard' },
                html: () => { htmlCalled = true; return 'ok'; },
                json: () => {}
            };
            await middleware(mockContext, async () => {});
            expect(htmlCalled).to.be.true;
        });
    });

    describe('Security & Remote Attachment Controls', () => {
        let secureServer: any;

        afterEach(async () => {
            if (secureServer) {
                await secureServer.close();
                secureServer = null;
            }
        });

        it('enforces authentication tokens on ingestion and control endpoints', async () => {
            secureServer = await createMonitorServer({
                port: 4099,
                auth: {
                    ingestionKey: 'ingest-secret',
                    adminKey: 'admin-secret'
                }
            });

            // 1. Ingest without token -> 401
            const unauthPost = await fetch(`http://127.0.0.1:4099/api/events`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'flow:start', stackId: 's-1' })
            });
            expect(unauthPost.status).to.equal(401);

            // 2. Ingest with valid Bearer token -> 202
            const authPost = await fetch(`http://127.0.0.1:4099/api/events`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ingest-secret'
                },
                body: JSON.stringify({ type: 'flow:start', stackId: 's-auth-1' })
            });
            expect(authPost.status).to.equal(202);

            // 3. Ingest with X-API-Key header -> 202
            const apiKeyPost = await fetch(`http://127.0.0.1:4099/api/events`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': 'ingest-secret'
                },
                body: JSON.stringify({ type: 'flow:start', stackId: 's-auth-2' })
            });
            expect(apiKeyPost.status).to.equal(202);

            // 4. Ingest with admin key -> 202
            const adminPost = await fetch(`http://127.0.0.1:4099/api/events`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer admin-secret'
                },
                body: JSON.stringify({ type: 'flow:start', stackId: 's-auth-3' })
            });
            expect(adminPost.status).to.equal(202);

            // 5. Read endpoints require read/admin key -> 401 without
            const unauthList = await fetch(`http://127.0.0.1:4099/api/workflows`);
            expect(unauthList.status).to.equal(401);

            const authList = await fetch(`http://127.0.0.1:4099/api/workflows`, {
                headers: { 'Authorization': 'Bearer admin-secret' }
            });
            expect(authList.status).to.equal(200);

            // 6. Resume requires adminKey
            const unauthResume = await fetch(`http://127.0.0.1:4099/api/workflows/s-auth-1/resume`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ingest-secret' } // ingestionKey cannot control
            });
            expect(unauthResume.status).to.equal(401);
        });

        it('disables remote workflow resumption when allowRemoteResume is false', async () => {
            secureServer = await createMonitorServer({
                port: 4098,
                allowRemoteResume: false
            });

            const resumeRes = await fetch(`http://127.0.0.1:4098/api/workflows/any-id/resume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ payload: {} })
            });
            expect(resumeRes.status).to.equal(403);
            const data = await resumeRes.json();
            expect(data.error).to.include('Remote workflow resumption is disabled');

            const replayRes = await fetch(`http://127.0.0.1:4098/api/workflows/any-id/replay`, {
                method: 'POST'
            });
            expect(replayRes.status).to.equal(403);
        });

        it('enforces payload size limits (413 Payload Too Large)', async () => {
            secureServer = await createMonitorServer({
                port: 4097,
                maxPayloadBytes: 256 // Strict 256 bytes cap for testing
            });

            const hugePayload = JSON.stringify({
                type: 'flow:start',
                stackId: 'stk-huge',
                bloat: 'x'.repeat(500)
            });

            try {
                const res = await fetch(`http://127.0.0.1:4097/api/events`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: hugePayload
                });
                expect(res.status).to.equal(413);
            } catch (err: any) {
                // Node fetch may throw if socket destroyed prematurely
                expect(err).to.exist;
            }
        });

        it('hardens CORS with origin whitelisting', async () => {
            secureServer = await createMonitorServer({
                port: 4096,
                cors: {
                    origin: ['https://trusted-dashboard.internal.corp']
                }
            });

            // Trusted origin
            const trustedRes = await fetch(`http://127.0.0.1:4096/api/workflows`, {
                headers: { 'Origin': 'https://trusted-dashboard.internal.corp' }
            });
            expect(trustedRes.headers.get('access-control-allow-origin')).to.equal('https://trusted-dashboard.internal.corp');

            // Untrusted origin
            const untrustedRes = await fetch(`http://127.0.0.1:4096/api/workflows`, {
                headers: { 'Origin': 'https://malicious-site.com' }
            });
            expect(untrustedRes.headers.get('access-control-allow-origin')).to.equal('null');
        });

        it('client enforces bounded queue memory limits and injects auth headers', async () => {
            secureServer = await createMonitorServer({
                port: 4095,
                auth: 'client-key'
            });

            // Client with apiKey and small bounded queue
            const client = createMonitorClient({
                url: 'http://127.0.0.1:4095',
                apiKey: 'client-key',
                maxQueueSize: 3,
                batchSize: 10 // Queue up to 10 before flush
            });

            // Enqueue 5 events into maxQueueSize=3
            for (let i = 1; i <= 5; i++) {
                client.monitor({
                    type: 'context:change',
                    stackId: 'bounded-run',
                    field: `k${i}`,
                    value: i,
                    timestamp: i
                });
            }

            // Only the latest 3 should be kept in the queue
            expect((client as any).queue.length).to.equal(3);
            expect((client as any).queue[0].field).to.equal('k3');
            expect((client as any).queue[1].field).to.equal('k4');
            expect((client as any).queue[2].field).to.equal('k5');

            // Flush with auth header
            await client.flush();

            const run = secureServer.store.getRun('bounded-run');
            expect(run).to.not.be.undefined;
            expect(run.context.k3).to.equal(3);
            expect(run.context.k4).to.equal(4);
            expect(run.context.k5).to.equal(5);

            await client.close();
        });

        it('attachToMonitorServer accepts auth options and forwards to client', async () => {
            secureServer = await createMonitorServer({
                port: 4094,
                auth: 'attach-key'
            });

            const monitor = attachToMonitorServer('http://127.0.0.1:4094', {
                apiKey: 'attach-key',
                batchSize: 1
            });

            monitor({
                type: 'flow:start',
                stackId: 'stk-attached-auth',
                flowName: 'SecuredWorkflow',
                timestamp: Date.now()
            });

            // Wait brief moment for async dispatch
            await new Promise((r) => setTimeout(r, 60));

            const run = secureServer.store.getRun('stk-attached-auth');
            expect(run).to.not.be.undefined;
            expect(run.flowName).to.equal('SecuredWorkflow');
        });
    });

    describe("Phase 5: DevTools Control Plane Hardening & Redaction", () => {
        let p5Server: any;

        afterEach(async () => {
            if (p5Server) {
                await p5Server.close();
                p5Server = null;
            }
        });

        it("strictly rejects resume requests with 404 when workflow is not registered (no default fallback)", async () => {
            p5Server = await createMonitorServer({ port: 4095 });

            const res = await fetch("http://127.0.0.1:4095/api/workflows/unknown-stack-xyz/resume", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ payload: { token: "abc" } })
            });

            expect(res.status).to.equal(404);
            const body = await res.json() as any;
            expect(body.error).to.include("not registered");
        });

        it("enforces schema validation on resume payload with 422 when resumeSchema is defined", async () => {
            // Create flow with Zod-like / function resumeSchema
            const mockFlowWithSchema: any = {
                name: "ValidatedFlow",
                resumeSchema: {
                    safeParse: (payload: any) => {
                        if (!payload || !payload.approvedBy) {
                            return { success: false, error: "Missing approvedBy field" };
                        }
                        return { success: true, data: payload };
                    }
                }
            };

            const workflowsMap = new Map();
            workflowsMap.set("val-flow", mockFlowWithSchema);

            p5Server = await createMonitorServer({
                port: 4096,
                workflows: workflowsMap
            });

            // Add run record to store so it resolves to this workflow
            p5Server.store.addEvent({
                type: "flow:start",
                stackId: "stk-validated-1",
                flowName: "val-flow",
                timestamp: Date.now()
            });

            // 1. Invalid payload -> 422
            const invalidRes = await fetch("http://127.0.0.1:4096/api/workflows/stk-validated-1/resume", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ payload: { comment: "looks good" } })
            });

            expect(invalidRes.status).to.equal(422);
            const errBody = await invalidRes.json() as any;
            expect(errBody.error).to.include("Unprocessable Entity");
            expect(errBody.details).to.include("Missing approvedBy");

            // 2. Function validator support
            const fnFlow: any = {
                name: "FnFlow",
                resumeSchema: (payload: any) => {
                    if (!payload?.amount || payload.amount < 0) {
                        throw new Error("Amount must be positive");
                    }
                    return true;
                }
            };
            workflowsMap.set("fn-flow", fnFlow);
            p5Server.store.addEvent({
                type: "flow:start",
                stackId: "stk-fn-1",
                flowName: "fn-flow",
                timestamp: Date.now()
            });

            const fnInvalidRes = await fetch("http://127.0.0.1:4096/api/workflows/stk-fn-1/resume", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ payload: { amount: -50 } })
            });
            expect(fnInvalidRes.status).to.equal(422);
            const fnErrBody = await fnInvalidRes.json() as any;
            expect(fnErrBody.details).to.include("Amount must be positive");
        });

        it("redacts sensitive fields in /api/workflows and /api/workflows/:id using MonitorSecurityOptions", async () => {
            p5Server = await createMonitorServer({
                port: 4097,
                security: {
                    redactedKeys: ["userPassword", "taxId"],
                    maskFn: (key, val) => (key === "taxId" ? "XXX-XX-XXXX" : undefined)
                }
            });

            p5Server.emitter.emit({
                type: "flow:start",
                stackId: "stk-redact-test",
                flowName: "SecretFlow",
                timestamp: Date.now()
            });

            p5Server.emitter.emit({
                type: "context:change",
                stackId: "stk-redact-test",
                stepId: "step-1",
                field: "userPassword",
                value: "SuperSecretPassword123!"
            });

            p5Server.emitter.emit({
                type: "context:change",
                stackId: "stk-redact-test",
                stepId: "step-1",
                field: "taxId",
                value: "123-45-6789"
            });

            p5Server.emitter.emit({
                type: "context:change",
                stackId: "stk-redact-test",
                stepId: "step-1",
                field: "publicField",
                value: "safeValue"
            });

            // GET single workflow run
            const runRes = await fetch("http://127.0.0.1:4097/api/workflows/stk-redact-test");
            expect(runRes.status).to.equal(200);
            const run = await runRes.json() as any;

            expect(run.context.publicField).to.equal("safeValue");
            expect(run.context.userPassword).to.equal("[REDACTED]");
            expect(run.context.taxId).to.equal("XXX-XX-XXXX");

            // GET workflow list
            const listRes = await fetch("http://127.0.0.1:4097/api/workflows");
            expect(listRes.status).to.equal(200);
            const list = await listRes.json() as any;
            const target = list.find((w: any) => w.stackId === "stk-redact-test");
            expect(target.context.userPassword).to.equal("[REDACTED]");
            expect(target.context.taxId).to.equal("XXX-XX-XXXX");
        });
    });
});
