import { WorkflowEventEmitter } from '@siglo/core';
import { WorkflowExecutionStore } from '../store';
import { SSEBroadcaster } from '../transports/sse';
import { getDashboardHtml } from '../ui/dashboard';

export interface HonoMonitorOptions {
    emitter?: WorkflowEventEmitter;
    store?: WorkflowExecutionStore;
}

export interface MonitorHonoContextLike {
    req: { path: string };
    html(body: string): Response | Promise<Response>;
    json(body: unknown): Response | Promise<Response>;
}

export function honoMonitorMiddleware(
    options: HonoMonitorOptions = {},
): (c: MonitorHonoContextLike, next: () => Promise<void>) => Promise<Response | void> {
    const store = options.store || new WorkflowExecutionStore();
    const emitter = options.emitter || new WorkflowEventEmitter();
    const sse = new SSEBroadcaster();

    emitter.on('*', event => {
        store.addEvent(event);
        sse.broadcast(event);
    });

    return async (c, next): Promise<Response | void> => {
        const path = c.req.path;
        if (path === '' || path === '/' || path.endsWith('/dashboard')) {
            return c.html(getDashboardHtml());
        }
        if (path.endsWith('/api/workflows')) {
            return c.json(store.listRuns());
        }
        return next();
    };
}
