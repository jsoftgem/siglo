import type { ServerResponse } from 'http';
import { WorkflowEventEmitter } from '@siglo/core';
import { WorkflowExecutionStore } from '../store';
import { SSEBroadcaster } from '../transports/sse';
import { getDashboardHtml } from '../ui/dashboard';

export interface FastifyMonitorOptions {
    emitter?: WorkflowEventEmitter;
    store?: WorkflowExecutionStore;
}

export interface MonitorFastifyRequestLike {
    query?: Record<string, unknown>;
}

export interface MonitorFastifyReplyLike {
    raw: ServerResponse;
    type(contentType: string): MonitorFastifyReplyLike;
    send(payload: unknown): unknown;
}

export interface MonitorFastifyInstanceLike {
    get(path: string, handler: (req: MonitorFastifyRequestLike, reply: MonitorFastifyReplyLike) => unknown): unknown;
}

export function fastifyMonitorPlugin(
    fastify: MonitorFastifyInstanceLike,
    options: FastifyMonitorOptions,
    done: (err?: Error) => void,
): void {
    const store = options.store || new WorkflowExecutionStore();
    const emitter = options.emitter || new WorkflowEventEmitter();
    const sse = new SSEBroadcaster();

    emitter.on('*', event => {
        store.addEvent(event);
        sse.broadcast(event);
    });

    fastify.get('/', (_req, reply) => {
        reply.type('text/html; charset=utf-8').send(getDashboardHtml());
    });

    fastify.get('/events', (req, reply) => {
        const rawRes = reply.raw;
        const ns = typeof req.query?.namespace === 'string' ? req.query.namespace : undefined;
        sse.addClient(rawRes, ns);
    });

    fastify.get('/api/workflows', (_req, reply) => {
        reply.type('application/json').send(store.listRuns());
    });

    done();
}
