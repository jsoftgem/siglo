import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { defaultStorageManager, defaultWorkflowEventEmitter, flow, Step, waitForEvent } from '@siglo/core';
import {
    createExpressQueryMiddleware,
    createWorkflowMcpServer,
    createWorkflowQueryEngine,
    MemoryStorageAdapter,
    type WorkflowMcpServer,
} from './index';

interface OrderInput {
    orderId: string;
    customerId: string;
    amount: number;
    secretToken: string;
}

describe('@siglo/query End-to-End Integration Suite (HTTP + GraphQL + SSE + Durable Runtime + MCP)', () => {
    let storage: MemoryStorageAdapter;
    let previousAdapter: ReturnType<typeof defaultStorageManager.getAdapter>;
    let httpServer: HttpServer;
    let mcpServer: WorkflowMcpServer;
    let baseUrl: string;
    let engine: ReturnType<typeof createWorkflowQueryEngine>;

    // 1. Define a real durable order fulfillment workflow (matches tutorial)
    const validateOrder = Step.create('validateOrder', async (input: OrderInput) => {
        if (input.amount <= 0) throw new Error('Invalid order amount');
        return {
            orderId: input.orderId,
            customerId: input.customerId,
            subtotal: input.amount,
            tax: Math.round(input.amount * 0.1),
            total: Math.round(input.amount * 1.1),
            secretToken: input.secretToken,
        };
    });

    const awaitPayment = waitForEvent('payment.confirmed', {
        correlationKey: (ctx: any) => `payment-${ctx.orderId}`,
        timeout: 86_400_000,
    });

    const shipOrder = Step.create('shipOrder', async (ctx: any) => {
        return {
            trackingNumber: `TRACK-${ctx.orderId}`,
            transactionId: ctx.transactionId,
            approvedBy: ctx.approvedBy ?? 'gateway',
            shippedAt: '2026-03-15T10:05:00.000Z',
        };
    });

    const orderWorkflow = flow(validateOrder, awaitPayment, shipOrder).monitor(defaultWorkflowEventEmitter);

    beforeEach(async () => {
        storage = new MemoryStorageAdapter();
        previousAdapter = defaultStorageManager.getAdapter();
        defaultStorageManager.useStorage(storage);

        engine = createWorkflowQueryEngine({
            storage,
            emitter: defaultWorkflowEventEmitter,
            redactFields: ['secretToken', 'apiKey', 'password', 'token', 'secret'],
            resolveWorkflow: checkpoint => {
                if (checkpoint.workflowId === 'order-flow') {
                    return orderWorkflow;
                }
                return undefined;
            },
        });

        const app = express();
        app.use(express.json());

        // Mount GraphQL & SSE endpoint
        app.use(
            '/graphql',
            createExpressQueryMiddleware({
                engine,
                namespace: req => (req.headers['x-tenant-id'] as string) || 'store-tenant-1',
                keepAliveIntervalMs: 15_000,
            }),
        );

        // Mount REST endpoint to trigger durable workflows
        app.post('/api/orders', async (req, res) => {
            const tenant = (req.headers['x-tenant-id'] as string) || 'store-tenant-1';
            const { orderId, amount, customerId, secretToken } = req.body;
            const execution: any = await orderWorkflow.run(
                {
                    orderId,
                    amount,
                    customerId,
                    secretToken: secretToken ?? 'sk_live_order_secret_999',
                },
                {
                    durable: true,
                    workflowId: 'order-flow',
                    namespace: tenant,
                },
            );

            const stackId = typeof execution.$stackId === 'function' ? execution.$stackId() : execution.stackId;
            res.status(202).json({
                stackId,
                status: execution.status,
                correlationKey: execution.correlationKey,
            });
        });

        httpServer = createServer((req, res) => {
            if (req.url?.startsWith('/mcp/')) {
                return;
            }
            app(req, res);
        });

        // Attach MCP SSE server onto the same HTTP server under /mcp/sse and /mcp/messages
        mcpServer = createWorkflowMcpServer({
            engine,
            namespace: 'store-tenant-1',
            transport: 'sse',
            sse: {
                httpServer,
                ssePath: '/mcp/sse',
                messagePath: '/mcp/messages',
            },
        });
        await mcpServer.start();

        await new Promise<void>(resolve => {
            httpServer.listen(0, '127.0.0.1', () => resolve());
        });

        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterEach(async () => {
        await mcpServer.close();
        engine.getSubscriptionManager().close();
        await new Promise<void>(resolve => {
            httpServer.close(() => resolve());
        });
        defaultStorageManager.useStorage(previousAdapter as any);
    });

    async function gqlRequest(
        query: string,
        variables?: Record<string, unknown>,
        tenant = 'store-tenant-1',
    ): Promise<any> {
        const res = await fetch(`${baseUrl}/graphql`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-tenant-id': tenant,
            },
            body: JSON.stringify({ query, variables }),
        });
        assert.equal(res.status, 200);
        return res.json();
    }

    it('executes full GraphQL tutorial lifecycle: trigger -> paginate -> project & redact -> SSE stream -> resume', async () => {
        // 1. Trigger two orders in store-tenant-1 and one in another tenant
        const order1Res = await fetch(`${baseUrl}/api/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'store-tenant-1' },
            body: JSON.stringify({ orderId: 'ORD-1001', amount: 150, customerId: 'CUST-1' }),
        });
        assert.equal(order1Res.status, 202);
        const order1 = (await order1Res.json()) as { stackId: string; status: string; correlationKey: string };
        assert.equal(order1.status, 'waiting');
        assert.equal(order1.correlationKey, 'payment-ORD-1001');

        const order2Res = await fetch(`${baseUrl}/api/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'store-tenant-1' },
            body: JSON.stringify({ orderId: 'ORD-1002', amount: 300, customerId: 'CUST-2' }),
        });
        assert.equal(order2Res.status, 202);
        const order2 = (await order2Res.json()) as { stackId: string; status: string; correlationKey: string };

        // Trigger isolated order in other-tenant
        const otherRes = await fetch(`${baseUrl}/api/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'tenant-other' },
            body: JSON.stringify({ orderId: 'ORD-9999', amount: 500, customerId: 'CUST-9' }),
        });
        assert.equal(otherRes.status, 202);

        // 2. Paginate waiting workflows in store-tenant-1 (limit: 1)
        const listQuery = `
            query ListWaiting($cursor: String) {
                workflows(
                    filter: { status: WAITING }
                    sort: { field: CREATED_AT, direction: DESC }
                    pagination: { limit: 1, cursor: $cursor }
                ) {
                    totalCount
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                    edges {
                        cursor
                        node {
                            stackId
                            status
                            waitRecord {
                                correlationKey
                                eventName
                            }
                        }
                    }
                }
            }
        `;

        const page1 = await gqlRequest(listQuery);
        assert.equal(page1.errors, undefined);
        assert.equal(page1.data.workflows.totalCount, 2);
        assert.equal(page1.data.workflows.pageInfo.hasNextPage, true);
        assert.equal(page1.data.workflows.edges.length, 1);
        assert.equal(page1.data.workflows.edges[0].node.waitRecord.eventName, 'payment.confirmed');

        const page2 = await gqlRequest(listQuery, {
            cursor: page1.data.workflows.pageInfo.endCursor,
        });
        assert.equal(page2.errors, undefined);
        assert.equal(page2.data.workflows.pageInfo.hasNextPage, false);
        assert.equal(page2.data.workflows.edges.length, 1);

        const listedIds = new Set([
            page1.data.workflows.edges[0].node.stackId,
            page2.data.workflows.edges[0].node.stackId,
        ]);
        assert.deepEqual(listedIds, new Set([order1.stackId, order2.stackId]));

        // 3. Selective Context Projection & Redaction on ORD-1001
        const inspectQuery = `
            query InspectOrder($stackId: ID!) {
                workflow(stackId: $stackId) {
                    stackId
                    status
                    context
                    total: context(path: "total")
                    steps {
                        stepId
                        status
                        output
                    }
                }
            }
        `;
        const inspected = await gqlRequest(inspectQuery, { stackId: order1.stackId });
        assert.equal(inspected.errors, undefined);
        assert.equal(inspected.data.workflow.status, 'WAITING');
        assert.equal(inspected.data.workflow.total, 165);
        assert.equal(inspected.data.workflow.context.secretToken, '[REDACTED]');
        assert.ok(inspected.data.workflow.steps.length >= 1);
        assert.ok(
            inspected.data.workflow.steps.some(
                (step: any) => step.output?.orderId === 'ORD-1001' && step.output?.secretToken === '[REDACTED]',
            ),
        );

        // 4. Subscribe to live SSE updates on ORD-1001 before resuming
        const sseAbort = new AbortController();
        const sseQuery = `
            subscription OnOrderUpdated($id: ID!) {
                workflowUpdated(stackId: $id) {
                    stackId
                    status
                    context
                }
            }
        `;
        const sseUrl = `${baseUrl}/graphql?query=${encodeURIComponent(sseQuery)}&variables=${encodeURIComponent(
            JSON.stringify({ id: order1.stackId }),
        )}`;

        const sseResponse = await fetch(sseUrl, {
            headers: {
                Accept: 'text/event-stream',
                'x-tenant-id': 'store-tenant-1',
            },
            signal: sseAbort.signal,
        });
        assert.equal(sseResponse.status, 200);
        assert.ok(sseResponse.body);
        const reader = sseResponse.body.getReader();

        const nextSseEventPromise = (async () => {
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const frames = buffer.split('\n\n');
                buffer = frames.pop() ?? '';
                for (const frame of frames) {
                    const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
                    if (dataLine) {
                        const parsed = JSON.parse(dataLine.slice(6));
                        if (parsed.data?.workflowUpdated?.status === 'COMPLETED') {
                            return parsed.data.workflowUpdated;
                        }
                    }
                }
            }
            return null;
        })();

        // 5. Resume ORD-1001 via GraphQL mutation
        const resumeMutation = `
            mutation ResumePayment($key: String!, $payload: JSON) {
                resumeWorkflow(correlationKey: $key, payload: $payload)
            }
        `;
        const resumeResult = await gqlRequest(resumeMutation, {
            key: 'payment-ORD-1001',
            payload: { transactionId: 'TXN-998877' },
        });
        assert.equal(resumeResult.errors, undefined);
        assert.equal(resumeResult.data.resumeWorkflow, true);

        // 6. Verify live SSE stream received the COMPLETED transition with shipOrder output
        const completedEvent = await nextSseEventPromise;
        assert.ok(completedEvent);
        assert.equal(completedEvent.stackId, order1.stackId);
        assert.equal(completedEvent.status, 'COMPLETED');
        assert.equal(completedEvent.context.trackingNumber, 'TRACK-ORD-1001');
        assert.equal(completedEvent.context.transactionId, 'TXN-998877');
        assert.equal(completedEvent.context.secretToken, '[REDACTED]');

        sseAbort.abort();
        await reader.cancel().catch(() => {});
    });

    it('executes full MCP Agent lifecycle over live HTTP SSE: active resources, search, inspect, diagnose, and resume', async () => {
        // 1. Trigger a waiting order (ORD-2001) via HTTP API
        const orderRes = await fetch(`${baseUrl}/api/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'store-tenant-1' },
            body: JSON.stringify({ orderId: 'ORD-2001', amount: 400, customerId: 'CUST-MCP' }),
        });
        const order = (await orderRes.json()) as { stackId: string; correlationKey: string };

        // 2. Also persist a failed workflow checkpoint to test MCP failure diagnosis end-to-end
        await storage.saveCheckpoint({
            stackId: 'stack-failed-2002',
            version: 2,
            revision: 2,
            timestamp: Date.now(),
            type: 'execution',
            namespace: 'store-tenant-1',
            workflowId: 'order-flow',
            status: 'failed',
            chains: ['validateOrder'],
            contexts: {
                validateOrder: {
                    orderId: 'ORD-2002',
                    subtotal: 950,
                    secretToken: 'sk_live_never_expose',
                },
            },
            metadata: {
                orderId: 'ORD-2002',
                secretToken: 'sk_live_metadata_secret',
                failedStep: 'chargeGateway',
                error: {
                    name: 'InsufficientFundsException',
                    message: 'Card declined by issuer',
                    stepName: 'chargeGateway',
                    apiKey: 'sk_live_gateway_key',
                },
            },
        });

        // 3. Connect real MCP Client over HTTP SSE transport
        const mcpClient = new Client({ name: 'e2e-ai-assistant', version: '1.0.0' }, { capabilities: {} });
        const sseTransport = new SSEClientTransport(new URL(`${baseUrl}/mcp/sse`));
        await mcpClient.connect(sseTransport);

        try {
            // 4. Read siglo://workflows/active resource -> should contain ORD-2001 (WAITING)
            const activeRes = await mcpClient.readResource({ uri: 'siglo://workflows/active' });
            const activeData = JSON.parse((activeRes.contents[0] as any).text);
            assert.equal(activeData.namespace, 'store-tenant-1');
            assert.equal(activeData.activeCount, 1);
            assert.equal(activeData.workflows[0].stackId, order.stackId);
            assert.equal(activeData.workflows[0].status, 'WAITING');
            assert.equal(activeData.workflows[0].waitRecord.correlationKey, 'payment-ORD-2001');

            // 5. Diagnose failed order ORD-2002 using search_workflows -> inspect_workflow -> diagnose_failure prompt
            const searchFailed = await mcpClient.callTool({
                name: 'search_workflows',
                arguments: {
                    status: 'FAILED',
                    metadataFilter: { orderId: 'ORD-2002' },
                },
            });
            assert.ok(!searchFailed.isError);
            const failedList = JSON.parse((searchFailed.content as any)[0].text);
            assert.equal(failedList.totalCount, 1);
            assert.equal(failedList.workflows[0].stackId, 'stack-failed-2002');
            assert.equal(failedList.workflows[0].metadata.secretToken, '[REDACTED]');

            const inspectFailed = await mcpClient.callTool({
                name: 'inspect_workflow',
                arguments: {
                    stackId: 'stack-failed-2002',
                    includeSteps: true,
                },
            });
            assert.ok(!inspectFailed.isError);
            const failedDetail = JSON.parse((inspectFailed.content as any)[0].text);
            assert.equal(failedDetail.status, 'FAILED');
            assert.equal(failedDetail.error.name, 'InsufficientFundsException');
            assert.equal(failedDetail.error.apiKey, '[REDACTED]');
            assert.equal(failedDetail.context.secretToken, '[REDACTED]');
            assert.equal(failedDetail.steps[1].stepId, 'chargeGateway');
            assert.equal(failedDetail.steps[1].status, 'FAILED');

            const promptRes = await mcpClient.getPrompt({
                name: 'diagnose_failure',
                arguments: { stackId: 'stack-failed-2002' },
            });
            const promptText = (promptRes.messages[0].content as any).text as string;
            assert.ok(promptText.includes('InsufficientFundsException'));
            assert.ok(promptText.includes('chargeGateway'));
            assert.ok(!promptText.includes('sk_live_never_expose'));
            assert.ok(!promptText.includes('sk_live_gateway_key'));

            // 6. Resume waiting workflow ORD-2001 via MCP resume_workflow tool
            const resumeToolRes = await mcpClient.callTool({
                name: 'resume_workflow',
                arguments: {
                    correlationKey: order.correlationKey,
                    payload: {
                        transactionId: 'TXN-MCP-2001',
                        approvedBy: 'claude-operator',
                    },
                },
            });
            assert.ok(!resumeToolRes.isError);
            const resumeJson = JSON.parse((resumeToolRes.content as any)[0].text);
            assert.equal(resumeJson.resumed, true);

            // 7. Read siglo://workflows/{stackId} resource to verify ORD-2001 completed
            const snapshotRes = await mcpClient.readResource({
                uri: `siglo://workflows/${order.stackId}`,
            });
            const snapshot = JSON.parse((snapshotRes.contents[0] as any).text);
            assert.equal(snapshot.status, 'COMPLETED');
            assert.equal(snapshot.context.trackingNumber, 'TRACK-ORD-2001');
            assert.equal(snapshot.context.transactionId, 'TXN-MCP-2001');
            assert.equal(snapshot.context.approvedBy, 'claude-operator');
            assert.equal(snapshot.context.secretToken, '[REDACTED]');

            // 8. Verify siglo://workflows/active is now empty (0 active workflows)
            const activeAfterRes = await mcpClient.readResource({ uri: 'siglo://workflows/active' });
            const activeAfter = JSON.parse((activeAfterRes.contents[0] as any).text);
            assert.equal(activeAfter.activeCount, 0);
        } finally {
            await mcpClient.close();
        }
    });
});
