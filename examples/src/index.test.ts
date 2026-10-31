import test from 'node:test';
import assert from 'node:assert/strict';
import { Step } from 'siglo';
import { createRedisClient } from './database/redis';
import { createMongoClient } from './database/mongodb';
import { registerRedisMongoStorage } from './plugin/redis-mongo-storage';
import { createOrderPipeline, OrderInput } from './workflow/order-pipeline';
import {
    // Phase 1 Use Cases
    createEcommerceSagaPipeline,
    createAiRagPipeline,
    createFinancialFraudPipeline,
    createMediaTranscodingPipeline,
    createIotTelemetryPipeline,
    createCdcLakehousePipeline,
    createKycOnboardingPipeline,
    createHealthcareFhirPipeline,
    createOmnichannelNotificationPipeline,
    createSecOpsRemediationPipeline,

    // Phase 2 Use Cases
    createTravelBookingSagaPipeline,
    createBoundedBatchIngestionPipeline,
    createMultiCloudReplicationPipeline,
    createLoanUnderwritingPipeline,
    createIdempotentSettlementPipeline,
    createDurableExpenseApprovalWorkflow,
    createGovernedDeploymentPipeline,

    // Phase 3 Use Cases
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

// ============================================================================
//   Base Storage Plugin & Order Pipeline Test
// ============================================================================

test('Order pipeline executes correctly using Redis & MongoDB storage adapter', async () => {
    const redis = createRedisClient();
    const mongo = createMongoClient();

    // Register adapter
    registerRedisMongoStorage(redis, mongo);

    // Initialize pipeline after adapter registration
    const pipeline = createOrderPipeline();

    const order: OrderInput = {
        orderId: 'TEST-1001',
        customer: {
            name: 'John Matrix',
            email: 'matrix@command.com'
        },
        items: [
            { id: '1', name: 'Item Alpha', price: 50, quantity: 2 } // $100 subtotal
        ],
        couponCode: 'SAVE10'
    };

    const result = await pipeline.run(order);

    // 1. Verify pipeline business logic calculations
    assert.equal(result.invoiceStatus, 'PAID');
    assert.equal(result.invoiceId, 'INV-TEST-1001');
    assert.equal(result.subtotal, 100);
    assert.equal(result.discount, 10); // 10% of 100
    assert.equal(result.tax, 7.20);   // 8% of 90
    assert.equal(result.amountCharged, 97.20);

    // 2. Verify MongoDB persistent storage of execution logs
    const logsInDb = await mongo.collection('siglo_execution_logs').find();
    assert.ok(logsInDb.length > 0, 'Execution context logs should be recorded in MongoDB');

    // Verify 100% of execution logs have a valid, non-null stackId
    const nullStackLogs = logsInDb.filter(l => !l.stackId);
    assert.equal(nullStackLogs.length, 0, 'No execution log entry should have a null or undefined stackId');
    assert.ok(logsInDb.every(l => typeof l.stackId === 'string' && l.stackId.length > 0), 'Every log must have a valid string stackId');

    // 3. Verify Redis context entries
    const firstStackId = logsInDb[0].stackId;
    const stackHash = await redis.hgetall(`siglo:stack:${firstStackId}`);
    assert.ok(Object.keys(stackHash).length > 0, 'Redis should have context keys grouped under siglo:stack:{stackId}');

    // 4. Verify durable checkpoint retrieval from storage adapter
    const retrievedChk = await Step.getCheckpoint(firstStackId);
    assert.ok(retrievedChk !== undefined, 'Checkpoint should be saved and retrievable via storage adapter');
    assert.equal(retrievedChk?.stackId, firstStackId);
});

// ============================================================================
//   Phase 1: Event-Driven Distributed Architectures (Use Cases 1 to 10)
// ============================================================================

test('Phase 1 Use Cases Integration Suite', async (t) => {
    await t.test('Use Case 1: E-Commerce Saga Orchestration', async () => {
        const saga = createEcommerceSagaPipeline();
        const res = await saga.run({
            orderId: 'ORD-TEST-1',
            customerId: 'CUST-1',
            cartItems: [{ sku: 'SKU-A', name: 'Product A', price: 100, quantity: 1 }],
            paymentDetails: { cardNumber: '4111-XXXX-XXXX-1111', amount: 100 },
            shippingAddress: { street: '1 Main St', city: 'City', zip: '12345' }
        });
        assert.equal(res.sagaStatus, 'COMPLETED');
        assert.ok(res.trackingNumber);
        assert.equal(res.paymentStatus, 'CAPTURED');
    });

    await t.test('Use Case 2: AI RAG Pipeline', async () => {
        const { pipeline } = createAiRagPipeline();
        const res = await pipeline.run({
            documentId: 'DOC-1',
            sourceUri: 's3://docs/test.pdf',
            mimeType: 'application/pdf',
            rawText: 'Siglo is a lightweight workflow orchestrator with discrete step execution.'
        });
        assert.equal(res.ragPipelineStatus, 'INDEXED');
        assert.ok(res.indexedVectors >= 1);
    });

    await t.test('Use Case 3: Financial Fraud Detection', async () => {
        const pipeline = createFinancialFraudPipeline();
        const res = await pipeline.run({
            transactionId: 'TXN-1',
            sourceAccountId: 'ACC-1',
            destinationAccountId: 'ACC-2',
            amount: 500,
            currency: 'USD',
            clientIp: '127.0.0.1',
            timestamp: Date.now()
        });
        assert.equal(res.finStatus, 'COMPLETED');
        assert.ok(typeof res.riskScore === 'number');
    });

    await t.test('Use Case 4: Asynchronous Media Transcoding', async () => {
        const pipeline = createMediaTranscodingPipeline();
        const res = await pipeline.run({
            assetId: 'MEDIA-1',
            sourceS3Url: 's3://bucket/video.mp4',
            targetResolutions: ['1080p', '720p'],
            uploadedBy: 'user-1'
        });
        assert.equal(res.mediaPipelineStatus, 'READY_TO_STREAM');
        assert.ok(res.masterManifestUrl.includes('master.m3u8'));
    });

    await t.test('Use Case 5: High-Throughput IoT Telemetry', async () => {
        const pipeline = createIotTelemetryPipeline();
        const res = await pipeline.run({
            deviceId: 'DEV-1',
            fleetId: 'FLEET-1',
            batchSequence: 1,
            readings: [
                { sensorId: 'S-1', temperatureFahrenheit: 210, pressurePsi: 85, vibrationG: 1.5, recordedAt: Date.now() }
            ]
        });
        assert.equal(res.iotPipelineStatus, 'PROCESSED');
        assert.equal(res.anomalyDetected, true);
    });

    await t.test('Use Case 6: CDC Lakehouse ETL', async () => {
        const pipeline = createCdcLakehousePipeline();
        const res = await pipeline.run({
            op: 'c',
            source: { db: 'db1', table: 'tbl_users', lsn: 100, ts_ms: Date.now() },
            before: null,
            after: {
                usr_id_pk: 'U1',
                usr_email_addr: 'test@example.com',
                first_nm: 'First',
                last_nm: 'Last',
                acct_bal_amt: '100.00'
            }
        });
        assert.equal(res.cdcPipelineStatus, 'COMMITTED');
        assert.ok(res.partitionPath.includes('tbl_users'));
    });

    await t.test('Use Case 7: KYC Onboarding & Identity Verification', async () => {
        const pipeline = createKycOnboardingPipeline();
        const res = await pipeline.run({
            applicantId: 'APP-1',
            fullName: 'Jane Doe',
            country: 'US',
            idType: 'PASSPORT',
            documentNumber: 'USA-12345',
            documentBase64: 'data:image/jpeg;base64,...',
            selfieBase64: 'data:image/jpeg;base64,...'
        });
        assert.equal(res.kycPipelineStatus, 'APPROVED');
        assert.ok(res.customerAccountNumber);
    });

    await t.test('Use Case 8: Healthcare FHIR Clinical Integration', async () => {
        const pipeline = createHealthcareFhirPipeline();
        const res = await pipeline.run({
            feedId: 'FEED-1',
            hospitalUnit: 'ICU-1',
            traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
            observation: {
                resourceType: 'Observation',
                id: 'obs-1',
                status: 'final',
                code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart Rate' }] },
                subject: { reference: 'Patient/1', patientSsn: '000-00-0000', patientName: 'John' },
                effectiveDateTime: new Date().toISOString(),
                valueQuantity: { value: 140, unit: 'bpm', system: 'http://unitsofmeasure.org' }
            }
        });
        assert.equal(res.healthcarePipelineStatus, 'SYNCHRONIZED');
        assert.equal(res.alertLevel, 'STAT_EMERGENCY');
    });

    await t.test('Use Case 9: Omnichannel Notifications', async () => {
        const pipeline = createOmnichannelNotificationPipeline();
        const res = await pipeline.run({
            campaignId: 'CAMP-1',
            userId: 'U-1',
            recipientEmail: 'test@example.com',
            recipientPhone: '+1-555-0100',
            templateKey: 'WELCOME',
            templateVariables: { name: 'Alice' },
            fallbackChannels: ['PUSH', 'EMAIL']
        });
        assert.equal(res.notificationPipelineStatus, 'DELIVERED');
        assert.equal(res.channel, 'PUSH');
    });

    await t.test('Use Case 10: Automated SecOps Remediation', async () => {
        const pipeline = createSecOpsRemediationPipeline();
        const res = await pipeline.run({
            alertId: 'SEC-1',
            clusterName: 'cluster-1',
            nodeId: 'node-1',
            podId: 'pod-1',
            anomalyMetric: 'cpu',
            metricValue: 8.5,
            threshold: 4.0,
            severity: 'CRITICAL',
            maintenanceWindowActive: false
        });
        assert.equal(res.secopsPipelineStatus, 'RESOLVED');
        assert.ok(res.incidentTicket);
        assert.equal(res.quarantinedNode, 'node-1');
    });
});

// ============================================================================
//   Phase 2: Core Workflow Power, Concurrency & Graph Governance (Use Cases 11 to 17)
// ============================================================================

test('Phase 2 Use Cases Integration Suite', async (t) => {
    await t.test('Use Case 11: Multi-Service Travel Booking Saga with LIFO Compensations', async () => {
        const audit = { actions: [], compensations: [] };
        const saga = createTravelBookingSagaPipeline(audit);
        const res = await saga.run({
            bookingId: 'BK-TEST-1',
            passengerName: 'Grace',
            flightNumber: 'UA-100',
            hotelName: 'Grand Hotel',
            shouldFailPayment: false
        });
        assert.equal(res.sagaStatus, 'COMPLETED');
        assert.equal(res.vouchersIssued, true);
        assert.equal(res.totalAmount, 800);
    });

    await t.test('Use Case 12: Bounded Batch Ingestion Pipeline', async () => {
        const tracker = { current: 0, peak: 0, processedIds: [] };
        const pipeline = createBoundedBatchIngestionPipeline(tracker);
        const res = await pipeline.run({
            batchId: 'BATCH-1',
            department: 'Eng',
            documents: [
                { docId: 'D1', title: 'Doc 1', category: 'RFC', content: 'Content 1' },
                { docId: 'D2', title: 'Doc 2', category: 'Sec', content: 'Content 2' }
            ]
        });
        assert.equal(res.pipelineStatus, 'COMPLETED');
        assert.equal(res.totalIndexed, 2);
        assert.ok(tracker.peak <= 3);
    });

    await t.test('Use Case 13: Multi-Cloud Latency Race & Parallel Replication', async () => {
        const pipeline = createMultiCloudReplicationPipeline();
        const res = await pipeline.run({
            assetId: 'MEDIA-1',
            fileName: 'video.mp4',
            byteSize: 1024,
            mimeType: 'video/mp4'
        });
        assert.equal(res.pipelineStatus, 'REPLICATED');
        assert.ok(res.selectedEdge);
    });

    await t.test('Use Case 14: Dynamic Loan Underwriting Engine', async () => {
        const pipeline = createLoanUnderwritingPipeline();
        const res = await pipeline.run({
            applicationId: 'LOAN-1',
            applicantName: 'Evelyn',
            creditScore: 800,
            annualIncome: 150000,
            requestedAmount: 25000,
            hasPartnerPromo: true
        });
        assert.equal(res.riskTier, 'PRIME');
        assert.equal(res.decision, 'APPROVED_INSTANT');
        assert.equal(res.interestRate, 4.25);
    });

    await t.test('Use Case 15: Scoped Financial Settlement & Idempotent Claim Locking', async () => {
        const { pipeline, stats } = createIdempotentSettlementPipeline();
        const input = {
            transactionId: 'TXN-BANK-1',
            sourceAccount: 'ACC-1',
            targetAccount: 'ACC-2',
            amount: 5000,
            currency: 'USD'
        };
        const r1 = await pipeline.run(input);
        assert.equal(r1.pipelineStatus, 'SETTLED');
        assert.equal(stats.settlementExecutionCount, 1);

        // Deduplication
        await pipeline.run(input);
        assert.equal(stats.settlementExecutionCount, 1);
    });

    await t.test('Use Case 16: Durable Long-Running Expense Approval Workflow', async () => {
        const workflow = createDurableExpenseApprovalWorkflow();
        const reportId = 'EXP-1';
        const suspendRes: any = await workflow.run({
            reportId,
            employeeEmail: 'user@example.com',
            expenseCategory: 'TRAVEL',
            amount: 1500
        }, { durable: true });

        assert.equal(suspendRes.status, 'waiting');
        assert.equal(suspendRes.eventName, 'expense.decision');

        const resumeRes = await workflow.resume(reportId, {
            approvedBy: 'manager@example.com',
            approvedAmount: 1500
        });
        assert.equal(resumeRes.pipelineStatus, 'REIMBURSED');
        assert.equal(resumeRes.disbursedAmount, 1500);
    });

    await t.test('Use Case 17: CI/CD Pipeline AST Graph Governance', async () => {
        const { workflow, auditWorkflowGovernance } = createGovernedDeploymentPipeline();
        const audit = auditWorkflowGovernance();
        assert.equal(audit.isCompliant, true);
        assert.ok(audit.metrics.totalNodes >= 5);

        const res = await workflow.run({
            releaseId: 'REL-1',
            commitSha: 'abc1234',
            environment: 'production'
        });
        assert.ok(res.activeCluster);
    });
});

// ============================================================================
//   Phase 3: Ecosystem, Adapters & Distributed Power (Use Cases 18 to 22)
// ============================================================================

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
