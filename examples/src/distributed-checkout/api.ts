import express from 'express';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Step, flow, WorkflowEventEmitter } from '@siglo/core';
import { RedisMonitoringAdapter } from '@siglo/monitor';
import { createCheckout, Order } from '../getting-started/checkout';
import { createDemoServices } from '../getting-started/checkout-demo';
import { channel, connectInfrastructure, namespace, pubsubClient } from './infrastructure';

function isOrder(value: unknown): value is Order {
    if (!value || typeof value !== 'object') return false;
    const order = value as Partial<Order>;
    return (
        typeof order.orderId === 'string' &&
        /^[a-zA-Z0-9_-]{1,80}$/.test(order.orderId) &&
        typeof order.sku === 'string' &&
        order.sku.length > 0 &&
        order.sku.length <= 80 &&
        Number.isSafeInteger(order.quantity) &&
        order.quantity! > 0 &&
        Number.isSafeInteger(order.amountCents) &&
        order.amountCents! > 0
    );
}

export async function startApi(port = Number(process.env.PORT || 3000)) {
    const infra = await connectInfrastructure();
    const instance = process.env.INSTANCE_ID || `api-${port}`;
    const emitter = new WorkflowEventEmitter();
    new RedisMonitoringAdapter({ publisher: pubsubClient(infra.redis), channel }).attachToEmitter(emitter);
    const app = express();
    app.use(express.json({ limit: '16kb' }));
    app.use((_req, res, next) => {
        res.setHeader('X-Instance-Id', instance);
        next();
    });
    app.get('/health', (_req, res) => {
        res.json({ instance });
    });

    app.get('/api/checkouts/:stackId', async (req, res) => {
        try {
            const checkpoint = await infra.postgres.getCheckpoint(req.params.stackId);
            if (!checkpoint || checkpoint.namespace !== namespace) {
                res.status(404).json({ error: 'Checkout not found' });
                return;
            }
            res.json({ stackId: checkpoint.stackId, status: checkpoint.status });
        } catch (error) {
            console.error(error);
            res.status(503).json({ error: 'Checkpoint store unavailable' });
        }
    });

    app.post('/api/checkouts', async (req, res) => {
        if (!isOrder(req.body)) {
            res.status(400).json({ error: 'Provide orderId, sku, positive integer quantity and amountCents' });
            return;
        }
        const { orderId, sku, quantity, amountCents } = req.body;
        const input: Order = { orderId, sku, quantity, amountCents };
        const failShipping = req.query.failShipping === 'true';
        const fingerprint = JSON.stringify([sku, quantity, amountCents, failShipping]);
        const key = `${namespace}:v1:${orderId}`;
        // This TTL is a deduplication window, not a renewable/fenced lease.
        try {
            const claim = await infra.idempotency.claim(key, 86_400_000);
            if (claim === 'in-progress') {
                res.setHeader('Retry-After', '1');
                res.status(409).json({ error: 'Checkout already in progress' });
                return;
            }
            if (claim === 'completed') {
                const saved = (await infra.idempotency.getResult(key)) as {
                    fingerprint: string;
                    body: object;
                    stackId: string;
                };
                if (saved.fingerprint !== fingerprint) {
                    res.status(409).json({ error: 'Order ID already used with different input' });
                    return;
                }
                res.setHeader('X-Workflow-Stack-Id', saved.stackId);
                res.setHeader('X-Idempotent-Replay', 'true');
                res.status(200).json(saved.body);
                return;
            }

            const { services, events } = createDemoServices(failShipping);
            // A deterministic pause makes an in-flight duplicate easy to reproduce.
            const loadCatalog = Step.create('loadCatalog', async (order: Order) => {
                console.log(`${instance}: catalog lookup for ${order.sku}`);
                await delay(750);
                return { catalogLabel: `Demo product: ${order.sku}` };
            }).cache({ ttl: 300_000, keySerializer: (_stepId, order: Order, ns) => `${ns}:catalog:v1:${order.sku}` });
            const checkout = flow(loadCatalog, ...createCheckout(services).steps).monitor(emitter);
            let result;
            try {
                result = await checkout.run(input, { namespace, pojo: true, timeout: 5000 });
            } catch (error) {
                // Fake services have compensated; permit a new attempt in this demo.
                await infra.idempotency.fail(key, error);
                console.error(`${instance}: ${events.join(' -> ')}`, error);
                res.status(500).json({ error: 'Internal workflow execution error' });
                return;
            }
            // If persistence fails after business success, retain the claim for
            // reconciliation; releasing it could repeat a real provider operation.
            await infra.flush();
            const stackId = result.$stackId;
            const body = { orderId, status: 'confirmed', trackingId: result.trackingId, stackId };
            await infra.idempotency.complete(key, { fingerprint, body, stackId });
            console.log(`${instance}: ${orderId}: ${events.join(' -> ')}`);
            res.setHeader('X-Workflow-Stack-Id', stackId);
            res.status(201).json(body);
        } catch (error) {
            console.error(error);
            res.status(503).json({ error: 'Checkout infrastructure unavailable' });
        }
    });
    const server = app.listen(port, '0.0.0.0');
    try {
        await once(server, 'listening');
    } catch (error) {
        await infra.close();
        throw error;
    }
    console.log(`${instance}: listening on ${port}`);
    return {
        server,
        async close() {
            await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
            await infra.close();
        },
    };
}

if (require.main === module) {
    startApi()
        .then(({ close }) => {
            process.once('SIGINT', () => {
                void close();
            });
            process.once('SIGTERM', () => {
                void close();
            });
        })
        .catch(error => {
            console.error(error);
            process.exitCode = 1;
        });
}
