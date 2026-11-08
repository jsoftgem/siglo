import { WorkflowEventEmitter } from '@siglo/core';
import { WorkflowExecutionStore } from '../store';
import { SSEBroadcaster } from '../transports/sse';
import { getDashboardHtml } from '../ui/dashboard';

export interface HonoMonitorOptions {
    emitter?: WorkflowEventEmitter;
    store?: WorkflowExecutionStore;
}

export function honoMonitorMiddleware(options: HonoMonitorOptions = {}) {
    const store = options.store || new WorkflowExecutionStore();
    const emitter = options.emitter || new WorkflowEventEmitter();
    const sse = new SSEBroadcaster();

    emitter.on('*', event => {
        store.addEvent(event);
        sse.broadcast(event);
    });

    return async (c: any, next: any) => {
        const path = c.req.path;
        if (path === '' || path === '/' || path.endsWith('/dashboard')) {
            return c.html(getDashboardHtml());
        }
        if (path.endsWith('/api/workflows')) {
            return c.json(store.listRuns());
        }
        await next();
    };
}
