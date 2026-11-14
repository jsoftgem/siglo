import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Redis } from 'ioredis';
import { WorkflowEventEmitter, setDefaultMonitor } from '@siglo/core';
import { RedisMonitoringAdapter } from '@siglo/monitor';
import { channel, redisUrl, pubsubClient } from './infrastructure';
import { createOrderWorkflow, OrderInput } from './order-service';
import { FulfillmentServiceHandler, FulfillmentInput, FulfillmentResult } from './fulfillment-service';

const fulfillmentServiceUrl = process.env.FULFILLMENT_SERVICE_URL || 'http://127.0.0.1:3002';

// HTTP Client that calls the remote Fulfillment microservice
const httpFulfillmentClient: FulfillmentServiceHandler = {
    async handleRequest(
        payload: FulfillmentInput,
        headers: { stackId: string; parentStackId?: string; namespace?: string },
    ): Promise<FulfillmentResult> {
        console.log(
            `[Order Service -> HTTP] Calling Fulfillment Service at ${fulfillmentServiceUrl}/api/fulfillments with child stackId: "${headers.stackId}" (parent: "${headers.parentStackId}")`,
        );

        const response = await fetch(`${fulfillmentServiceUrl}/api/fulfillments`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-stack-id': headers.stackId,
                'x-parent-stack-id': headers.parentStackId || '',
                'x-tenant-id': headers.namespace || '',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Fulfillment service HTTP ${response.status}: ${errText}`);
        }

        return (await response.json()) as FulfillmentResult;
    },
};

async function main() {
    const port = Number(process.env.PORT || 3001);
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 5 });
    redis.on('error', err => console.error('[Order Service] Redis Error:', err.message));
    await redis.connect();

    // Create emitter and publish all workflow execution events to Redis
    const emitter = new WorkflowEventEmitter();
    new RedisMonitoringAdapter({
        publisher: pubsubClient(redis),
        channel,
    }).attachToEmitter(emitter);

    setDefaultMonitor(emitter);

    const orderWorkflow = createOrderWorkflow(httpFulfillmentClient).monitor(emitter);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

        if (req.method === 'GET' && url.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', service: 'order-service' }));
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/orders') {
            let body = '';
            req.on('data', chunk => (body += chunk));
            req.on('end', async () => {
                try {
                    const payload: OrderInput = JSON.parse(body || '{}');

                    // Extract caller-supplied stackId or let Siglo generate one
                    const stackId = (req.headers['x-stack-id'] as string) || undefined;
                    // Extract tenant namespace from header or body
                    const namespace =
                        (req.headers['x-tenant-id'] as string) ||
                        (req.headers['x-namespace'] as string) ||
                        (payload as any).tenantId ||
                        undefined;

                    console.log(
                        `[Order Service] Ingesting order "${payload.orderId}" for tenant "${namespace || 'default'}" (stackId: ${stackId || 'auto-generate'})`,
                    );

                    const result = await orderWorkflow.run(payload, {
                        stackId,
                        namespace,
                        workflowId: 'order-processing-service',
                        pojo: true,
                    });

                    const effectiveStackId = result.$stackId || stackId;

                    res.writeHead(201, {
                        'Content-Type': 'application/json',
                        'X-Workflow-Stack-Id': effectiveStackId,
                        'X-Tenant-Id': namespace || '',
                    });
                    res.end(
                        JSON.stringify({
                            orderId: result.orderId,
                            status: result.status,
                            stackId: effectiveStackId,
                            namespace: result.namespace || namespace,
                            trackingId: result.fulfillment?.trackingId,
                            fulfillment: result.fulfillment,
                            childWorkflow: result.childWorkflow,
                            completedAt: result.completedAt,
                        }),
                    );
                } catch (error: any) {
                    console.error('[Order Service] Order execution error:', error);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: error?.message || 'Order processing failed' }));
                }
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(`[Order Service] Listening on http://0.0.0.0:${port}`);
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
