import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createHttpCheckoutWorkflow,
    createFastifyCheckoutHandler,
    createExpressCheckoutHandler,
    createHonoCheckoutHandler,
    createKafkaEnrichmentWorkflow,
    createKafkaTransactionConsumer,
    createImageOptimizationWorkflow,
    createBullMqImageProcessor,
    createSqsImageBatchConsumer,
    MockSpan,
    MockTracer,
    createObservableOrderWorkflow,
    setupInstrumentedWorkflow,
    MockPostgresClient,
    MockRedisClient,
    createSaaSBillingWorkflow,
    setupSaaSBillingInfrastructure
} from './workflow/usecases';

test('Phase 3 Use Cases Integration Suite', async (t) => {
    await t.test('Use Case 18: HTTP Checkout Service across Fastify, Express, and Hono', async (sub) => {
        const rawWorkflow = createHttpCheckoutWorkflow();
        assert.ok(rawWorkflow);

        // 1. Fastify Handler - Success & Validation Error
        await sub.test('Fastify Adapter Handler', async () => {
            const fastifyHandler = createFastifyCheckoutHandler(rawWorkflow);
            const mockReply = {
                statusCode: 200,
                headers: {} as Record<string, string>,
                payload: null as any,
                status(code: number) { this.statusCode = code; return this; },
                header(k: string, v: string) { this.headers[k] = v; return this; },
                send(data: any) { this.payload = data; return this; }
            };

            const successRes: any = await fastifyHandler({
                body: { orderId: 'ORD-F-1', items: [{ sku: 'ITEM-1', price: 100, quantity: 2 }] },
                headers: { 'x-namespace': 'fastify-tenant' }
            } as any, mockReply as any);
            const data = successRes || mockReply.payload;
            assert.equal(data.status, 'PAID');
            assert.equal(data.totalAmount, 200);

            // Validation Error Branch
            const errReply = {
                statusCode: 200,
                status(code: number) { this.statusCode = code; return this; },
                header() { return this; },
                send(data: any) { this.payload = data; return this; }
            };
            const errRes: any = await fastifyHandler({
                body: { orderId: 'BAD', items: [] }
            } as any, errReply as any);
            assert.equal((errRes || errReply).status, 400);
        });

        // 2. Express Middleware - Success & Validation Error
        await sub.test('Express Adapter Handler', async () => {
            const expressHandler = createExpressCheckoutHandler(rawWorkflow);
            const mockRes = {
                statusCode: 200,
                headers: {} as Record<string, string>,
                payload: null as any,
                status(code: number) { this.statusCode = code; return this; },
                setHeader(k: string, v: string) { this.headers[k] = v; return this; },
                json(data: any) { this.payload = data; return this; }
            };

            const successRes: any = await expressHandler({
                body: { orderId: 'ORD-E-1', items: [{ sku: 'ITEM-2', price: 50, quantity: 3 }] },
                headers: { 'x-namespace': 'express-tenant' }
            } as any, mockRes as any, () => {});
            const data = successRes || mockRes.payload;
            assert.equal(data.status, 'PAID');
            assert.equal(data.totalAmount, 150);

            // Validation Error Branch
            let errorStatus = 0;
            const errRes = {
                status(code: number) { errorStatus = code; return this; },
                json(d: any) { this.payload = d; return this; }
            };
            await expressHandler({
                body: { orderId: '', items: [] }
            } as any, errRes as any, () => {});
            assert.equal(errorStatus, 400);
        });

        // 3. Hono Middleware - Success & Validation Error
        await sub.test('Hono Adapter Handler', async () => {
            const honoHandler = createHonoCheckoutHandler(rawWorkflow);
            const mockC = {
                req: {
                    json: async () => ({ orderId: 'ORD-H-1', items: [{ sku: 'ITEM-3', price: 80, quantity: 1 }] }),
                    header: (k: string) => k === 'x-namespace' ? 'hono-tenant' : undefined
                },
                header() {},
                json(data: any) { return data; }
            };

            const successRes: any = await honoHandler(mockC as any);
            assert.equal(successRes.status, 'PAID');
            assert.equal(successRes.totalAmount, 80);

            // Validation Error Branch
            const errC = {
                req: {
                    json: async () => ({ orderId: 'BAD', items: [] }),
                    header: () => undefined
                },
                header() {},
                json(data: any) { return data; }
            };
            const errRes: any = await honoHandler(errC as any);
            assert.equal(errRes.status, 400);
        });
    });

    await t.test('Use Case 19: Kafka Stream Enrichment & Direct Workflow', async () => {
        const rawWorkflow = createKafkaEnrichmentWorkflow();
        assert.ok(rawWorkflow);

        const consumer = createKafkaTransactionConsumer(rawWorkflow);
        const res: any = await consumer({
            topic: 'payments.stream',
            partition: 1,
            message: {
                key: 'user-vip',
                value: Buffer.from(JSON.stringify({
                    transactionId: 'TX-KAFKA-1',
                    accountId: 'VIP-TRADER-1',
                    amount: 6000,
                    currency: 'USD'
                })),
                offset: '101'
            }
        });
        assert.equal(res.status, 'COMMITTED');
        assert.equal(res.enriched.accountTier, 'VIP');
        assert.equal(res.enriched.isFlagged, false);
    });

    await t.test('Use Case 20: Async Queue Worker (BullMQ & SQS)', async () => {
        const rawWorkflow = createImageOptimizationWorkflow();
        assert.ok(rawWorkflow);

        // 1. BullMQ
        const bullProcessor = createBullMqImageProcessor(rawWorkflow);
        let progress = 0;
        const bullRes: any = await bullProcessor({
            id: 'job-1',
            data: { jobId: 'IMG-1', imageUrl: 'https://cdn.example.com/raw.png', targetWidth: 800, targetHeight: 600 },
            updateProgress: async (p: number) => { progress = p; }
        });
        assert.equal(bullRes.jobId, 'job-1');
        assert.equal(progress, 100);

        // 2. SQS
        const sqsConsumer = createSqsImageBatchConsumer(rawWorkflow);
        const sqsRes = await sqsConsumer({
            Records: [
                {
                    messageId: 'sqs-1',
                    receiptHandle: 'rh-1',
                    body: JSON.stringify({ jobId: 'IMG-2', imageUrl: 'https://cdn.example.com/sqs.png' })
                }
            ]
        });
        assert.equal(sqsRes.processedCount, 1);
        assert.equal(sqsRes.batchItemFailures.length, 0);
    });

    await t.test('Use Case 21: Distributed Telemetry & Tracing', async () => {
        const rawWorkflow = createObservableOrderWorkflow();
        assert.ok(rawWorkflow);

        const tracer = new MockTracer();
        const { instrumented } = setupInstrumentedWorkflow(tracer, { allowNamespace: true });
        const res = await instrumented.run({
            orderId: 'ORD-OTEL-1',
            itemsCount: 1,
            customerTier: 'STANDARD',
            apiKeySecret: 'secret',
            billingAddress: 'Main St'
        }, { namespace: 'tenant-otel' });

        assert.equal(res.dispatchStatus, 'DISPATCHED');
        assert.ok(tracer.spans.length >= 3);

        const mockSpan = new MockSpan('test-span');
        mockSpan.setAttribute('key', 'val');
        mockSpan.end();
        assert.equal(mockSpan.name, 'test-span');
        assert.equal(mockSpan.ended, true);
    });

    await t.test('Use Case 22: Multi-Tenant SaaS Billing Ledger', async () => {
        const rawWorkflow = createSaaSBillingWorkflow();
        assert.ok(rawWorkflow);

        const pgClient = new MockPostgresClient();
        const redisClient = new MockRedisClient();
        const { workflow } = setupSaaSBillingInfrastructure(pgClient, redisClient);

        const res = await workflow.run({
            billingPeriod: '2026-M1',
            organizationId: 'ORG-TEST',
            apiRequests: 100000,
            computeMinutes: 120,
            storageGigabytes: 50
        }, { namespace: 'tenant-test', stackId: 'stack-test-1' });

        assert.equal(res.status, 'INVOICED');
        assert.ok(res.invoiceId);
        assert.ok(res.totalAmount > 0);
    });
});
