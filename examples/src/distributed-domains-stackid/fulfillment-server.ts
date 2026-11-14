import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Redis } from 'ioredis';
import { WorkflowEventEmitter, setDefaultMonitor } from '@siglo/core';
import { RedisMonitoringAdapter } from '@siglo/monitor';
import { channel, redisUrl, pubsubClient } from './infrastructure';
import { fulfillmentWorkflow, FulfillmentInput } from './fulfillment-service';

async function main() {
    const port = Number(process.env.PORT || 3002);
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 5 });
    redis.on('error', err => console.error('[Fulfillment Service] Redis Error:', err.message));
    await redis.connect();

    // Create emitter and publish all workflow execution events to Redis
    const emitter = new WorkflowEventEmitter();
    new RedisMonitoringAdapter({
        publisher: pubsubClient(redis),
        channel,
    }).attachToEmitter(emitter);

    setDefaultMonitor(emitter);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

        if (req.method === 'GET' && url.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', service: 'fulfillment-service' }));
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/fulfillments') {
            let body = '';
            req.on('data', chunk => (body += chunk));
            req.on('end', async () => {
                try {
                    const payload: FulfillmentInput = JSON.parse(body || '{}');

                    // Extract forwarded execution stack ID and tenant namespace from incoming HTTP headers
                    const stackId = String(req.headers['x-stack-id'] || '');
                    const namespace = req.headers['x-tenant-id'] || req.headers['x-namespace'];

                    if (!stackId) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Missing required x-stack-id header' }));
                        return;
                    }

                    console.log(
                        `[Fulfillment Service] Received fulfillment request for order "${payload.orderId}" (stackId: ${stackId}, tenant: ${namespace || 'default'})`,
                    );

                    // Execute the fulfillment workflow with the exact same stackId and namespace
                    const result = await fulfillmentWorkflow.monitor(emitter).run(payload, {
                        stackId,
                        namespace: namespace ? String(namespace) : undefined,
                        workflowId: 'fulfillment-service',
                        pojo: true,
                    });

                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        'X-Workflow-Stack-Id': stackId,
                    });
                    res.end(
                        JSON.stringify({
                            orderId: payload.orderId,
                            inventoryStatus: result.inventoryStatus,
                            reservationId: result.reservationId,
                            paymentId: result.paymentId,
                            trackingId: result.trackingId,
                            fulfilledAt: result.fulfilledAt,
                        }),
                    );
                } catch (error: any) {
                    console.error('[Fulfillment Service] Execution error:', error);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: error?.message || 'Fulfillment execution failed' }));
                }
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(`[Fulfillment Service] Listening on http://0.0.0.0:${port}`);
    });

    const close = () => {
        redis.disconnect();
        server.close();
    };

    process.once('SIGINT', close);
    process.once('SIGTERM', close);
}

if (require.main === module) {
    main().catch(err => {
        console.error(err);
        process.exitCode = 1;
    });
}
