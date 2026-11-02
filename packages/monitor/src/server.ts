import * as http from 'http';
import { WorkflowEventEmitter, resumeWorkflow, flow } from 'siglo';
import { MonitorServerOptions, MonitorServerAuthOptions, MonitorServerCorsOptions } from './types';
import { WorkflowExecutionStore } from './store';
import { SSEBroadcaster } from './transports/sse';
import { WebSocketBroadcaster } from './transports/websocket';
import { PrometheusExporter } from './metrics';
import { getDashboardHtml } from './ui/dashboard';

export interface MonitorServerInstance {
    server: http.Server;
    port: number;
    host: string;
    emitter: WorkflowEventEmitter;
    store: WorkflowExecutionStore;
    workflows: Map<string, any>;
    sse: SSEBroadcaster;
    ws: WebSocketBroadcaster;
    metrics: PrometheusExporter;
    close: () => Promise<void>;
}

const activeServers = new Map<number, MonitorServerInstance>();

function safeJsonStringify(obj: any): string {
    const seen = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
        if (key === 'step' && value && typeof value === 'object' && value.sequence) {
            return undefined;
        }
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
                return undefined;
            }
            seen.add(value);
        }
        return value;
    });
}

/**
 * Returns an active monitor server instance running in the current process.
 * If a port is specified, returns the server on that port, otherwise returns the first active server.
 */
export function getActiveMonitorServer(port?: number): MonitorServerInstance | undefined {
    if (port !== undefined) {
        return activeServers.get(port);
    }
    const first = activeServers.values().next();
    return first.done ? undefined : first.value;
}

/**
 * Returns the WorkflowEventEmitter of the currently active monitor server in the process.
 */
export function getMonitorEmitter(port?: number): WorkflowEventEmitter | undefined {
    return getActiveMonitorServer(port)?.emitter;
}

export function createMonitorServer(options: MonitorServerOptions = {}): Promise<MonitorServerInstance> {
    const port = options.port !== undefined ? options.port : 4000;

    // Support reusing existing running server instance in the same process
    if (options.reuseExisting) {
        const existing = getActiveMonitorServer(port);
        if (existing) {
            return Promise.resolve(existing);
        }
    }

    const host = options.host || '127.0.0.1';
    const store = options.store || new WorkflowExecutionStore();
    const workflows = options.workflows instanceof Map ? options.workflows : new Map();
    if (options.flow) {
        workflows.set("default", options.flow);
    }
    const emitter = options.emitter || new WorkflowEventEmitter(options.namespaceFilter);

    // Normalize auth options
    const authConfig: MonitorServerAuthOptions | undefined = typeof options.auth === 'string'
        ? { apiKey: options.auth }
        : options.auth;

    const allowRemoteResume = options.allowRemoteResume !== undefined ? options.allowRemoteResume : true;
    const maxPayloadBytes = options.maxPayloadBytes && options.maxPayloadBytes > 0 ? options.maxPayloadBytes : 1048576; // 1 MB default

    const extractToken = (req: http.IncomingMessage, url: URL): string | undefined => {
        const authHeader = req.headers['authorization'];
        if (authHeader) {
            if (authHeader.startsWith('Bearer ')) {
                return authHeader.slice(7).trim();
            }
            return authHeader.trim();
        }
        const apiKeyHeader = req.headers['x-api-key'];
        if (typeof apiKeyHeader === 'string') {
            return apiKeyHeader.trim();
        }
        // Support token in query parameter for browser SSE and WebSocket handshakes
        const queryToken = url.searchParams.get('token') || url.searchParams.get('apiKey');
        return queryToken || undefined;
    };

    const checkAuth = (req: http.IncomingMessage, url: URL, scope: 'read' | 'ingest' | 'control'): boolean => {
        if (!authConfig) return true;

        const token = extractToken(req, url);
        if (!token) return false;

        if (authConfig.validator) {
            return authConfig.validator(token, scope, req);
        }

        if (scope === 'ingest') {
            return Boolean((authConfig.ingestionKey && token === authConfig.ingestionKey) ||
                           (authConfig.apiKey && token === authConfig.apiKey) ||
                           (authConfig.adminKey && token === authConfig.adminKey));
        }

        if (scope === 'control') {
            return Boolean((authConfig.adminKey && token === authConfig.adminKey) ||
                           (authConfig.apiKey && token === authConfig.apiKey));
        }

        // 'read' scope
        return Boolean((authConfig.apiKey && token === authConfig.apiKey) ||
                       (authConfig.adminKey && token === authConfig.adminKey) ||
                       (authConfig.ingestionKey && token === authConfig.ingestionKey));
    };

    const sse = new SSEBroadcaster({ redaction: options.redaction });
    const ws = new WebSocketBroadcaster({
        redaction: options.redaction,
        allowRemoteResume,
        authenticate: (req) => {
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            return checkAuth(req, url, 'read');
        },
        onClientMessage: (message) => {
            if (message.action === 'event' && message.event) {
                store.addEvent(message.event);
                sse.broadcast(message.event);
                ws.broadcast(message.event);
                metrics.handleEvent(message.event);
                emitter.emit(message.event);
            } else if (message.action === 'resume' && message.stackId && allowRemoteResume) {
                const targetFlow = options.flow || workflows.get(message.stackId) || workflows.get('default') || flow();
                resumeWorkflow(targetFlow, message.stackId, message.payload, { monitor: emitter }).catch(() => {});
            }
        }
    });
    const metrics = new PrometheusExporter();

    // Wire up events
    emitter.on('*', (event) => {
        store.addEvent(event);
        sse.broadcast(event);
        ws.broadcast(event);
        metrics.handleEvent(event);
    });

    const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = url.pathname;

        // Apply CORS headers safely
        applyCorsHeaders(req, res, options.cors);

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (pathname === '/' || pathname === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getDashboardHtml());
            return;
        }

        if (pathname === '/events' && req.method === 'GET') {
            if (!checkAuth(req, url, 'read')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Valid monitor token required' }));
                return;
            }
            const namespace = url.searchParams.get('namespace') || undefined;
            sse.addClient(res, namespace);
            return;
        }

        // Ingest telemetry events from external processes / clients
        if ((pathname === '/api/events' || pathname === '/events') && req.method === 'POST') {
            if (!checkAuth(req, url, 'ingest')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Valid ingestion token required' }));
                return;
            }

            let body = '';
            let bytesReceived = 0;
            let aborted = false;

            req.on('data', chunk => {
                if (aborted) return;
                bytesReceived += chunk.length;
                if (bytesReceived > maxPayloadBytes) {
                    aborted = true;
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Payload Too Large: Exceeded ${maxPayloadBytes} bytes limit` }));
                    req.destroy();
                    return;
                }
                body += chunk;
            });

            req.on('end', () => {
                if (aborted) return;
                try {
                    const parsed = JSON.parse(body);
                    const events = Array.isArray(parsed) ? parsed : [parsed];
                    for (const ev of events) {
                        if (ev && ev.type && ev.stackId) {
                            store.addEvent(ev);
                            sse.broadcast(ev);
                            ws.broadcast(ev);
                            metrics.handleEvent(ev);
                            emitter.emit(ev);
                        }
                    }
                    res.writeHead(202, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, count: events.length }));
                } catch {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
                }
            });
            return;
        }

        if (pathname === '/metrics' && req.method === 'GET') {
            if (!checkAuth(req, url, 'read')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
            res.end(metrics.getMetricsAsText());
            return;
        }

        if (pathname === '/api/workflows' && req.method === 'GET') {
            if (!checkAuth(req, url, 'read')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
            const ns = url.searchParams.get('namespace') || undefined;
            const status = url.searchParams.get('status') || undefined;
            const runs = store.listRuns({ namespace: ns, status });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(safeJsonStringify(runs));
            return;
        }

        if (pathname.startsWith('/api/workflows/') && req.method === 'GET') {
            if (!checkAuth(req, url, 'read')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
            const stackId = pathname.slice('/api/workflows/'.length);
            const run = store.getRun(stackId);
            if (!run) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Workflow execution not found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(safeJsonStringify(run));
            return;
        }

        if (pathname.includes('/resume') && req.method === 'POST') {
            if (!allowRemoteResume) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Forbidden: Remote workflow resumption is disabled on this server' }));
                return;
            }

            if (!checkAuth(req, url, 'control')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Valid admin or control token required' }));
                return;
            }

            const match = pathname.match(/^\/api\/workflows\/([^/]+)\/resume$/);
            if (!match) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
                return;
            }
            const stackId = match[1];

            let body = '';
            let bytesReceived = 0;
            let aborted = false;

            req.on('data', chunk => {
                if (aborted) return;
                bytesReceived += chunk.length;
                if (bytesReceived > maxPayloadBytes) {
                    aborted = true;
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Payload Too Large: Exceeded ${maxPayloadBytes} bytes limit` }));
                    req.destroy();
                    return;
                }
                body += chunk;
            });

            req.on('end', async () => {
                if (aborted) return;
                try {
                    const parsed = body ? JSON.parse(body) : {};
                    const targetFlow = options.flow || workflows.get(stackId) || workflows.get("default");
                    if (!targetFlow) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: `Cannot resume workflow '${stackId}': workflow definition not registered on monitor server.` }));
                        return;
                    }
                    await resumeWorkflow(targetFlow, stackId, parsed.payload, { monitor: emitter });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, stackId }));
                } catch (err: any) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err?.message || String(err) }));
                }
            });
            return;
        }

        if (pathname.includes('/replay') && req.method === 'POST') {
            if (!allowRemoteResume) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Forbidden: Workflow replay is disabled on this server' }));
                return;
            }

            if (!checkAuth(req, url, 'control')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Valid admin or control token required' }));
                return;
            }

            const match = pathname.match(/^\/api\/workflows\/([^/]+)\/replay$/);
            if (!match) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
                return;
            }
            const stackId = match[1];
            const run = store.getRun(stackId);
            if (!run) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Run not found to replay' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, stackId, message: 'Replay scheduled' }));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    // Attach websocket transport
    ws.attach(server);

    return new Promise((resolve, reject) => {
        server.on('error', (err) => {
            reject(err);
        });

        server.listen(port, host, () => {
            const actualPort = (server.address() as any)?.port || port;
            const instance: MonitorServerInstance = {
                server,
                port: actualPort,
                host,
                emitter,
                store,
                workflows,
                sse,
                ws,
                metrics,
                close: async () => {
                    activeServers.delete(actualPort);
                    sse.close();
                    ws.close();
                    return new Promise((resClose) => {
                        server.close(() => resClose());
                    });
                }
            };
            activeServers.set(actualPort, instance);
            resolve(instance);
        });
    });
}

function applyCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse, cors?: MonitorServerCorsOptions): void {
    if (cors?.origin === false) {
        return;
    }

    const requestOrigin = req.headers['origin'];

    if (!cors || !cors.origin) {
        if (cors?.credentials) {
            if (requestOrigin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin)) {
                res.setHeader('Access-Control-Allow-Origin', requestOrigin);
            } else {
                res.setHeader('Access-Control-Allow-Origin', 'null');
            }
        } else {
            res.setHeader('Access-Control-Allow-Origin', requestOrigin || '*');
        }
    } else if (typeof cors.origin === 'string') {
        res.setHeader('Access-Control-Allow-Origin', cors.origin);
    } else if (Array.isArray(cors.origin)) {
        if (requestOrigin && cors.origin.includes(requestOrigin)) {
            res.setHeader('Access-Control-Allow-Origin', requestOrigin);
        } else {
            res.setHeader('Access-Control-Allow-Origin', 'null');
        }
    } else if (typeof cors.origin === 'function') {
        if (requestOrigin && cors.origin(requestOrigin)) {
            res.setHeader('Access-Control-Allow-Origin', requestOrigin);
        } else {
            res.setHeader('Access-Control-Allow-Origin', 'null');
        }
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

    if (cors?.credentials) {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
}
