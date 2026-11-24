import type { ServerResponse } from 'http';
import { WorkflowEventEmitter } from '@siglo/core';
import { WorkflowExecutionStore } from '../store';
import { SSEBroadcaster } from '../transports/sse';
import { getDashboardHtml } from '../ui/dashboard';

export interface ExpressMonitorOptions {
    emitter?: WorkflowEventEmitter;
    store?: WorkflowExecutionStore;
    basePath?: string;
}

export interface MonitorExpressRequestLike {
    url?: string;
    query?: Record<string, unknown>;
}

export interface MonitorExpressResponseLike {
    setHeader(name: string, value: string): unknown;
    send(body: unknown): unknown;
    json(body: unknown): unknown;
}

export function createExpressMonitorMiddleware(options: ExpressMonitorOptions = {}) {
    const store = options.store || new WorkflowExecutionStore();
    const emitter = options.emitter || new WorkflowEventEmitter();
    const sse = new SSEBroadcaster();

    emitter.on('*', event => {
        store.addEvent(event);
        sse.broadcast(event);
    });

    return (req: MonitorExpressRequestLike, res: MonitorExpressResponseLike, next: () => void): void => {
        const url = req.url || '/';

        if (url === '' || url === '/' || url === '/index.html') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.send(getDashboardHtml());
            return;
        }

        if (url.startsWith('/events')) {
            const ns = typeof req.query?.namespace === 'string' ? req.query.namespace : undefined;
            sse.addClient(res as unknown as ServerResponse, ns);
            return;
        }

        if (url.startsWith('/api/workflows')) {
            res.setHeader('Content-Type', 'application/json');
            res.json(store.listRuns());
            return;
        }

        next();
    };
}
