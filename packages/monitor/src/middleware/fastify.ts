import { WorkflowEventEmitter } from '@siglo/core';
import { WorkflowExecutionStore } from '../store';
import { SSEBroadcaster } from '../transports/sse';
import { getDashboardHtml } from '../ui/dashboard';

export interface FastifyMonitorOptions {
    emitter?: WorkflowEventEmitter;
    store?: WorkflowExecutionStore;
}

export function fastifyMonitorPlugin(fastify: any, options: FastifyMonitorOptions, done: (err?: any) => void) {
    const store = options.store || new WorkflowExecutionStore();
    const emitter = options.emitter || new WorkflowEventEmitter();
    const sse = new SSEBroadcaster();

    emitter.on('*', event => {
        store.addEvent(event);
        sse.broadcast(event);
    });

    fastify.get('/', (req: any, reply: any) => {
        reply.type('text/html; charset=utf-8').send(getDashboardHtml());
    });

    fastify.get('/events', (req: any, reply: any) => {
        const rawRes = reply.raw;
        const ns = req.query?.namespace;
        sse.addClient(rawRes, ns);
    });

    fastify.get('/api/workflows', (req: any, reply: any) => {
        reply.type('application/json').send(store.listRuns());
    });

    done();
}
