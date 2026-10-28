import test from 'node:test';
import assert from 'node:assert/strict';
import { trace } from '@opentelemetry/api';
import {
    createHttpCheckoutWorkflow,
    createFastifyCheckoutHandler,
    createExpressCheckoutHandler,
    createHonoCheckoutHandler,
    createKafkaTransactionConsumer,
    createBullMqImageProcessor,
    createSqsImageBatchConsumer,
    MockSpan,
    MockTracer,
    setupInstrumentedWorkflow,
    MockPostgresClient,
    MockRedisClient,
    setupSaaSBillingInfrastructure
} from './workflow/phase3';

test('Phase 3 Ecosystem & Adoption Integration Test Suite', async (t) => {

    // ========================================================================
    // Use Case 18: HTTP Checkout & Order Processing Microservice
    // ========================================================================
    await t.test('Use Case 18: HTTP Checkout & Order Processing (Fastify, Express, Hono)', async (st) => {
        const workflow = createHttpCheckoutWorkflow();

        await st.test('Fastify adapter handles valid checkout and propagates x-namespace', async () => {
            const handler = createFastifyCheckoutHandler(workflow);
            const mockRequest = {
                body: {
                    orderId: 'ORD-FASTIFY-101',
                    items: [{ sku: 'PRO-KEYBOARD', price: 150, quantity: 1 }],
                    currency: 'USD',
                    customerEmail: 'dev@company.com'
                },
                headers: { 'x-namespace': 'ecom-us-west' }
            };

            const mockReply = {
                statusCode: 200,
                headers: {} as Record<string, string>,
                payload: null as any,
                status(code: number) { this.statusCode = code; return this; },
                header(k: string, v: string) { this.headers[k] = v; return this; },
                send(data: any) { this.payload = data; return this; }
            };

            const res = await handler(mockRequest as any, mockReply as any);
            const finalPayload = res || mockReply.payload;

            assert.equal(mockReply.statusCode, 200);
            assert.equal(finalPayload.orderId, 'ORD-FASTIFY-101');
            assert.equal(finalPayload.status, 'PAID');
            assert.equal(finalPayload.totalAmount, 150);
            assert.ok(finalPayload.confirmationCode.startsWith('CONF-'));
        });

        await st.test('Express adapter handles validation error with 400 Bad Request', async () => {
            const handler = createExpressCheckoutHandler(workflow);
            const mockReq = {
                body: { orderId: '', items: [] }, // Invalid empty payload
                headers: { 'x-namespace': 'ecom-error' }
            };

            let capturedStatus = 0;
            let capturedBody: any = null;

            const mockRes = {
                status(code: number) { capturedStatus = code; return this; },
                json(data: any) { capturedBody = data; return this; },
                setHeader() { return this; }
            };

            await handler(mockReq as any, mockRes as any, () => {});

            assert.equal(capturedStatus, 400);
            assert.equal(capturedBody.code, 'BAD_REQUEST');
            assert.ok(capturedBody.error.includes('InvalidOrderPayload'));
        });

        await st.test('Hono adapter handles checkout request cleanly', async () => {
            const handler = createHonoCheckoutHandler(workflow);
            const mockContext = {
                req: {
                    json: async () => ({
                        orderId: 'ORD-HONO-202',
                        items: [{ sku: 'MONITOR-4K', price: 400, quantity: 2 }],
                        currency: 'USD',
                        customerEmail: 'hono@edge.org'
                    }),
                    header: (name: string) => (name.toLowerCase() === 'x-namespace' ? 'edge-asia' : undefined)
                },
                header() {},
                json(body: any, status = 200) {
                    return { body, status };
                }
            };

            const response: any = await handler(mockContext as any);
            assert.equal(response.orderId, 'ORD-HONO-202');
            assert.equal(response.status, 'PAID');
            assert.equal(response.totalAmount, 800);
        });
    });

    // ========================================================================
    // Use Case 19: High-Volume Event-Driven Kafka Stream Enrichment
    // ========================================================================
    await t.test('Use Case 19: High-Volume Event-Driven Kafka Stream Enrichment', async (st) => {
        const kafkaConsumer = createKafkaTransactionConsumer();

        await st.test('Enriches high-value VIP transaction with namespace and risk scoring', async () => {
            const kafkaMessage = {
                key: Buffer.from('TXN-KAFKA-901'),
                value: Buffer.from(JSON.stringify({
                    transactionId: 'TXN-KAFKA-901',
                    accountId: 'VIP-ACC-777',
                    amount: 12000,
                    currency: 'USD',
                    ipAddress: '198.51.100.24',
                    timestamp: Date.now()
                })),
                headers: {
                    'x-namespace': Buffer.from('fintech-eu')
                },
                offset: '1042',
                partition: 0,
                topic: 'transactions.incoming'
            };

            const payload = {
                topic: 'transactions.incoming',
                partition: 0,
                message: kafkaMessage
            };

            const result: any = await kafkaConsumer(payload as any);

            assert.equal(result.status, 'COMMITTED');
            assert.equal(result.enriched.transactionId, 'TXN-KAFKA-901');
            assert.equal(result.enriched.accountTier, 'VIP');
            assert.equal(result.enriched.namespace, 'fintech-eu');
            assert.equal(result.enriched.isFlagged, true);
            assert.ok(result.enriched.riskScore >= 70);
        });

        await st.test('Routes malformed Kafka payload to Dead-Letter response', async () => {
            const malformedMessage = {
                key: Buffer.from('TXN-ERR-999'),
                value: Buffer.from(JSON.stringify({
                    brokenField: true
                })),
                offset: '1043',
                partition: 0,
                topic: 'transactions.incoming'
            };

            const payload = {
                topic: 'transactions.incoming',
                partition: 0,
                message: malformedMessage
            };

            const result: any = await kafkaConsumer(payload as any);

            assert.equal(result.status, 'DEAD_LETTER');
            assert.ok(result.error.includes('KafkaPayloadError'));
            assert.equal(result.offset, '1043');
        });
    });

    // ========================================================================
    // Use Case 20: Resilient Asynchronous Queue Worker & Dead-Letter Handling
    // ========================================================================
    await t.test('Use Case 20: Resilient Asynchronous Queue Worker (BullMQ & SQS)', async (st) => {
        await st.test('BullMQ processor processes image job and updates progress', async () => {
            const processor = createBullMqImageProcessor();
            let progressValue = 0;

            const mockJob = {
                id: 'job-bullmq-55',
                data: {
                    jobId: 'IMG-PRO-88',
                    imageUrl: 'https://cdn.example.com/raw/hero.png',
                    targetWidth: 1200,
                    targetHeight: 800,
                    format: 'webp',
                    namespace: 'tenant-media'
                },
                updateProgress: async (p: number) => { progressValue = p; }
            };

            const res = await processor(mockJob as any);
            assert.equal(res.jobId, 'job-bullmq-55');
            assert.equal(res.compressionRatio, '93.75%');
            assert.ok(res.outputUri.includes('IMG-PRO-88_1200x800.webp'));
            assert.equal(progressValue, 100);
        });

        await st.test('SQS batch consumer returns partial batch item failures', async () => {
            const sqsConsumer = createSqsImageBatchConsumer();
            const sqsEvent = {
                Records: [
                    {
                        messageId: 'msg-sqs-success',
                        receiptHandle: 'rh-1',
                        body: JSON.stringify({
                            jobId: 'IMG-SQS-01',
                            imageUrl: 'https://cdn.example.com/raw/pic.jpg',
                            format: 'jpeg'
                        }),
                        messageAttributes: {
                            namespace: { stringValue: 'sqs-tenant-1' }
                        }
                    },
                    {
                        messageId: 'msg-sqs-failure',
                        receiptHandle: 'rh-2',
                        body: JSON.stringify({
                            jobId: 'IMG-SQS-02',
                            imageUrl: '' // Invalid empty URL causes step failure
                        }),
                        messageAttributes: {
                            namespace: { stringValue: 'sqs-tenant-1' }
                        }
                    }
                ]
            };

            const response = await sqsConsumer(sqsEvent as any);

            // Verifies AWS Partial Batch Failure reporting
            assert.equal(response.batchItemFailures.length, 1);
            assert.equal(response.batchItemFailures[0].itemIdentifier, 'msg-sqs-failure');
        });
    });

    // ========================================================================
    // Use Case 21: Distributed Tracing & W3C Trace Context Propagation
    // ========================================================================
    await t.test('Use Case 21: Distributed Tracing & W3C Trace Context Propagation', async (st) => {
        const tracer = new MockTracer();
        const {
            instrumented,
            telemetryStorage,
            auditEvents,
            helpers
        } = setupInstrumentedWorkflow(tracer, { allowNamespace: false });

        await st.test('Generates root and step spans with retry attempt tracking', async () => {
            const input: any = {
                orderId: 'ORD-OTEL-99',
                itemsCount: 3,
                customerTier: 'PLATINUM',
                apiKeySecret: 'SECRET_API_KEY_NEVER_LOG',
                billingAddress: '742 Evergreen Terrace'
            };

            const result = await instrumented.run(input, {
                namespace: 'privacy-sensitive-ns',
                timeout: 5000
            });

            assert.equal(result.dispatchStatus(), 'DISPATCHED');
            assert.ok(result.trackingNumber().startsWith('TRK-'));

            // Spans verification
            assert.ok(tracer.spans.length >= 3, 'Expected root workflow span and step spans');
            const wfSpan = tracer.spans.find(s => s.name === 'workflow:ObservableOrderWorkflow');
            assert.ok(wfSpan, 'Workflow root span exists');
            assert.equal(wfSpan?.attributes['rivulet.workflow.name'], 'ObservableOrderWorkflow');

            // Verification of namespace redaction privacy guard
            assert.equal(
                wfSpan?.attributes[helpers.SemanticAttributes.NAMESPACE],
                undefined,
                'Namespace must be redacted when allowNamespace is false'
            );

            // Verification of retry attempt tracking
            const initialSpan = tracer.spans.find(s => s.name === 'step:dispatchOrder');
            assert.ok(initialSpan, 'Initial dispatch order step span exists');
            assert.equal(initialSpan?.attributes['rivulet.step.attempt'], 1);

            const retrySpan = tracer.spans.find(s => s.name === 'step:dispatchOrder (retry #2)');
            assert.ok(retrySpan, 'Retry step span exists with incremented attempt attribute');
            assert.equal(retrySpan?.attributes['rivulet.step.attempt'], 2);
        });

        await st.test('Extracts W3C traceparent headers across boundaries', async () => {
            const testCarrier = {
                traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
            };

            const extracted = helpers.extractTraceContext(testCarrier);
            assert.ok(extracted, 'Extracted context exists');

            const headers = helpers.getTraceHeaders(tracer.spans[0] as any);
            assert.equal(headers.traceparent, '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
        });

        await st.test('Sanitized Telemetry Storage Adapter only records allowlisted fields', async () => {
            const testSpan = new MockSpan('active-test-span');
            const origGetSpan = trace.getActiveSpan;
            (trace as any).getActiveSpan = () => testSpan as any;

            try {
                await telemetryStorage.onContextChange({
                    namespace: 'privacy-ns',
                    stackId: 'stack-123',
                    stepId: 'validateOrder',
                    field: 'orderId',
                    value: 'ORD-OTEL-99',
                    timestamp: Date.now()
                });
                await telemetryStorage.onContextChange({
                    namespace: 'privacy-ns',
                    stackId: 'stack-123',
                    stepId: 'validateOrder',
                    field: 'apiKeySecret',
                    value: 'SUPER_SECRET_TOKEN',
                    timestamp: Date.now()
                });
            } finally {
                (trace as any).getActiveSpan = origGetSpan;
            }

            assert.equal(testSpan.attributes['rivulet.context.orderId'], 'ORD-OTEL-99');
            assert.equal(testSpan.attributes['rivulet.context.apiKeySecret'], undefined);
            assert.equal(auditEvents.length, 1, 'Only allowlisted orderId was recorded; apiKeySecret was omitted');
            assert.equal(auditEvents[0].field, 'orderId');
        });
    });

    // ========================================================================
    // Use Case 22: Multi-Tenant SaaS Billing & Audit Ledger (Postgres & Redis)
    // ========================================================================
    await t.test('Use Case 22: Multi-Tenant SaaS Billing & Audit Ledger (Postgres & Redis)', async (st) => {
        const pgClient = new MockPostgresClient();
        const redisClient = new MockRedisClient();
        const {
            workflow,
            postgresStorage,
            postgresIdempotency,
            redisStorage,
            redisIdempotency,
            redisLock
        } = setupSaaSBillingInfrastructure(pgClient, redisClient);

        await st.test('Executes enterprise SaaS billing workflow with namespace isolation', async () => {
            const usage = {
                billingPeriod: '2026-Q1',
                organizationId: 'ORG-STARK-IND',
                apiRequests: 500000,
                computeMinutes: 1200,
                storageGigabytes: 400
            };

            const result = await workflow.run(usage, {
                namespace: 'enterprise-stark',
                stackId: 'stack-bill-001'
            });

            assert.equal(result.subtotal(), 150);
            assert.equal(result.discount(), 15);
            assert.equal(result.totalAmount(), 135);
            assert.equal(result.status(), 'INVOICED');
            assert.equal(result.namespace(), 'enterprise-stark');
            assert.equal(result.invoiceId(), 'INV-ENTERPRISE-STARK-2026-Q1');
        });

        await st.test('Postgres storage adapter saves and retrieves durable checkpoints', async () => {
            const checkpointSnapshot: any = {
                stackId: 'stack-bill-001',
                namespace: 'enterprise-stark',
                state: { invoiceId: 'INV-ENTERPRISE-STARK-2026-Q1', totalAmount: 135 }
            };

            await postgresStorage.saveCheckpoint(checkpointSnapshot);

            const retrieved: any = await postgresStorage.getCheckpoint('stack-bill-001');
            assert.ok(retrieved, 'Checkpoint retrieved from Postgres');
            assert.equal(retrieved?.namespace, 'enterprise-stark');
            assert.equal(retrieved?.state?.totalAmount, 135);
        });

        await st.test('Postgres & Redis Idempotency Stores prevent duplicate billing webhooks', async () => {
            const idempotencyKey = 'ff:idemp:enterprise-stark:2.0.0:2026-Q1';

            // 1. Fresh claim succeeds
            const claim1 = await postgresIdempotency.claim(idempotencyKey);
            assert.equal(claim1, 'claimed');

            // 2. Concurrent duplicate claim reports in-progress
            const claim2 = await postgresIdempotency.claim(idempotencyKey);
            assert.equal(claim2, 'in-progress');

            // 3. Mark completed with invoice response
            await postgresIdempotency.complete(idempotencyKey, { invoiceId: 'INV-STARK-001', amount: 135 });

            // 4. Redis Idempotency parity check
            const redisClaim1 = await redisIdempotency.claim(idempotencyKey);
            assert.equal(redisClaim1, 'claimed');
            const redisClaim2 = await redisIdempotency.claim(idempotencyKey);
            assert.equal(redisClaim2, 'in-progress');
        });

        await st.test('Redis distributed lock ensures single-flight batch coordination', async () => {
            let executed = false;
            await redisLock.withLock('lock:billing:batch:2026-Q1', async () => {
                executed = true;
            });
            assert.equal(executed, true, 'Code executed under distributed lock protection');
        });
    });
});
