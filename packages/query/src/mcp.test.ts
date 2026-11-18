import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import {
    defaultStorageManager,
    flow,
    Step,
    waitForEvent,
    WorkflowEventEmitter,
    type SerializedExecutionStack,
} from '@siglo/core';
import { MemoryStorageAdapter } from './memory';
import {
    createWorkflowMcpServer,
    WORKFLOW_MCP_PROMPTS,
    WORKFLOW_MCP_RESOURCES,
    WORKFLOW_MCP_RESOURCE_TEMPLATES,
    WORKFLOW_MCP_TOOLS,
} from './mcp';

function makeCheckpoint(stackId: string, overrides: Partial<SerializedExecutionStack> = {}): SerializedExecutionStack {
    return {
        stackId,
        version: 2,
        revision: 1,
        timestamp: new Date('2026-03-15T09:14:00.000Z').getTime(),
        type: 'execution',
        namespace: 'acme',
        workflowId: 'order-checkout',
        status: 'running',
        chains: ['validateCart'],
        contexts: {
            validateCart: {
                orderId: '101',
                subtotal: 199,
                apiKey: 'sk_live_super_secret',
                payment: {
                    method: 'card',
                    last4: '4242',
                    token: 'tok_secret_123',
                },
            },
        },
        metadata: {
            orderId: '101',
            customerTier: 'enterprise',
            secret: 'meta_secret_value',
        },
        ...overrides,
    };
}

describe('@siglo/query/mcp Model Context Protocol Server (Milestone 6)', () => {
    let storage: MemoryStorageAdapter;
    let emitter: WorkflowEventEmitter;

    beforeEach(async () => {
        storage = new MemoryStorageAdapter();
        emitter = new WorkflowEventEmitter();

        // 1. Active running workflow
        await storage.saveCheckpoint(
            makeCheckpoint('stack-running-1', {
                status: 'running',
                timestamp: new Date('2026-03-15T09:10:00.000Z').getTime(),
                metadata: { orderId: '100', secret: 'hidden-meta-100' },
            }),
        );

        // 2. Failed workflow (Order 101 - matches roadmap sequence diagram)
        await storage.saveCheckpoint(
            makeCheckpoint('stack-order-101', {
                status: 'failed',
                timestamp: new Date('2026-03-15T09:14:00.000Z').getTime(),
                metadata: {
                    orderId: '101',
                    failedStep: 'chargeStripe',
                    error: {
                        name: 'CardExpiredException',
                        message: "Customer's credit card was expired",
                        stepName: 'chargeStripe',
                        apiKey: 'sk_live_leak_attempt',
                    },
                    secret: 'hidden-meta-101',
                },
            }),
        );

        // 3. Completed workflow
        await storage.saveCheckpoint(
            makeCheckpoint('stack-completed-1', {
                status: 'completed',
                timestamp: new Date('2026-03-15T08:00:00.000Z').getTime(),
                metadata: { orderId: '099' },
            }),
        );

        // 4. Other tenant workflow (must be isolated)
        await storage.saveCheckpoint(
            makeCheckpoint('stack-other-tenant', {
                namespace: 'globex',
                status: 'running',
                metadata: { orderId: '101' },
            }),
        );
    });

    async function createConnectedClient(options: Parameters<typeof createWorkflowMcpServer>[0] = {}) {
        const mcpServer = createWorkflowMcpServer({
            storage,
            emitter,
            namespace: 'acme',
            redactFields: ['apiKey', 'password', 'token', 'secret'],
            ...options,
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'test-llm-client', version: '1.0.0' }, { capabilities: {} });

        await mcpServer.connect(serverTransport);
        await client.connect(clientTransport);

        return {
            mcpServer,
            client,
            async cleanup() {
                await client.close();
                await mcpServer.close();
            },
        };
    }

    describe('Capabilities Discovery (Tools, Resources, Prompts)', () => {
        it('lists all 4 MCP tools, static resources, resource templates, and prompts', async () => {
            const { client, cleanup } = await createConnectedClient();
            try {
                const { tools } = await client.listTools();
                assert.equal(tools.length, WORKFLOW_MCP_TOOLS.length);
                assert.deepEqual(
                    tools.map(t => t.name),
                    ['search_workflows', 'inspect_workflow', 'execute_workflow_query', 'resume_workflow'],
                );

                const { resources } = await client.listResources();
                assert.equal(resources.length, WORKFLOW_MCP_RESOURCES.length);
                assert.deepEqual(
                    resources.map(r => r.uri),
                    ['siglo://workflows/active', 'siglo://schema/graphql'],
                );

                const { resourceTemplates } = await client.listResourceTemplates();
                assert.equal(resourceTemplates.length, WORKFLOW_MCP_RESOURCE_TEMPLATES.length);
                assert.equal(resourceTemplates[0].uriTemplate, 'siglo://workflows/{stackId}');

                const { prompts } = await client.listPrompts();
                assert.equal(prompts.length, WORKFLOW_MCP_PROMPTS.length);
                assert.equal(prompts[0].name, 'diagnose_failure');
            } finally {
                await cleanup();
            }
        });
    });

    describe('MCP Tools Execution & Redaction Verification', () => {
        it('simulates LLM root-cause diagnosis: search_workflows -> inspect_workflow with redaction', async () => {
            const { client, cleanup } = await createConnectedClient();
            try {
                // Step 1: LLM translates "Why did order 101 fail?" into search_workflows
                const searchRes = await client.callTool({
                    name: 'search_workflows',
                    arguments: {
                        metadataFilter: { orderId: '101' },
                    },
                });
                assert.ok(!searchRes.isError);
                const searchData = JSON.parse((searchRes.content as any)[0].text);
                assert.equal(searchData.totalCount, 1);
                assert.equal(searchData.workflows.length, 1);

                const match = searchData.workflows[0];
                assert.equal(match.stackId, 'stack-order-101');
                assert.equal(match.status, 'FAILED');
                assert.equal(match.namespace, 'acme');
                // Summary must omit heavy context and steps, and redact metadata secrets
                assert.equal(match.context, undefined);
                assert.equal(match.steps, undefined);
                assert.equal(match.metadata.secret, '[REDACTED]');

                // Step 2: LLM calls inspect_workflow for failure details
                const inspectRes = await client.callTool({
                    name: 'inspect_workflow',
                    arguments: {
                        stackId: match.stackId,
                        includeSteps: true,
                    },
                });
                assert.ok(!inspectRes.isError);
                const detail = JSON.parse((inspectRes.content as any)[0].text);
                assert.equal(detail.stackId, 'stack-order-101');
                assert.equal(detail.status, 'FAILED');
                assert.equal(detail.error.name, 'CardExpiredException');
                assert.equal(detail.error.stepName, 'chargeStripe');
                assert.equal(detail.error.apiKey, '[REDACTED]');

                // Verify steps include completed step and failed step with redacted outputs
                assert.equal(detail.steps.length, 2);
                assert.equal(detail.steps[0].stepId, 'validateCart');
                assert.equal(detail.steps[0].status, 'COMPLETED');
                assert.equal(detail.steps[0].output.apiKey, '[REDACTED]');
                assert.equal(detail.steps[0].output.payment.token, '[REDACTED]');
                assert.equal(detail.steps[1].stepId, 'chargeStripe');
                assert.equal(detail.steps[1].status, 'FAILED');
                assert.equal(detail.steps[1].error.name, 'CardExpiredException');
                assert.equal(detail.steps[1].error.apiKey, '[REDACTED]');

                // Verify accumulated context is also redacted
                assert.equal(detail.context.apiKey, '[REDACTED]');
                assert.equal(detail.context.payment.token, '[REDACTED]');
                assert.equal(detail.context.payment.last4, '4242');
            } finally {
                await cleanup();
            }
        });

        it('supports targeted contextPath extraction and includeSteps=false in inspect_workflow', async () => {
            const { client, cleanup } = await createConnectedClient();
            try {
                const res = await client.callTool({
                    name: 'inspect_workflow',
                    arguments: {
                        stackId: 'stack-order-101',
                        contextPath: 'payment',
                        includeSteps: false,
                    },
                });
                assert.ok(!res.isError);
                const detail = JSON.parse((res.content as any)[0].text);
                assert.deepEqual(detail.context, {
                    method: 'card',
                    last4: '4242',
                    token: '[REDACTED]',
                });
                assert.equal(detail.steps, undefined);
            } finally {
                await cleanup();
            }
        });

        it('executes valid GraphQL queries via execute_workflow_query and blocks redact: false', async () => {
            const { client, cleanup } = await createConnectedClient();
            try {
                const validRes = await client.callTool({
                    name: 'execute_workflow_query',
                    arguments: {
                        query: `
                            query GetOrder($id: ID!) {
                                workflow(stackId: $id) {
                                    stackId
                                    status
                                    context
                                }
                            }
                        `,
                        variables: { id: 'stack-order-101' },
                    },
                });
                assert.ok(!validRes.isError);
                const gqlPayload = JSON.parse((validRes.content as any)[0].text);
                assert.equal(gqlPayload.data.workflow.stackId, 'stack-order-101');
                assert.equal(gqlPayload.data.workflow.status, 'FAILED');
                assert.equal(gqlPayload.data.workflow.context.apiKey, '[REDACTED]');

                // Attempt to bypass redaction via inline redact: false
                const bypassInline = await client.callTool({
                    name: 'execute_workflow_query',
                    arguments: {
                        query: `{ workflow(stackId: "stack-order-101") { context(redact: false) } }`,
                    },
                });
                assert.equal(bypassInline.isError, true);
                assert.ok((bypassInline.content as any)[0].text.includes('Unredacted field access'));

                // Attempt to bypass redaction via variable $redact: false
                const bypassVar = await client.callTool({
                    name: 'execute_workflow_query',
                    arguments: {
                        query: `query Bypass($r: Boolean) { workflow(stackId: "stack-order-101") { steps { output(redact: $r) } } }`,
                        variables: { r: false },
                    },
                });
                assert.equal(bypassVar.isError, true);
                assert.ok((bypassVar.content as any)[0].text.includes('Unredacted field access'));
            } finally {
                await cleanup();
            }
        });

        it('resumes a suspended durable workflow via resume_workflow tool', async () => {
            const previousAdapter = defaultStorageManager.getAdapter();
            defaultStorageManager.useStorage(storage);

            const approvalWorkflow = flow(
                Step.create('prepareOrder', async (input: { orderId: string }) => ({
                    orderId: input.orderId,
                    prepared: true,
                })),
                waitForEvent('manager.approved', {
                    correlationKey: ctx => `approval-${(ctx as any).orderId}`,
                }),
                Step.create('finalizeOrder', async (ctx: any) => ({
                    finalized: true,
                    approvedBy: ctx.approvedBy,
                })),
            );

            const { client, cleanup } = await createConnectedClient({
                resolveWorkflow: () => approvalWorkflow,
            });

            try {
                const suspended: any = await approvalWorkflow.run(
                    { orderId: 'ORD-500' },
                    {
                        durable: true,
                        namespace: 'acme',
                        workflowId: 'approval-flow',
                    },
                );
                assert.equal(suspended.status, 'waiting');
                const stackId = typeof suspended.$stackId === 'function' ? suspended.$stackId() : suspended.stackId;

                const resumeRes = await client.callTool({
                    name: 'resume_workflow',
                    arguments: {
                        correlationKey: 'approval-ORD-500',
                        payload: { approvedBy: 'alice@acme.io' },
                    },
                });
                assert.ok(!resumeRes.isError);
                const resumeData = JSON.parse((resumeRes.content as any)[0].text);
                assert.equal(resumeData.resumed, true);

                // Inspect resumed workflow via MCP
                const inspectRes = await client.callTool({
                    name: 'inspect_workflow',
                    arguments: { stackId },
                });
                const detail = JSON.parse((inspectRes.content as any)[0].text);
                assert.equal(detail.status, 'COMPLETED');
                assert.equal(detail.context.finalized, true);
                assert.equal(detail.context.approvedBy, 'alice@acme.io');
            } finally {
                await cleanup();
                defaultStorageManager.useStorage(previousAdapter as any);
            }
        });

        it('enforces tenant isolation when tool arguments conflict with bound namespace', async () => {
            const { client, cleanup } = await createConnectedClient({ namespace: 'acme' });
            try {
                const crossTenantRes = await client.callTool({
                    name: 'search_workflows',
                    arguments: { namespace: 'globex' },
                });
                assert.equal(crossTenantRes.isError, true);
                assert.ok(
                    (crossTenantRes.content as any)[0].text.includes('does not match the MCP server tenant scope'),
                );

                const crossInspectRes = await client.callTool({
                    name: 'inspect_workflow',
                    arguments: { stackId: 'stack-other-tenant' },
                });
                assert.equal(crossInspectRes.isError, true);
                assert.ok((crossInspectRes.content as any)[0].text.includes('not found'));
            } finally {
                await cleanup();
            }
        });
    });

    describe('MCP Resources (siglo://workflows/active, siglo://workflows/{stackId}, siglo://schema/graphql)', () => {
        it('reads active workflows, individual stack snapshots, and GraphQL schema SDL', async () => {
            // Also add a waiting workflow to verify both RUNNING and WAITING appear in active
            await storage.saveCheckpoint(
                makeCheckpoint('stack-waiting-1', {
                    status: 'waiting',
                    timestamp: new Date('2026-03-15T09:15:00.000Z').getTime(),
                    metadata: {
                        orderId: '102',
                        secret: 'waiting-secret',
                        waitRecord: {
                            correlationKey: 'wait-102',
                            eventName: 'payment.webhook',
                            status: 'WAITING',
                        },
                    },
                }),
            );

            const { client, cleanup } = await createConnectedClient();
            try {
                // 1. siglo://workflows/active
                const activeRes = await client.readResource({ uri: 'siglo://workflows/active' });
                assert.equal(activeRes.contents.length, 1);
                const activePayload = JSON.parse((activeRes.contents[0] as any).text);
                assert.equal(activePayload.namespace, 'acme');
                assert.equal(activePayload.activeCount, 2);
                assert.deepEqual(
                    activePayload.workflows.map((w: any) => w.stackId),
                    ['stack-waiting-1', 'stack-running-1'],
                );
                assert.equal(activePayload.workflows[0].metadata.secret, '[REDACTED]');
                assert.equal(activePayload.workflows[0].context, undefined);

                // 2. siglo://workflows/{stackId}
                const snapshotRes = await client.readResource({ uri: 'siglo://workflows/stack-order-101' });
                assert.equal(snapshotRes.contents.length, 1);
                const snapshot = JSON.parse((snapshotRes.contents[0] as any).text);
                assert.equal(snapshot.stackId, 'stack-order-101');
                assert.equal(snapshot.status, 'FAILED');
                assert.equal(snapshot.context.apiKey, '[REDACTED]');
                assert.equal(snapshot.error.name, 'CardExpiredException');

                // 3. siglo://schema/graphql
                const schemaRes = await client.readResource({ uri: 'siglo://schema/graphql' });
                assert.equal(schemaRes.contents.length, 1);
                const sdl = (schemaRes.contents[0] as any).text;
                assert.ok(sdl.includes('type WorkflowExecution'));
                assert.ok(sdl.includes('type Query'));
                assert.ok(sdl.includes('type Mutation'));
            } finally {
                await cleanup();
            }
        });
    });

    describe('MCP Prompt Templates (diagnose_failure)', () => {
        it('generates structured root-cause diagnosis prompt with redacted execution snapshot', async () => {
            const { client, cleanup } = await createConnectedClient();
            try {
                const promptRes = await client.getPrompt({
                    name: 'diagnose_failure',
                    arguments: { stackId: 'stack-order-101' },
                });

                assert.equal(promptRes.messages.length, 1);
                const text = (promptRes.messages[0].content as any).text as string;
                assert.ok(text.includes('stack-order-101'));
                assert.ok(text.includes('CardExpiredException'));
                assert.ok(text.includes('chargeStripe'));
                assert.ok(text.includes('[REDACTED]'));
                assert.ok(!text.includes('sk_live_super_secret'));
                assert.ok(!text.includes('sk_live_leak_attempt'));
            } finally {
                await cleanup();
            }
        });

        it('generates discovery instructions when stackId is omitted', async () => {
            const { client, cleanup } = await createConnectedClient();
            try {
                const promptRes = await client.getPrompt({
                    name: 'diagnose_failure',
                    arguments: { workflowId: 'order-checkout' },
                });

                assert.equal(promptRes.messages.length, 1);
                const text = (promptRes.messages[0].content as any).text as string;
                assert.ok(text.includes('search_workflows'));
                assert.ok(text.includes('inspect_workflow'));
                assert.ok(text.includes('order-checkout'));
            } finally {
                await cleanup();
            }
        });
    });

    describe('Transports: stdio and sse', () => {
        it('communicates over stdio transport using custom stdin/stdout streams', async () => {
            const stdin = new PassThrough();
            const stdout = new PassThrough();

            const mcpServer = createWorkflowMcpServer({
                storage,
                namespace: 'acme',
                transport: 'stdio',
                stdin,
                stdout,
            });

            await mcpServer.start();

            try {
                const responsePromise = new Promise<any>((resolve, reject) => {
                    let buffer = '';
                    stdout.on('data', chunk => {
                        buffer += chunk.toString('utf8');
                        const lines = buffer.split('\n');
                        buffer = lines.pop() ?? '';
                        for (const line of lines) {
                            if (!line.trim()) continue;
                            try {
                                const msg = JSONRPCMessageSchema.parse(JSON.parse(line));
                                if ('id' in msg && msg.id === 1) {
                                    resolve(msg);
                                }
                            } catch (err) {
                                reject(err);
                            }
                        }
                    });
                });

                const initRequest = {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                        protocolVersion: '2024-11-05',
                        capabilities: {},
                        clientInfo: { name: 'stdio-test-client', version: '1.0.0' },
                    },
                };
                stdin.write(JSON.stringify(initRequest) + '\n');

                const response = await responsePromise;
                assert.equal(response.result.serverInfo.name, '@siglo/query-mcp');
                assert.ok(response.result.capabilities.tools);
                assert.ok(response.result.capabilities.resources);
                assert.ok(response.result.capabilities.prompts);
            } finally {
                await mcpServer.close();
                stdin.destroy();
                stdout.destroy();
            }
        });

        it('communicates over HTTP SSE transport with SSEClientTransport', async () => {
            const mcpServer = createWorkflowMcpServer({
                storage,
                namespace: 'acme',
                transport: 'sse',
                sse: { port: 0, host: '127.0.0.1' },
            });

            await mcpServer.start();
            const sseUrl = mcpServer.getSseUrl();
            assert.ok(sseUrl);

            const client = new Client({ name: 'sse-test-client', version: '1.0.0' }, { capabilities: {} });
            const sseTransport = new SSEClientTransport(new URL(sseUrl));

            try {
                await client.connect(sseTransport);

                const { tools } = await client.listTools();
                assert.equal(tools.length, 4);

                const res = await client.callTool({
                    name: 'search_workflows',
                    arguments: { status: 'FAILED' },
                });
                const payload = JSON.parse((res.content as any)[0].text);
                assert.equal(payload.totalCount, 1);
                assert.equal(payload.workflows[0].stackId, 'stack-order-101');
            } finally {
                await client.close();
                await mcpServer.close();
            }
        });
    });
});
