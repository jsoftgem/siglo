import express from 'express';
import { once } from 'node:events';
import { sigloExpressMiddleware } from '@siglo/express';
import { createMonitorServer } from '@siglo/monitor';
import { createCheckout } from './checkout';
import type { Order } from './checkout';
import { createDemoServices } from './checkout-demo';

function isOrder(value: unknown): value is Order {
    if (!value || typeof value !== 'object') return false;
    const order = value as Partial<Order>;
    return (
        typeof order.orderId === 'string' &&
        order.orderId.trim().length > 0 &&
        typeof order.sku === 'string' &&
        order.sku.trim().length > 0 &&
        typeof order.quantity === 'number' &&
        Number.isInteger(order.quantity) &&
        order.quantity > 0 &&
        typeof order.amountCents === 'number' &&
        Number.isSafeInteger(order.amountCents) &&
        order.amountCents > 0
    );
}

export async function startCheckoutServer(port = 3000, monitorPort = 4000) {
    const monitor = await createMonitorServer({
        port: monitorPort,
        host: '127.0.0.1',
        allowRemoteResume: false,
    });
    const app = express();
    app.use(express.json({ limit: '16kb' }));

    app.post('/api/checkouts', async (req, res, next) => {
        if (!isOrder(req.body)) {
            res.status(400).json({ error: 'Provide orderId, sku, positive integer quantity, and amountCents' });
            return;
        }
        // Allowlist business fields; don't forward arbitrary request data to telemetry.
        const { orderId, sku, quantity, amountCents } = req.body;
        const input: Order = { orderId, sku, quantity, amountCents };
        // This query flag and fake services are for demonstrating failures locally.
        const { services, events } = createDemoServices(req.query.failShipping === 'true');
        const checkout = createCheckout(services).monitor(monitor.emitter);
        const handler = sigloExpressMiddleware(checkout, {
            input: () => input,
            namespace: 'checkout-demo',
            durable: false,
            timeout: 5000,
            exposeErrorDetails: false,
            output: (result, response) =>
                response.status(201).json({
                    orderId: input.orderId,
                    status: 'confirmed',
                    trackingId: result.trackingId,
                }),
        });
        await handler(req, res, next);
        console.log(`${orderId}: ${events.join(' -> ')}`);
    });

    const server = app.listen(port, '127.0.0.1');
    try {
        await once(server, 'listening');
    } catch (error) {
        await monitor.close();
        throw error;
    }
    return {
        server,
        monitor,
        async close() {
            await new Promise<void>((resolve, reject) => {
                server.close(error => (error ? reject(error) : resolve()));
            });
            await monitor.close();
        },
    };
}

if (require.main === module) {
    startCheckoutServer()
        .then(({ close }) => {
            console.log('Checkout API: http://127.0.0.1:3000/api/checkouts');
            console.log('Live monitor: http://127.0.0.1:4000');
            const shutdown = () => {
                close().catch(console.error);
            };
            process.once('SIGINT', shutdown);
            process.once('SIGTERM', shutdown);
        })
        .catch(error => {
            console.error(error);
            process.exitCode = 1;
        });
}
