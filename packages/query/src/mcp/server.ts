import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
    CallToolRequestSchema,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { GraphQLSchema } from 'graphql';
import { createWorkflowQueryEngine, type WorkflowQueryEngine } from '../engine';
import { createWorkflowGraphQLSchema } from '../graphql/schema';
import type { WorkflowQueryOptions } from '../types';
import { getMcpPrompt, WORKFLOW_MCP_PROMPTS } from './prompts';
import { readMcpResource, WORKFLOW_MCP_RESOURCES, WORKFLOW_MCP_RESOURCE_TEMPLATES } from './resources';
import { executeMcpTool, type McpTenantScopeOptions, WORKFLOW_MCP_TOOLS } from './tools';

export interface WorkflowMcpSseOptions {
    /**
     * Port to listen on when starting a standalone HTTP SSE server.
     * Defaults to `0` (ephemeral port assigned by OS).
     */
    port?: number;
    /**
     * Host interface to bind when starting a standalone HTTP SSE server.
     * Defaults to `'127.0.0.1'`.
     */
    host?: string;
    /**
     * HTTP GET path for establishing the SSE stream. Defaults to `'/sse'`.
     */
    ssePath?: string;
    /**
     * HTTP POST path for receiving JSON-RPC client messages. Defaults to `'/messages'`.
     */
    messagePath?: string;
    /**
     * Optional existing Node.js HTTP server to mount SSE routes onto.
     */
    httpServer?: HttpServer;
}

export interface WorkflowMcpServerOptions extends Partial<WorkflowQueryOptions>, McpTenantScopeOptions {
    /**
     * Pre-configured `WorkflowQueryEngine` instance. If omitted, `storage` must be provided.
     */
    engine?: WorkflowQueryEngine;
    /**
     * Optional pre-built GraphQL schema for `execute_workflow_query`.
     */
    schema?: GraphQLSchema;
    /**
     * Transport mode used by `start()`. Defaults to `'stdio'`.
     */
    transport?: 'stdio' | 'sse';
    /**
     * Server name reported during MCP initialization. Defaults to `'@siglo/query-mcp'`.
     */
    name?: string;
    /**
     * Server version reported during MCP initialization. Defaults to `'1.2.8'`.
     */
    version?: string;
    /**
     * Optional readable stream for `stdio` transport (defaults to `process.stdin`).
     */
    stdin?: Readable;
    /**
     * Optional writable stream for `stdio` transport (defaults to `process.stdout`).
     */
    stdout?: Writable;
    /**
     * Configuration for `sse` transport mode.
     */
    sse?: WorkflowMcpSseOptions;
}

function buildProtocolServer(
    engine: WorkflowQueryEngine,
    schema: GraphQLSchema,
    scope: McpTenantScopeOptions,
    info: { name: string; version: string },
): Server {
    const server = new Server(info, {
        capabilities: {
            tools: {},
            resources: {},
            prompts: {},
        },
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: WORKFLOW_MCP_TOOLS,
    }));

    server.setRequestHandler(CallToolRequestSchema, async request => {
        return executeMcpTool(request.params.name, request.params.arguments as Record<string, unknown> | undefined, {
            engine,
            schema,
            namespace: scope.namespace,
            defaultNamespace: scope.defaultNamespace,
        });
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: WORKFLOW_MCP_RESOURCES,
    }));

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
        resourceTemplates: WORKFLOW_MCP_RESOURCE_TEMPLATES,
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async request => {
        return readMcpResource(request.params.uri, {
            engine,
            namespace: scope.namespace,
            defaultNamespace: scope.defaultNamespace,
        });
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: WORKFLOW_MCP_PROMPTS,
    }));

    server.setRequestHandler(GetPromptRequestSchema, async request => {
        return getMcpPrompt(request.params.name, request.params.arguments as Record<string, string> | undefined, {
            engine,
            namespace: scope.namespace,
            defaultNamespace: scope.defaultNamespace,
        });
    });

    return server;
}

export class WorkflowMcpServer {
    public readonly engine: WorkflowQueryEngine;
    public readonly schema: GraphQLSchema;
    public readonly server: Server;

    private readonly options: WorkflowMcpServerOptions;
    private readonly info: { name: string; version: string };
    private readonly scope: McpTenantScopeOptions;
    private readonly sseSessions = new Map<string, { transport: SSEServerTransport; server: Server }>();
    private httpServer?: HttpServer;
    private ownsHttpServer = false;
    private requestListener?: (req: IncomingMessage, res: ServerResponse) => void;

    constructor(options: WorkflowMcpServerOptions) {
        if (!options.engine && !options.storage) {
            throw new Error('WorkflowMcpServer requires either an engine or a storage adapter');
        }
        this.options = options;
        this.engine =
            options.engine ??
            createWorkflowQueryEngine({
                storage: options.storage!,
                redactFields: options.redactFields,
                resolveWorkflow: options.resolveWorkflow,
                emitter: options.emitter,
                subscriptionManager: options.subscriptionManager,
            });
        this.schema = options.schema ?? createWorkflowGraphQLSchema(this.engine);
        this.info = {
            name: options.name ?? '@siglo/query-mcp',
            version: options.version ?? '1.2.8',
        };
        this.scope = {
            namespace: options.namespace,
            defaultNamespace: options.defaultNamespace,
        };
        this.server = buildProtocolServer(this.engine, this.schema, this.scope, this.info);
    }

    /**
     * Connects the MCP server to an explicit MCP Transport instance
     * (e.g. `InMemoryTransport`, `StdioServerTransport`, or `SSEServerTransport`).
     */
    async connect(transport: Transport): Promise<void> {
        await this.server.connect(transport);
    }

    /**
     * Starts the MCP server using the configured transport (`'stdio'` or `'sse'`).
     */
    async start(): Promise<void> {
        const mode = this.options.transport ?? 'stdio';

        if (mode === 'stdio') {
            const stdioTransport = new StdioServerTransport(this.options.stdin, this.options.stdout);
            await this.server.connect(stdioTransport);
            return;
        }

        if (mode === 'sse') {
            const sseConfig = this.options.sse ?? {};
            const ssePath = sseConfig.ssePath ?? '/sse';
            const messagePath = sseConfig.messagePath ?? '/messages';

            this.requestListener = (req: IncomingMessage, res: ServerResponse) => {
                const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

                if (req.method === 'GET' && reqUrl.pathname === ssePath) {
                    void this.handleSseConnect(req, res, messagePath);
                    return;
                }

                if (req.method === 'POST' && reqUrl.pathname === messagePath) {
                    void this.handleSseMessage(req, res);
                    return;
                }

                if (!sseConfig.httpServer) {
                    res.statusCode = 404;
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.end(JSON.stringify({ error: 'Not Found' }));
                }
            };

            if (sseConfig.httpServer) {
                this.httpServer = sseConfig.httpServer;
                this.ownsHttpServer = false;
                this.httpServer.on('request', this.requestListener);
                return;
            }

            const port = sseConfig.port ?? 0;
            const host = sseConfig.host ?? '127.0.0.1';
            this.httpServer = createServer(this.requestListener);
            this.ownsHttpServer = true;

            await new Promise<void>((resolve, reject) => {
                this.httpServer!.once('error', reject);
                this.httpServer!.listen(port, host, () => {
                    this.httpServer!.removeListener('error', reject);
                    resolve();
                });
            });
            return;
        }

        throw new Error(`Unsupported MCP transport: '${String(mode)}'`);
    }

    /**
     * Handles an incoming HTTP GET request to establish an MCP SSE session.
     */
    async handleSseConnect(
        _req: IncomingMessage,
        res: ServerResponse,
        messagePath = this.options.sse?.messagePath ?? '/messages',
    ): Promise<SSEServerTransport> {
        const transport = new SSEServerTransport(messagePath, res);
        const sessionServer = buildProtocolServer(this.engine, this.schema, this.scope, this.info);
        const sessionId = transport.sessionId;

        this.sseSessions.set(sessionId, { transport, server: sessionServer });

        const cleanup = () => {
            this.sseSessions.delete(sessionId);
        };
        res.on('close', cleanup);
        transport.onclose = cleanup;

        await sessionServer.connect(transport);
        return transport;
    }

    /**
     * Handles an incoming HTTP POST message for an active MCP SSE session.
     */
    async handleSseMessage(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
        const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const requestedSessionId = reqUrl.searchParams.get('sessionId');

        let session = requestedSessionId ? this.sseSessions.get(requestedSessionId) : undefined;
        if (!session && !requestedSessionId && this.sseSessions.size === 1) {
            session = this.sseSessions.values().next().value;
        }

        if (!session) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'MCP SSE session not found' }));
            return;
        }

        await session.transport.handlePostMessage(req, res, parsedBody);
    }

    /**
     * Returns the bound HTTP SSE URL when started in standalone `'sse'` mode.
     */
    getSseUrl(): string | undefined {
        if (!this.httpServer) return undefined;
        const addr = this.httpServer.address() as AddressInfo | null;
        if (!addr || typeof addr === 'string') return undefined;
        const host = addr.address === '::' || addr.address === '0.0.0.0' ? '127.0.0.1' : addr.address;
        const ssePath = this.options.sse?.ssePath ?? '/sse';
        return `http://${host}:${addr.port}${ssePath}`;
    }

    /**
     * Stops the MCP server, closes active transports, and releases resources.
     */
    async close(): Promise<void> {
        for (const [id, session] of this.sseSessions.entries()) {
            this.sseSessions.delete(id);
            try {
                await session.server.close();
            } catch {
                // ignore close errors
            }
        }

        if (this.httpServer && this.requestListener && !this.ownsHttpServer) {
            this.httpServer.removeListener('request', this.requestListener);
        }

        if (this.httpServer && this.ownsHttpServer) {
            const srv = this.httpServer;
            this.httpServer = undefined;
            await new Promise<void>(resolve => {
                srv.close(() => resolve());
            });
        }

        await this.server.close();
    }

    async stop(): Promise<void> {
        await this.close();
    }
}

export function createWorkflowMcpServer(options: WorkflowMcpServerOptions): WorkflowMcpServer {
    return new WorkflowMcpServer(options);
}
