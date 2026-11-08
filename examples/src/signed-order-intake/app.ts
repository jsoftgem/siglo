import express from 'express';
import { createServer } from 'node:http';
import type { ErrorRequestHandler } from 'express';
import { sigloExpressMiddleware } from '@siglo/express';
import type { WorkflowEventEmitter } from '@siglo/core';
import type { WebhookDedupStore } from '@siglo/crypto';
import { createIntakeWorkflow, type OrderEvent } from './workflow';
import { LocalNonceStore, type ClientKey } from './security';

function errorStatus(error: any): number {
    for (let current = error, depth = 0; current && depth < 12; current = current.cause ?? current.error, depth++) {
        if (current.status) return current.status;
        if (current.name === 'ValidationException') return 401;
    }
    return 500;
}
export function createApp(
    keys: ReadonlyMap<string, ClientKey>,
    publish: (event: OrderEvent) => Promise<void>,
    nonces: WebhookDedupStore = new LocalNonceStore(),
    monitor?: WorkflowEventEmitter,
    isReady = () => true,
) {
    const workflow = createIntakeWorkflow(keys, nonces, publish);
    if (monitor) workflow.monitor(monitor);
    const app = express();
    app.enable('strict routing');
    app.get('/health', (_req, res) =>
        res.status(isReady() ? 200 : 503).json({ status: isReady() ? 'ok' : 'starting' }),
    );
    app.use('/orders', (_req, res, next) => {
        if (!isReady()) {
            res.status(503).json({ error: 'Order intake is starting' });
            return;
        }
        next();
    });
    app.post(
        '/orders',
        express.raw({ type: 'application/json', limit: '64kb', inflate: false }),
        sigloExpressMiddleware(workflow, {
            durable: false,
            input: req => ({
                method: req.method,
                target: req.originalUrl,
                rawBody: req.body ?? Buffer.alloc(0),
                headers: req.headers,
            }),
            output: (result, res) => res.status(202).json(result.receipt),
            onError: (error, _req, res) => {
                const status = errorStatus(error);
                return res.status(status).json({
                    error:
                        status === 401
                            ? 'Invalid signed request'
                            : status === 400
                              ? 'Invalid order'
                              : 'Order intake failed',
                });
            },
        }),
    );
    const parserError: ErrorRequestHandler = (error, _req, res, _next) => {
        res.status(error.status ?? 500).json({ error: 'Request body rejected' });
    };
    app.use(parserError);
    return app;
}

/** Await bind errors so duplicate starts fail before opening Kafka or the monitor. */
export async function listenForRequests(app: ReturnType<typeof createApp>, port: number) {
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    return server;
}
