import { WorkflowEventEmitter } from '@siglo/core';
import { WorkflowExecutionStore } from '../store';
import { SSEBroadcaster } from '../transports/sse';
import { getDashboardHtml } from '../ui/dashboard';

export interface ExpressMonitorOptions {
    emitter?: WorkflowEventEmitter;
    store?: WorkflowExecutionStore;
    basePath?: string;
}

export function createExpressMonitorMiddleware(options: ExpressMonitorOptions = {}) {
    const store = options.store || new WorkflowExecutionStore();
    const emitter = options.emitter || new WorkflowEventEmitter();
    const sse = new SSEBroadcaster();

    emitter.on('*', event => {
        store.addEvent(event);
        sse.broadcast(event);
    });

    return (req: any, res: any, next: any) => {
        const url = req.url || '/';

        if (url === '' || url === '/' || url === '/index.html') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(getDashboardHtml());
        }

        if (url.startsWith('/events')) {
            const ns = req.query?.namespace;
            return sse.addClient(res, ns);
        }

        if (url.startsWith('/api/workflows')) {
            res.setHeader('Content-Type', 'application/json');
            return res.json(store.listRuns());
        }

        next();
    };
}
