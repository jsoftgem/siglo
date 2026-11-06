import express from 'express';
import { once } from 'node:events';
import { DuplicateEventException, ExpiredWaitException, WorkflowEventEmitter, WorkflowAlreadyResumedException, resumeWorkflow } from '@siglo/core';
import { sigloExpressMiddleware } from '@siglo/express';
import { RedisMonitoringAdapter } from '@siglo/monitor';
import { createDemoServices } from '../getting-started/checkout-demo';
import type { Order } from '../getting-started/checkout';
import { ApprovalRejectedError, createDurableCheckout } from './checkout-durable';
import { channel, connectInfrastructure, namespace, pubsubClient } from './infrastructure';

function isOrder(value: unknown): value is Order {
    if (!value || typeof value !== 'object') return false;
    const order = value as Partial<Order>;
    return typeof order.orderId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(order.orderId)
        && typeof order.sku === 'string' && order.sku.length > 0 && order.sku.length <= 80
        && Number.isSafeInteger(order.quantity) && order.quantity! > 0
        && Number.isSafeInteger(order.amountCents) && order.amountCents! > 0;
}

export async function startApi(port = Number(process.env.PORT || 3100)) {
    const infra = await connectInfrastructure();
    const instance = process.env.INSTANCE_ID || `api-${port}`;
    const emitter = new WorkflowEventEmitter();
    new RedisMonitoringAdapter({ publisher: pubsubClient(infra.redis), channel }).attachToEmitter(emitter);
    const { services } = createDemoServices();
    const checkout = createDurableCheckout(services).monitor(emitter);
    // The engine dispatches some writes asynchronously. Drain them before the
    // adapter sends its built-in 202 response; no custom output callback is used.
    const run = checkout.run;
    checkout.run = async (...args) => {
        try { return await run(...args); }
        finally { await infra.flush(); }
    };
    const app = express();
    app.use(express.json({ limit: '16kb' }));
    app.use((_req, res, next) => { res.setHeader('X-Instance-Id', instance); next(); });
    app.get('/health', (_req, res) => { res.json({ instance }); });

    app.post('/api/checkouts', async (req, res, next) => {
        if (!isOrder(req.body)) {
            res.status(400).json({ error: 'Provide orderId, sku, positive integer quantity and amountCents' });
            return;
        }
        try {
            // A submission is accepted once per order ID within this demo window.
            const claim = await infra.idempotency.claim(`${namespace}:${req.body.orderId}`, 86_400_000);
            if (claim !== 'claimed') {
                res.status(409).json({ error: 'Order ID already submitted; use the approval webhook to resume' });
                return;
            }
            next();
        } catch (error) { next(error); }
    }, sigloExpressMiddleware(checkout, {
        durable: true,
        namespace,
        // Only domain fields enter the workflow; HTTP flags are not persisted.
        input: req => {
            const { orderId, sku, quantity, amountCents } = req.body;
            return { orderId, sku, quantity, amountCents };
        }
    }));

    app.get('/api/checkouts/:stackId', async (req, res, next) => {
        try {
            const checkpoint = await infra.postgres.getCheckpoint(req.params.stackId);
            if (!checkpoint || checkpoint.namespace !== namespace) {
                res.status(404).json({ error: 'Checkout not found' });
                return;
            }
            res.json({ stackId: checkpoint.stackId, status: checkpoint.status });
        } catch (error) { next(error); }
    });

    app.post('/api/webhooks/orders/:orderId/approval', async (req, res, next) => {
        const { orderId } = req.params;
        const { approved, approverId } = req.body || {};
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(orderId) || typeof approved !== 'boolean'
            || typeof approverId !== 'string' || !approverId.trim() || approverId.length > 200) {
            res.status(400).json({ error: 'Provide boolean approved and a nonempty approverId' });
            return;
        }
        const correlationKey = `order:${orderId}`;
        try {
            const finalResult = await resumeWorkflow(checkout, correlationKey, { approved, approverId }, { durable: true, pojo: true });
            await infra.flush();
            res.json({ success: true, orderId, result: finalResult });
        } catch (error) {
            if (error instanceof DuplicateEventException || error instanceof WorkflowAlreadyResumedException) {
                res.status(409).json({ error: 'Workflow is not waiting or has already been resumed', correlationKey });
            } else if (error instanceof ExpiredWaitException) {
                res.status(410).json({ error: 'Approval window expired', correlationKey });
            } else if (error instanceof ApprovalRejectedError || (error as any)?.cause instanceof ApprovalRejectedError) {
                res.status(422).json({ error: 'Order rejected; payment refunded and stock released', correlationKey });
            } else { next(error); }
        }
    });

    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        console.error(error);
        res.status(503).json({ error: 'Checkout infrastructure unavailable' });
    });
    const server = app.listen(port, '0.0.0.0');
    try { await once(server, 'listening'); }
    catch (error) { await infra.close(); throw error; }
    console.log(`${instance}: durable checkout listening on ${port}`);
    return {
        server,
        async close() {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            await infra.close();
        }
    };
}

if (require.main === module) {
    startApi().then(({ close }) => {
        process.once('SIGINT', () => { void close(); });
        process.once('SIGTERM', () => { void close(); });
    }).catch(error => { console.error(error); process.exitCode = 1; });
}
