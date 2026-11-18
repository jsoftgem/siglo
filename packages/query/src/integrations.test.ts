import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WorkflowEventEmitter, type SerializedExecutionStack } from '@siglo/core';
import {
    createExpressQueryMiddleware,
    createHonoQueryHandler,
    createWorkflowQueryEngine,
    fastifyQueryPlugin,
    MemoryStorageAdapter,
} from './index';

function makeCheckpoint(stackId: string, overrides: Partial<SerializedExecutionStack> = {}): SerializedExecutionStack {
    return {
        stackId,
        version: 2,
        revision: 1,
        timestamp: new Date('2026-03-01T12:00:00Z').getTime(),
        type: 'execution',
        namespace: 'acme',
        workflowId: 'order-flow',
        chains: ['step-pay'],
        contexts: {
            'step-pay': { amount: 250, token: 'secret-tok-99' },
        },
        metadata: {
            tenantId: 'acme',
            secret: 'top-secret-val',
        },
        ...overrides,
    };
}

type RouteHandler = (...args: any[]) => any;

describe('@siglo/query framework integrations (Milestone 5)', () => {
    let storage: MemoryStorageAdapter;
    let emitter: WorkflowEventEmitter;
    let engine: ReturnType<typeof createWorkflowQueryEngine>;

    beforeEach(async () => {
        storage = new MemoryStorageAdapter();
        emitter = new WorkflowEventEmitter();
        engine = createWorkflowQueryEngine({
            storage,
            emitter,
            redactFields: ['secret', 'token'],
        });

        await storage.saveCheckpoint(makeCheckpoint('order-101'));
        await storage.saveCheckpoint(makeCheckpoint('order-102', { namespace: 'other-tenant' }));
    });

    afterEach(() => {
        engine.getSubscriptionManager().close();
    });

    describe('Express Middleware (createExpressQueryMiddleware)', () => {
        it('handles POST queries and returns redacted JSON response', async () => {
            const middleware = createExpressQueryMiddleware({
                engine,
                namespace: 'acme',
            });

            let statusCode = 200;
            let jsonBody: any = null;
            const headers: Record<string, string> = {};

            const req: any = {
                method: 'POST',
                body: {
                    query: `{ workflow(stackId: "order-101") { stackId namespace metadata context } }`,
                },
                headers: {},
            };
            const res: any = {
                status(code: number) {
                    statusCode = code;
                    return this;
                },
                setHeader(k: string, v: string) {
                    headers[k] = v;
                },
                json(data: any) {
                    jsonBody = data;
                    return this;
                },
            };

            await middleware(req, res);

            assert.equal(statusCode, 200);
            assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
            assert.equal(jsonBody.data?.workflow?.stackId, 'order-101');
            assert.equal(jsonBody.data?.workflow?.namespace, 'acme');
            assert.equal(jsonBody.data?.workflow?.metadata?.secret, '[REDACTED]');
            assert.equal(jsonBody.data?.workflow?.context?.token, '[REDACTED]');
        });

        it('handles GET queries with variables', async () => {
            const middleware = createExpressQueryMiddleware({
                engine,
                namespace: () => 'acme',
            });

            let jsonBody: any = null;
            const req: any = {
                method: 'GET',
                query: {
                    query: `query GetWf($id: ID!) { workflow(stackId: $id) { stackId } }`,
                    variables: JSON.stringify({ id: 'order-101' }),
                },
                headers: {},
            };
            const res: any = {
                setHeader: () => {},
                json: (d: any) => {
                    jsonBody = d;
                },
            };

            await middleware(req, res);
            assert.equal(jsonBody.data?.workflow?.stackId, 'order-101');
        });

        it('handles OPTIONS preflight request', async () => {
            const middleware = createExpressQueryMiddleware({ engine });
            let statusCode = 0;
            const headers: Record<string, string> = {};
            let ended = false;

            const req: any = { method: 'OPTIONS' };
            const res: any = {
                status: (c: number) => {
                    statusCode = c;
                    return res;
                },
                setHeader: (k: string, v: string) => {
                    headers[k] = v;
                },
                end: () => {
                    ended = true;
                },
            };

            await middleware(req, res);
            assert.equal(statusCode, 204);
            assert.equal(headers['Allow'], 'GET, POST, OPTIONS');
            assert.equal(ended, true);
        });

        it('respects allowHeaderNamespace when configured', async () => {
            const middleware = createExpressQueryMiddleware({
                engine,
                allowHeaderNamespace: true,
            });

            let jsonBody: any = null;
            const req: any = {
                method: 'POST',
                body: { query: `{ workflow(stackId: "order-101") { stackId } }` },
                headers: { 'x-namespace': 'acme' },
            };
            const res: any = {
                setHeader: () => {},
                json: (d: any) => {
                    jsonBody = d;
                },
            };

            await middleware(req, res);
            assert.equal(jsonBody.data?.workflow?.stackId, 'order-101');
        });

        it('rejects cross-tenant access when authenticated namespace differs', async () => {
            const middleware = createExpressQueryMiddleware({
                engine,
                namespace: 'acme',
            });

            let jsonBody: any = null;
            const req: any = {
                method: 'POST',
                body: { query: `{ workflow(stackId: "order-101", namespace: "attacker") { stackId } }` },
                headers: {},
            };
            const res: any = {
                status: () => res,
                setHeader: () => {},
                json: (d: any) => {
                    jsonBody = d;
                },
            };

            await middleware(req, res);
            assert.ok(jsonBody.errors?.[0]?.message.includes('namespace does not match'));
        });

        it('streams SSE subscriptions over HTTP ServerResponse', async () => {
            const middleware = createExpressQueryMiddleware({
                engine,
                namespace: 'acme',
            });

            const written: string[] = [];
            const mockRes: any = new EventEmitter();
            mockRes.writeHead = () => {};
            mockRes.setHeader = () => {};
            mockRes.write = (chunk: string) => {
                written.push(chunk);
                return true;
            };
            mockRes.end = () => {};

            const req: any = {
                method: 'POST',
                headers: { accept: 'text/event-stream' },
                body: {
                    query: `subscription { workflowUpdated(stackId: "order-101") { stackId status } }`,
                },
            };

            await middleware(req, mockRes);

            // Emit update event
            setTimeout(() => {
                emitter.emit({
                    type: 'checkpoint:save',
                    stackId: 'order-101',
                    namespace: 'acme',
                    status: 'running',
                    timestamp: Date.now(),
                });
            }, 10);

            await new Promise(r => setTimeout(r, 40));
            assert.ok(written.length > 0);
            assert.ok(written[0].includes('workflowUpdated'));
            assert.ok(written[0].includes('order-101'));
        });
    });

    describe('Fastify Plugin (fastifyQueryPlugin)', () => {
        it('registers routes and executes queries returning JSON', async () => {
            const routes: Record<string, RouteHandler> = {};
            const mockFastify: any = {
                get(path: string, fn: RouteHandler) {
                    routes[`GET:${path}`] = fn;
                },
                post(path: string, fn: RouteHandler) {
                    routes[`POST:${path}`] = fn;
                },
            };

            let doneCalled = false;
            fastifyQueryPlugin(
                mockFastify,
                {
                    engine,
                    namespace: 'acme',
                    path: '/api/graphql',
                },
                () => {
                    doneCalled = true;
                },
            );

            assert.equal(doneCalled, true);
            assert.ok(routes['GET:/api/graphql']);
            assert.ok(routes['POST:/api/graphql']);

            // Execute POST route
            let sentData: any = null;
            let statusSet = 0;
            const reply = {
                status(s: number) {
                    statusSet = s;
                    return this;
                },
                type() {
                    return this;
                },
                send(d: any) {
                    sentData = d;
                    return this;
                },
            };

            await routes['POST:/api/graphql'](
                {
                    body: { query: `{ workflow(stackId: "order-101") { stackId status } }` },
                    headers: {},
                },
                reply,
            );

            assert.equal(statusSet, 200);
            assert.equal(sentData.data?.workflow?.stackId, 'order-101');
            assert.equal(sentData.data?.workflow?.status, 'RUNNING');
        });

        it('streams SSE subscriptions using reply.raw', async () => {
            const routes: Record<string, RouteHandler> = {};
            const mockFastify: any = {
                get: (p: string, fn: RouteHandler) => {
                    routes[`GET:${p}`] = fn;
                },
                post: (p: string, fn: RouteHandler) => {
                    routes[`POST:${p}`] = fn;
                },
            };

            fastifyQueryPlugin(mockFastify, { engine, namespace: 'acme' }, () => {});

            const written: string[] = [];
            const rawRes: any = new EventEmitter();
            rawRes.writeHead = () => {};
            rawRes.setHeader = () => {};
            rawRes.write = (c: string) => {
                written.push(c);
                return true;
            };
            rawRes.end = () => {};

            const reply = {
                raw: rawRes,
            };

            await routes['POST:/graphql'](
                {
                    body: { query: `subscription { workflowUpdated(stackId: "order-101") { stackId } }` },
                    headers: {},
                },
                reply,
            );

            setTimeout(() => {
                emitter.emit({
                    type: 'checkpoint:save',
                    stackId: 'order-101',
                    namespace: 'acme',
                    status: 'running',
                    timestamp: Date.now(),
                });
            }, 10);

            await new Promise(r => setTimeout(r, 40));
            assert.ok(written.length > 0);
            assert.ok(written[0].includes('order-101'));
        });
    });

    describe('Hono Handler (createHonoQueryHandler)', () => {
        it('handles POST queries and returns Web JSON response', async () => {
            const handler = createHonoQueryHandler({
                engine,
                namespace: 'acme',
            });

            const mockContext: any = {
                req: {
                    method: 'POST',
                    json: async () => ({
                        query: `{ workflow(stackId: "order-101") { stackId status metadata } }`,
                    }),
                    header: () => undefined,
                },
                json: (data: any, status = 200) => ({ data, status }),
            };

            const response = await handler(mockContext);
            assert.equal(response.status, 200);
            assert.equal(response.data?.data?.workflow?.stackId, 'order-101');
            assert.equal(response.data?.data?.workflow?.metadata?.secret, '[REDACTED]');
        });

        it('handles GET queries with search params', async () => {
            const handler = createHonoQueryHandler({
                engine,
                namespace: 'acme',
            });

            const queryMap: Record<string, string> = {
                query: `{ workflow(stackId: "order-101") { stackId } }`,
            };

            const mockContext: any = {
                req: {
                    method: 'GET',
                    query: (k: string) => queryMap[k],
                    header: () => undefined,
                },
                json: (data: any, status = 200) => ({ data, status }),
            };

            const response = await handler(mockContext);
            assert.equal(response.status, 200);
            assert.equal(response.data?.data?.workflow?.stackId, 'order-101');
        });

        it('handles OPTIONS preflight with 204 Web Response', async () => {
            const handler = createHonoQueryHandler({ engine });
            const mockContext: any = {
                req: { method: 'OPTIONS' },
            };

            const res = await handler(mockContext);
            assert.equal(res.status, 204);
            assert.equal(res.headers.get('Allow'), 'GET, POST, OPTIONS');
        });

        it('returns standard Web SSE Response for subscriptions', async () => {
            const handler = createHonoQueryHandler({
                engine,
                namespace: 'acme',
            });

            const mockContext: any = {
                req: {
                    method: 'POST',
                    header: (k: string) => (k.toLowerCase() === 'accept' ? 'text/event-stream' : undefined),
                    json: async () => ({
                        query: `subscription { workflowUpdated(stackId: "order-101") { stackId } }`,
                    }),
                },
            };

            const response: Response = await handler(mockContext);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
            assert.ok(response.body);

            // Read first SSE chunk
            const reader = response.body.getReader();
            setTimeout(() => {
                emitter.emit({
                    type: 'checkpoint:save',
                    stackId: 'order-101',
                    namespace: 'acme',
                    status: 'running',
                    timestamp: Date.now(),
                });
            }, 10);

            const { value } = await reader.read();
            const text = new TextDecoder().decode(value);
            assert.ok(text.includes('order-101'));
            await reader.cancel();
        });
    });
});
