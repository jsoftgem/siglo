import * as http from 'http';
import {
    Flow,
    sanitizeInspection,
    redactEvent,
    RedactionOptions,
    redactValue,
    resumeWorkflow,
    WorkflowEventEmitter,
    WorkflowExecutionEvent,
    getErrorMessage,
    isPlainObject,
} from '@siglo/core';
import {
    MonitorFlowLike,
    MonitorServerAuthOptions,
    MonitorServerCorsOptions,
    MonitorServerOptions,
    WorkflowRunRecord,
} from './types';
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
    workflows: Map<string, MonitorFlowLike>;
    sse: SSEBroadcaster;
    ws: WebSocketBroadcaster;
    metrics: PrometheusExporter;
    close: () => Promise<void>;
}

const activeServers = new Map<number, MonitorServerInstance>();

function validInspectionEvent(event: unknown): boolean {
    if (!isPlainObject(event)) return false;
    if (typeof event.type !== 'string' || typeof event.stackId !== 'string' || !event.stackId) return false;
    if (event.type !== 'step:inspection' && !(event.type === 'ai:complete' && event.inspection)) return true;
    return (
        typeof event.stepId === 'string' &&
        !!event.stepId &&
        typeof event.attempt === 'number' &&
        Number.isSafeInteger(event.attempt) &&
        event.attempt > 0 &&
        typeof event.timestamp === 'number' &&
        Number.isFinite(event.timestamp) &&
        event.timestamp >= 0 &&
        !!sanitizeInspection(event.inspection as Parameters<typeof sanitizeInspection>[0]) &&
        (event.type !== 'ai:complete' || (isPlainObject(event.inspection) && event.inspection.kind === 'ai'))
    );
}

function safeJsonStringify(obj: unknown): string {
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

function sanitizeRunRecord(run: WorkflowRunRecord, redaction?: RedactionOptions): WorkflowRunRecord {
    if (!run) return run;
    return {
        ...run,
        steps: redactValue(run.steps, redaction) as WorkflowRunRecord['steps'],
        context: redactValue(run.context, redaction) as Record<string, unknown>,
        contextDiffs: Array.isArray(run.contextDiffs)
            ? run.contextDiffs.map(d => ({ ...d, value: redactValue(d.value, redaction) }))
            : run.contextDiffs,
        events: Array.isArray(run.events) ? run.events.map(ev => redactEvent(ev, redaction)) : run.events,
    };
}

function validateResumePayload(
    flowCandidate: MonitorFlowLike | undefined,
    payload: unknown,
): { valid: boolean; error?: unknown } {
    const candidate = flowCandidate as { resumeSchema?: unknown } | undefined;
    if (!candidate || !candidate.resumeSchema) {
        return { valid: true };
    }
    const schema = candidate.resumeSchema;
    if (isPlainObject(schema) && typeof schema.safeParse === 'function') {
        const res = (schema.safeParse as (input: unknown) => { success: boolean; error?: unknown })(payload);
        if (!res.success) {
            return { valid: false, error: res.error };
        }
    } else if (isPlainObject(schema) && typeof schema.validate === 'function') {
        const res = (schema.validate as (input: unknown) => { error?: unknown } | undefined)(payload);
        if (res && res.error) {
            return { valid: false, error: res.error };
        }
    } else if (typeof schema === 'function') {
        try {
            const resValidation = (schema as (input: unknown) => unknown)(payload);
            if (resValidation === false) {
                return { valid: false, error: 'Validation failed' };
            }
        } catch (e: unknown) {
            return { valid: false, error: getErrorMessage(e) };
        }
    }
    return { valid: true };
}

function resolveTargetFlow(
    stackId: string,
    run: WorkflowRunRecord | undefined,
    options: MonitorServerOptions,
    workflows: Map<string, MonitorFlowLike>,
): MonitorFlowLike | undefined {
    if (options.flow && !options.workflows) {
        return options.flow;
    }
    const candidates = [run?.flowName, stackId].filter((c): c is string => typeof c === 'string' && c.length > 0);

    for (const key of candidates) {
        if (workflows.has(key)) {
            return workflows.get(key);
        }
    }
    if (workflows.size === 1 && !options.workflows) {
        return workflows.values().next().value;
    }
    return undefined;
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
    const store = (options.store as WorkflowExecutionStore | undefined) || new WorkflowExecutionStore();
    const workflows: Map<string, MonitorFlowLike> = options.workflows instanceof Map ? options.workflows : new Map();
    if (options.flow) {
        const flowCandidate = options.flow as { id?: string; name?: string; workflowId?: string };
        const flowId = flowCandidate.id || flowCandidate.name || flowCandidate.workflowId;
        if (flowId) {
            workflows.set(flowId, options.flow);
        }
    }
    const emitter = options.emitter || new WorkflowEventEmitter(options.namespaceFilter);

    if (
        (host === '0.0.0.0' || host === '::') &&
        !options.auth &&
        typeof process !== 'undefined' &&
        process.emitWarning
    ) {
        process.emitWarning(
            'Monitor server is listening on a public network interface without authentication. Remote workflow resumption and telemetry may be exposed.',
            'SecurityWarning',
        );
    }

    // Normalize auth options
    const authConfig: MonitorServerAuthOptions | undefined =
        typeof options.auth === 'string' ? { apiKey: options.auth } : options.auth;

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
            return Boolean(
                (authConfig.ingestionKey && token === authConfig.ingestionKey) ||
                (authConfig.apiKey && token === authConfig.apiKey) ||
                (authConfig.adminKey && token === authConfig.adminKey),
            );
        }

        if (scope === 'control') {
            return Boolean(
                (authConfig.adminKey && token === authConfig.adminKey) ||
                (authConfig.apiKey && token === authConfig.apiKey),
            );
        }

        // 'read' scope
        return Boolean(
            (authConfig.apiKey && token === authConfig.apiKey) ||
            (authConfig.adminKey && token === authConfig.adminKey) ||
            (authConfig.ingestionKey && token === authConfig.ingestionKey),
        );
    };

    const effectiveRedaction: RedactionOptions = {
        redactKeys: [...(options.redaction?.redactKeys || []), ...(options.security?.redactedKeys || [])],
        redactHook: options.security?.maskFn || options.redaction?.redactHook,
    };

    const sse = new SSEBroadcaster({ redaction: effectiveRedaction });
    const ws = new WebSocketBroadcaster({
        redaction: effectiveRedaction,
        allowRemoteResume,
        maxPayloadBytes,
        authorizeMessage: (message, req) =>
            checkAuth(
                req,
                new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`),
                message.action === 'event' ? 'ingest' : message.action === 'resume' ? 'control' : 'read',
            ),
        authenticate: req => {
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            return checkAuth(req, url, 'read');
        },
        onClientMessage: (message, client) => {
            if (message.action === 'event' && message.event) {
                if (!validInspectionEvent(message.event)) return;
                const event = redactEvent(message.event, effectiveRedaction);
                emitter.emit(event);
            } else if (message.action === 'resume' && message.stackId && allowRemoteResume) {
                const run = store.getRun(message.stackId);
                const targetFlow = resolveTargetFlow(message.stackId, run, options, workflows);
                if (!targetFlow) {
                    ws.send(client, {
                        action: 'error',
                        error: `Workflow definition not registered for '${message.stackId}'`,
                    });
                    return;
                }
                const validation = validateResumePayload(targetFlow, message.payload);
                if (!validation.valid) {
                    ws.send(client, {
                        action: 'error',
                        error: 'Unprocessable Entity: Invalid resume payload',
                        details: validation.error,
                    });
                    return;
                }
                resumeWorkflow(targetFlow as Flow<any, any>, message.stackId, message.payload, {
                    monitor: emitter,
                }).catch((err: unknown) => {
                    ws.send(client, { action: 'error', error: getErrorMessage(err) });
                });
            }
        },
    });
    const metrics = new PrometheusExporter();

    // Wire up events
    emitter.on('*', rawEvent => {
        const event = redactEvent(rawEvent, effectiveRedaction);
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
                    const parsed: unknown = JSON.parse(body);
                    const events = Array.isArray(parsed) ? parsed : [parsed];
                    if (!events.every(validInspectionEvent)) throw new Error('Invalid monitoring event');
                    for (const ev of events) {
                        emitter.emit(redactEvent(ev as WorkflowExecutionEvent, effectiveRedaction));
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
            const runs = store.listRuns({ namespace: ns, status }).map(r => sanitizeRunRecord(r, effectiveRedaction));
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
            res.end(safeJsonStringify(sanitizeRunRecord(run, effectiveRedaction)));
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
                    const rawParsed: unknown = body ? JSON.parse(body) : {};
                    const parsed = isPlainObject(rawParsed) ? rawParsed : {};
                    const run = store.getRun(stackId);
                    const targetFlow = resolveTargetFlow(stackId, run, options, workflows);
                    if (!targetFlow) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(
                            JSON.stringify({
                                error: `Cannot resume workflow '${stackId}': workflow definition not registered on monitor server.`,
                            }),
                        );
                        return;
                    }

                    const validation = validateResumePayload(targetFlow, parsed.payload);
                    if (!validation.valid) {
                        res.writeHead(422, { 'Content-Type': 'application/json' });
                        res.end(
                            JSON.stringify({
                                error: 'Unprocessable Entity: Invalid resume payload',
                                details: validation.error,
                            }),
                        );
                        return;
                    }

                    await resumeWorkflow(targetFlow as Flow<any, any>, stackId, parsed.payload, { monitor: emitter });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, stackId }));
                } catch (err: unknown) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: getErrorMessage(err) }));
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
        server.on('error', err => {
            reject(err);
        });

        server.listen(port, host, () => {
            const addr = server.address();
            const actualPort = addr && typeof addr === 'object' ? addr.port : port;
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
                    return new Promise(resClose => {
                        server.close(() => resClose());
                    });
                },
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
        if (requestOrigin) {
            if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin)) {
                res.setHeader('Access-Control-Allow-Origin', requestOrigin);
            } else {
                res.setHeader('Access-Control-Allow-Origin', 'null');
            }
        }
    } else if (cors.origin === '*') {
        res.setHeader('Access-Control-Allow-Origin', '*');
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
