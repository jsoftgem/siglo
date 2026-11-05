import { WorkflowEventEmitter, WorkflowExecutionEvent, redactEvent, RedactionOptions } from '@siglo/core';
import { MonitorClientOptions, MonitorClientInstance } from './types';
import { getActiveMonitorServer, MonitorServerInstance } from './server';

export class RemoteMonitorClient implements MonitorClientInstance {
    public readonly emitter: WorkflowEventEmitter;
    private readonly baseUrl: string;
    private readonly batchSize: number;
    private readonly flushIntervalMs: number;
    private readonly redaction?: RedactionOptions;
    private readonly apiKey?: string;
    private readonly customHeaders: Record<string, string>;
    private readonly maxQueueSize: number;
    private queue: WorkflowExecutionEvent[] = [];
    private flushTimer: any = null;
    private isClosing = false;
    private activeFlushPromise: Promise<void> | null = null;

    constructor(options: MonitorClientOptions = {}) {
        if (options.url) {
            this.baseUrl = options.url.replace(/\/+$/, '');
        } else {
            const host = options.host || '127.0.0.1';
            const port = options.port !== undefined ? options.port : 4000;
            this.baseUrl = `http://${host}:${port}`;
        }

        this.batchSize = options.batchSize || 10;
        this.flushIntervalMs = options.flushIntervalMs || 25;
        this.redaction = options.redaction;
        this.apiKey = options.apiKey || options.authToken;
        this.customHeaders = options.headers ? { ...options.headers } : {};
        this.maxQueueSize = options.maxQueueSize && options.maxQueueSize > 0 ? options.maxQueueSize : 1000;
        this.emitter = new WorkflowEventEmitter(options.namespace);

        // Pipe events emitted through this client to the remote server
        this.emitter.on('*', (event) => {
            this.queueEvent(event);
        });
    }

    public monitor = (event: WorkflowExecutionEvent): void => {
        this.queueEvent(event);
    };

    public async sendEvent(event: WorkflowExecutionEvent): Promise<void> {
        this.queueEvent(event);
        await this.flush();
    }

    private queueEvent(event: WorkflowExecutionEvent): void {
        if (this.isClosing || !event) return;
        const sanitized = redactEvent(event, this.redaction);

        // Protect host memory: if queue capacity exceeded, drop oldest event
        if (this.queue.length >= this.maxQueueSize) {
            this.queue.shift();
        }

        this.queue.push(sanitized);

        if (this.queue.length >= this.batchSize) {
            this.flush().catch(() => {});
        } else if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                this.flush().catch(() => {});
            }, this.flushIntervalMs);
        }
    }

    public async flush(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        if (this.queue.length === 0) {
            if (this.activeFlushPromise) {
                await this.activeFlushPromise;
            }
            return;
        }

        const batch = [...this.queue];
        this.queue = [];

        this.activeFlushPromise = (async () => {
            try {
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                    ...this.customHeaders
                };

                if (this.apiKey && !headers['Authorization'] && !headers['authorization']) {
                    headers['Authorization'] = `Bearer ${this.apiKey}`;
                }

                const res = await fetch(`${this.baseUrl}/api/events`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(batch)
                });
                await res.text();
            } catch {
                // Observability failures never crash host workflow execution
            } finally {
                this.activeFlushPromise = null;
            }
        })();

        await this.activeFlushPromise;
    }

    public async close(): Promise<void> {
        this.isClosing = true;
        await this.flush();
    }
}

/**
 * Creates a client that streams workflow telemetry to an external or running monitor server.
 */
export function createMonitorClient(options: MonitorClientOptions = {}): MonitorClientInstance {
    return new RemoteMonitorClient(options);
}

/**
 * Attaches a workflow to an already running monitor server.
 *
 * Supports:
 * - No arguments: Attaches to the active in-process server if running, or defaults to http://127.0.0.1:4000.
 * - Port number (e.g. 4000): Attaches to the in-process server on that port if present, or connects over HTTP.
 * - URL string (e.g. 'http://localhost:4000'): Connects to the remote monitor server over HTTP.
 * - MonitorServerInstance: Directly pipes events into the server's event emitter in memory.
 * - MonitorClientOptions: Configures remote batching and connection parameters.
 *
 * @example
 * ```typescript
 * // 1. Attach to running server on default port (4000)
 * const orderFlow = flow(step1, step2).monitor(attachToMonitorServer());
 *
 * // 2. Attach to authenticated remote monitor server
 * const orderFlow = flow(step1, step2).monitor(attachToMonitorServer('https://monitor.corp.internal:4000', {
 *     apiKey: 'secret-token'
 * }));
 *
 * // 3. Attach by port
 * const orderFlow = flow(step1, step2).monitor(attachToMonitorServer(4000));
 * ```
 */
export function attachToMonitorServer(
    target?: string | number | MonitorServerInstance | MonitorClientOptions,
    clientOptions?: MonitorClientOptions
): (event: WorkflowExecutionEvent) => void {
    // 1. If target is a MonitorServerInstance in memory
    if (target && typeof target === 'object' && 'emitter' in target) {
        const instance = target as MonitorServerInstance;
        return (event: WorkflowExecutionEvent) => {
            instance.emitter.emit(event);
        };
    }

    // 2. If target is undefined, check in-process singleton first
    if (target === undefined) {
        const local = getActiveMonitorServer();
        if (local) {
            return (event: WorkflowExecutionEvent) => {
                local.emitter.emit(event);
            };
        }
        const client = createMonitorClient({ url: 'http://127.0.0.1:4000', ...clientOptions });
        return client.monitor;
    }

    // 3. If target is a port number
    if (typeof target === 'number') {
        const local = getActiveMonitorServer(target);
        if (local) {
            return (event: WorkflowExecutionEvent) => {
                local.emitter.emit(event);
            };
        }
        const client = createMonitorClient({ port: target, ...clientOptions });
        return client.monitor;
    }

    // 4. If target is a URL string
    if (typeof target === 'string') {
        const client = createMonitorClient({ url: target, ...clientOptions });
        return client.monitor;
    }

    // 5. If target is MonitorClientOptions
    const mergedOptions: MonitorClientOptions = {
        ...(target as MonitorClientOptions),
        ...clientOptions
    };
    const client = createMonitorClient(mergedOptions);
    return client.monitor;
}
