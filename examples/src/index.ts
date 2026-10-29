import {createRedisClient} from './database/redis';
import {createMongoClient} from './database/mongodb';
import {registerRedisMongoStorage} from './plugin/redis-mongo-storage';
import {createOrderPipeline, OrderInput} from './workflow/order-pipeline';
import {
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
    createTravelBookingSagaPipeline,
    createBoundedBatchIngestionPipeline,
    createMultiCloudReplicationPipeline,
    createLoanUnderwritingPipeline,
    createIdempotentSettlementPipeline,
    createDurableExpenseApprovalWorkflow,
    createGovernedDeploymentPipeline,
    createHttpCheckoutWorkflow,
    createFastifyCheckoutHandler,
    createKafkaTransactionConsumer,
    createBullMqImageProcessor,
    MockTracer,
    setupInstrumentedWorkflow,
    MockPostgresClient,
    MockRedisClient,
    setupSaaSBillingInfrastructure
} from './workflow/usecases';

async function main() {
    console.log('========================================================================');
    console.log('   siglo: Top 22 Production Event-Driven & Workflow Use Cases');
    console.log('========================================================================\n');

    // 1. Initialize Database Connectors & Register Storage Hooks
    const redis = createRedisClient();
    const mongo = createMongoClient();
    registerRedisMongoStorage(redis, mongo);

    // --- Original Order Pipeline ---
    console.log('\n[Demo] 0. Running Base Order Pipeline...');
    const orderPipeline = createOrderPipeline();
    const orderInput: OrderInput = {
        orderId: 'ORD-98721',
        customer: {name: 'Sarah Connor', email: 'sarah.connor@example.com'},
        items: [
            {id: 'item_1', name: 'Mechanical Keyboard', price: 80, quantity: 1},
            {id: 'item_2', name: 'USB-C Cable', price: 15, quantity: 2}
        ],
        couponCode: 'SAVE10'
    };
    const orderResult = await orderPipeline.run(orderInput);
    console.log(`  ✔ Base Order Pipeline -> Invoice ID: ${orderResult.invoiceId}, Total: $${orderResult.amountCharged()}`);

    // --- 1. E-Commerce Saga ---
    console.log('\n[Demo] 1. E-Commerce Distributed Checkout & Saga Orchestration...');
    const saga = createEcommerceSagaPipeline();
    const sagaRes = await saga.run({
        orderId: 'ORD-SAGA-991',
        customerId: 'CUST-402',
        cartItems: [
            {sku: 'SKU-LAPTOP', name: 'Dev Laptop', price: 1200, quantity: 1},
            {sku: 'SKU-MOUSE', name: 'Wireless Mouse', price: 50, quantity: 2}
        ],
        paymentDetails: {cardNumber: '4111-XXXX-XXXX-1111', amount: 1300},
        shippingAddress: {street: '100 Infinite Loop', city: 'Cupertino', zip: '95014'}
    });
    console.log(`  ✔ E-Commerce Saga -> Status: ${sagaRes.sagaStatus}, Tracking: ${sagaRes.trackingNumber()}, Payment: ${sagaRes.paymentStatus}`);

    // --- 2. AI RAG Pipeline ---
    console.log('\n[Demo] 2. Multi-Stage AI / LLM & RAG Ingestion Pipeline...');
    const {pipeline: ragPipeline} = createAiRagPipeline();
    const ragRes = await ragPipeline.run({
        documentId: 'DOC-RAG-882',
        sourceUri: 's3://company-docs/architecture-overview.pdf',
        mimeType: 'application/pdf',
        rawText: 'Siglo provides discrete step execution, deterministic caching, and pluggable storage hooks. ' +
            'Combined with Apache Kafka, teams can build fault-tolerant, event-driven pipelines across distributed clusters.'
    });
    console.log(`  ✔ AI / RAG Pipeline -> Status: ${ragRes.ragPipelineStatus}, Vectors Indexed: ${ragRes.indexedVectors()}`);

    // --- 3. Financial Transaction Processing & Fraud Detection ---
    console.log('\n[Demo] 3. Financial Transaction Processing & Fraud Detection...');
    const finPipeline = createFinancialFraudPipeline();
    const finRes = await finPipeline.run({
        transactionId: 'TXN-FIN-501',
        sourceAccountId: 'ACCT-USER-100',
        destinationAccountId: 'ACCT-USER-200',
        amount: 2500,
        currency: 'USD',
        clientIp: '192.168.1.50',
        timestamp: Date.now()
    });
    console.log(`  ✔ Financial Pipeline -> Status: ${finRes.finStatus}, Journal: ${finRes.journalId()}, Risk Score: ${finRes.riskScore()}`);

    // --- 4. Asynchronous Media Transcoding ---
    console.log('\n[Demo] 4. Asynchronous Media Transcoding & Asset Processing...');
    const mediaPipeline = createMediaTranscodingPipeline();
    const mediaRes = await mediaPipeline.run({
        assetId: 'VID-ASSET-773',
        sourceS3Url: 's3://raw-video-bucket/uploads/product-demo.mp4',
        targetResolutions: ['1080p', '720p', '480p'],
        uploadedBy: 'usr_creative_director'
    });
    console.log(`  ✔ Media Transcoding -> Status: ${mediaRes.mediaPipelineStatus}, Manifest: ${mediaRes.masterManifestUrl}`);

    // --- 5. IoT Telemetry & Anomaly Detection ---
    console.log('\n[Demo] 5. High-Throughput IoT Telemetry & Anomaly Detection...');
    const iotPipeline = createIotTelemetryPipeline();
    const iotRes = await iotPipeline.run({
        deviceId: 'TURBINE-EDGE-04',
        fleetId: 'WIND-FARM-NORTH',
        batchSequence: 1042,
        readings: [
            {
                sensorId: 'TEMP-01',
                temperatureFahrenheit: 195.0,
                pressurePsi: 80.0,
                vibrationG: 1.2,
                recordedAt: Date.now()
            },
            {
                sensorId: 'TEMP-02',
                temperatureFahrenheit: 190.0,
                pressurePsi: 82.0,
                vibrationG: 1.1,
                recordedAt: Date.now()
            }
        ]
    });
    console.log(`  ✔ IoT Telemetry -> Status: ${iotRes.iotPipelineStatus}, Anomaly: ${iotRes.anomalyDetected}, Dispatched Alert: ${iotRes.alertDispatched}`);

    // --- 6. CDC & Data Lakehouse ETL ---
    console.log('\n[Demo] 6. CDC (Change Data Capture) & Data Lakehouse ETL...');
    const cdcPipeline = createCdcLakehousePipeline();
    const cdcRes = await cdcPipeline.run({
        op: 'c',
        source: {db: 'production_store', table: 'tbl_users', lsn: 94827104, ts_ms: Date.now()},
        before: null,
        after: {
            usr_id_pk: 'U9921',
            usr_email_addr: 'ada.lovelace@pioneer.org',
            first_nm: 'Ada',
            last_nm: 'Lovelace',
            acct_bal_amt: '7500.00'
        }
    });
    console.log(`  ✔ CDC Lakehouse -> Status: ${cdcRes.cdcPipelineStatus}, Partition: ${cdcRes.partitionPath}`);

    // --- 7. KYC Onboarding & Identity Verification ---
    console.log('\n[Demo] 7. Customer Onboarding & Identity Verification (KYC/AML)...');
    const kycPipeline = createKycOnboardingPipeline();
    const kycRes = await kycPipeline.run({
        applicantId: 'APP-9982-KYC',
        fullName: 'Alan Turing',
        country: 'UK',
        idType: 'PASSPORT',
        documentNumber: 'GBR-88392019',
        documentBase64: 'data:image/jpeg;base64,sampledoc...',
        selfieBase64: 'data:image/jpeg;base64,sampleselfie...'
    });
    console.log(`  ✔ KYC Onboarding -> Status: ${kycRes.kycPipelineStatus}, Account: ${kycRes.customerAccountNumber}`);

    // --- 8. Healthcare HL7 / FHIR Integration ---
    console.log('\n[Demo] 8. Healthcare HL7 / FHIR Clinical Event Integration...');
    const fhirPipeline = createHealthcareFhirPipeline();
    const fhirRes = await fhirPipeline.run({
        feedId: 'HL7-FEED-ICU-03',
        hospitalUnit: 'Cardiology-ICU',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        observation: {
            resourceType: 'Observation',
            id: 'obs-heart-rate-99',
            status: 'final',
            code: {coding: [{system: 'http://loinc.org', code: '8867-4', display: 'Heart Rate'}]},
            subject: {reference: 'Patient/1029', patientSsn: '000-12-3456', patientName: 'Grace Hopper'},
            effectiveDateTime: new Date().toISOString(),
            valueQuantity: {value: 145, unit: 'beats/minute', system: 'http://unitsofmeasure.org'}
        }
    });
    console.log(`  ✔ Healthcare FHIR -> Status: ${fhirRes.healthcarePipelineStatus}, Alert: ${fhirRes.alertLevel}, Patient: ${fhirRes.pseudonymousPatientId}`);

    // --- 9. Omnichannel Notifications ---
    console.log('\n[Demo] 9. Multi-Channel Notification & Marketing Campaign Dispatch...');
    const notifyPipeline = createOmnichannelNotificationPipeline();
    const notifyRes = await notifyPipeline.run({
        campaignId: 'CAMP-SPRING-2026',
        userId: 'USR-8821',
        recipientEmail: 'clarke@author.org',
        recipientPhone: '+1-555-0199',
        templateKey: 'PROMO_FLASH_SALE',
        templateVariables: {name: 'Arthur', promoCode: 'ODYSSEY20'},
        fallbackChannels: ['PUSH', 'EMAIL']
    });
    console.log(`  ✔ Omnichannel Notification -> Status: ${notifyRes.notificationPipelineStatus}, Channel: ${notifyRes.channel}`);

    // --- 10. Automated SecOps Remediation ---
    console.log('\n[Demo] 10. Automated SecOps & Infrastructure Incident Remediation...');
    const secopsPipeline = createSecOpsRemediationPipeline();
    const secopsRes = await secopsPipeline.run({
        alertId: 'SEC-CPU-SPIKE-99',
        clusterName: 'prod-us-east-k8s',
        nodeId: 'worker-node-14a',
        podId: 'crypto-miner-rogue-7df9',
        anomalyMetric: 'cpu_usage_core',
        metricValue: 7.9,
        threshold: 4.0,
        severity: 'CRITICAL',
        maintenanceWindowActive: false
    });
    console.log(`  ✔ SecOps Remediation -> Status: ${secopsRes.secopsPipelineStatus}, Ticket: ${secopsRes.incidentTicket()}, Node Quarantined: ${secopsRes.quarantinedNode}`);

    // ========================================================================
    //   Phase 2: Core Workflow Power Use Cases
    // ========================================================================

    // --- 11. Multi-Service Travel Booking Saga with LIFO Compensations ---
    console.log('\n[Demo] 11. Multi-Service Travel Booking Saga with LIFO Compensations...');
    const travelAudit = {actions: [], compensations: []};
    const travelSaga = createTravelBookingSagaPipeline(travelAudit);
    const travelRes = await travelSaga.run({
        bookingId: 'BK-DEMO-2026',
        passengerName: 'Grace Hopper',
        flightNumber: 'UA-101',
        hotelName: 'Ritz-Carlton',
        shouldFailPayment: false
    });
    console.log(`  ✔ Travel Saga -> Status: ${travelRes.sagaStatus}, Vouchers: ${travelRes.vouchersIssued}, Total: $${travelRes.totalAmount()}`);

    // --- 12. High-Throughput Batch Processing with Bounded Worker Pool ---
    console.log('\n[Demo] 12. Document Batch Processing with Bounded Worker Pool (concurrency: 3)...');
    const batchTracker = {current: 0, peak: 0, processedIds: []};
    const batchPipeline = createBoundedBatchIngestionPipeline(batchTracker);
    const batchRes = await batchPipeline.run({
        batchId: 'BATCH-AI-900',
        department: 'Engineering',
        documents: [
            {docId: 'DOC-1', title: 'Architecture RFC', category: 'RFC', content: 'Modern orchestrators...'},
            {docId: 'DOC-2', title: 'Security Standard', category: 'Sec', content: 'Zero trust auth...'},
            {docId: 'DOC-3', title: 'Database Scalability', category: 'DB', content: 'Distributed sharding...'},
            {docId: 'DOC-4', title: 'Observability Guide', category: 'SRE', content: 'OpenTelemetry traces...'}
        ]
    });
    console.log(`  ✔ Batch Mapping -> Status: ${batchRes.pipelineStatus}, Total Indexed: ${batchRes.totalIndexed}, Peak Concurrency: ${batchTracker.peak}`);

    // --- 13. Latency-Optimized Multi-Cloud Storage Race & Parallel Replication ---
    console.log('\n[Demo] 13. Latency-Optimized Multi-Cloud Storage Race & Parallel Replication...');
    const multiCloudPipeline = createMultiCloudReplicationPipeline();
    const cloudRes = await multiCloudPipeline.run({
        assetId: 'MEDIA-DEMO-99',
        fileName: 'keynote.mp4',
        byteSize: 52428800,
        mimeType: 'video/mp4'
    });
    console.log(`  ✔ Multi-Cloud Race & Sync -> Status: ${cloudRes.pipelineStatus}, Edge: ${cloudRes.selectedEdge()}, Replicas: AWS, GCP, Azure`);

    // --- 14. Dynamic Loan Underwriting Engine with Multi-Path Routing ---
    console.log('\n[Demo] 14. Dynamic Loan Underwriting Engine with Multi-Path Routing...');
    const loanPipeline = createLoanUnderwritingPipeline();
    const loanRes = await loanPipeline.run({
        applicationId: 'LOAN-APP-88',
        applicantName: 'Evelyn Boyd Granville',
        creditScore: 790,
        annualIncome: 140000,
        requestedAmount: 30000,
        hasPartnerPromo: true
    });
    console.log(`  ✔ Loan Underwriting -> Tier: ${loanRes.riskTier()}, Decision: ${loanRes.decision}, Interest Rate: ${loanRes.interestRate}%`);

    // --- 15. Scoped Financial Settlement & Idempotent Claim Locking ---
    console.log('\n[Demo] 15. Scoped Financial Settlement & Idempotent Claim Locking...');
    const {pipeline: settlementPipeline, stats: settlementStats} = createIdempotentSettlementPipeline();
    const settlementInput = {
        transactionId: 'TXN-BANK-CLAIM-7721',
        sourceAccount: 'ACC-CHECKING-1',
        targetAccount: 'ACC-SAVINGS-2',
        amount: 15000,
        currency: 'USD'
    };
    const s1 = await settlementPipeline.run(settlementInput);
    await settlementPipeline.run(settlementInput); // Duplicate delivery
    console.log(`  ✔ Idempotent Settlement -> Status: ${s1.pipelineStatus}, Journal: ${s1.journalRef()}, Executions: ${settlementStats.settlementExecutionCount} (Deduplicated!)`);

    // --- 16. Durable Long-Running Human-in-the-Loop Expense Approval ---
    console.log('\n[Demo] 16. Durable Long-Running Human-in-the-Loop Expense Approval & Resumption...');
    const expenseWorkflow = createDurableExpenseApprovalWorkflow();
    const reportId = 'EXP-CORP-DEMO-1';
    const suspendRes: any = await expenseWorkflow.run({
        reportId,
        employeeEmail: 'ada@lovelace.org',
        expenseCategory: 'CONFERENCE',
        amount: 3500
    }, {durable: true});
    console.log(`  ✔ Expense Suspension -> Status: ${suspendRes.status}, Event: ${suspendRes.eventName}, CorrelationKey: ${suspendRes.correlationKey}`);
    const resumeRes = await expenseWorkflow.resume(reportId, {
        approvedBy: 'cfo@lovelace.org',
        approvedAmount: 3500
    });
    console.log(`  ✔ Expense Resumption -> Status: ${resumeRes.pipelineStatus()}, Approved By: ${resumeRes.approvedBy()}, Disbursed: $${resumeRes.disbursedAmount()}`);

    // --- 17. CI/CD Pipeline Governance with Workflow Graph AST Inspection ---
    console.log('\n[Demo] 17. CI/CD Pipeline Governance with Workflow Graph AST Inspection...');
    const {workflow: govWorkflow, auditWorkflowGovernance} = createGovernedDeploymentPipeline();
    const govAudit = auditWorkflowGovernance();
    const govRes = await govWorkflow.run({
        releaseId: 'REL-2.0.0-PROD',
        commitSha: 'c0ffee123456',
        environment: 'production'
    });
    console.log(`  ✔ Governance Audit -> Compliant: ${govAudit.isCompliant}, Total AST Nodes: ${govAudit.metrics.totalNodes}, Deployed Cluster: ${govRes.activeCluster}`);

    // ========================================================================
    //   Phase 3: Ecosystem, Adapters & Distributed Power Use Cases
    // ========================================================================

    // --- 18. HTTP Checkout & Order Processing Microservice ---
    console.log('\n[Demo] 18. HTTP Checkout & Order Processing Microservice (@siglo/fastify)...');
    const fastifyHandler = createFastifyCheckoutHandler(createHttpCheckoutWorkflow());
    const mockReply = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        payload: null as any,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        header(k: string, v: string) {
            this.headers[k] = v;
            return this;
        },
        send(data: any) {
            this.payload = data;
            return this;
        }
    };
    const httpRes: any = await fastifyHandler({
        body: {
            orderId: 'ORD-HTTP-3001',
            items: [{sku: 'DEV-WORKSTATION', price: 2500, quantity: 1}],
            currency: 'USD'
        },
        headers: {'x-namespace': 'ecom-us-east'}
    } as any, mockReply as any);
    const checkoutData = httpRes || mockReply.payload;
    console.log(`  ✔ HTTP Checkout -> Status: ${checkoutData.status}, Total: $${checkoutData.totalAmount}, Confirmation: ${checkoutData.confirmationCode}`);

    // --- 19. High-Volume Event-Driven Kafka Stream Enrichment ---
    console.log('\n[Demo] 19. High-Volume Event-Driven Kafka Stream Enrichment (@siglo/kafka)...');
    const kafkaConsumer = createKafkaTransactionConsumer();
    const kafkaRes: any = await kafkaConsumer({
        topic: 'payments.stream',
        partition: 0,
        message: {
            key: Buffer.from('TXN-KAFKA-LIVE'),
            value: Buffer.from(JSON.stringify({
                transactionId: 'TXN-KAFKA-LIVE',
                accountId: 'VIP-TRADER-9',
                amount: 8500,
                currency: 'USD'
            })),
            headers: {'x-namespace': Buffer.from('fintech-global')},
            offset: '50291'
        }
    } as any);
    console.log(`  ✔ Kafka Stream -> Status: ${kafkaRes.status}, Tier: ${kafkaRes.enriched.accountTier}, Flagged: ${kafkaRes.enriched.isFlagged}, Risk Score: ${kafkaRes.enriched.riskScore}`);

    // --- 20. Resilient Asynchronous Queue Worker & Dead-Letter Handling ---
    console.log('\n[Demo] 20. Resilient Asynchronous Queue Worker (@siglo/bullmq)...');
    const bullMqWorker = createBullMqImageProcessor();
    let currentProgress = 0;
    const bullRes: any = await bullMqWorker({
        id: 'job-image-transcode-42',
        data: {
            jobId: 'IMG-BANNER-4K',
            imageUrl: 'https://cdn.siglo.io/assets/raw-banner.png',
            targetWidth: 3840,
            targetHeight: 2160,
            format: 'webp',
            namespace: 'marketing-portal'
        },
        updateProgress: async (p: number) => {
            currentProgress = p;
        }
    });
    console.log(`  ✔ BullMQ Worker -> Job ID: ${bullRes.jobId}, Compression Ratio: ${bullRes.compressionRatio}, Progress: ${currentProgress}%`);

    // --- 21. Distributed Tracing & W3C Trace Context Propagation ---
    console.log('\n[Demo] 21. Distributed Tracing & W3C Trace Context Propagation (@siglo/opentelemetry)...');
    const tracer = new MockTracer();
    const {instrumented} = setupInstrumentedWorkflow(tracer, {allowNamespace: true});
    const otelRes = await instrumented.run({
        orderId: 'ORD-OTEL-8899',
        itemsCount: 2,
        customerTier: 'ENTERPRISE',
        apiKeySecret: 'secret_live_token',
        billingAddress: 'Silicon Valley Blvd'
    }, {namespace: 'enterprise-tenant-alpha'});
    console.log(`  ✔ OpenTelemetry -> Status: ${otelRes.dispatchStatus}, Spans Recorded: ${tracer.spans.length}, Tracking: ${otelRes.trackingNumber}`);

    // --- 22. Multi-Tenant SaaS Billing & Audit Ledger ---
    console.log('\n[Demo] 22. Multi-Tenant SaaS Billing & Audit Ledger (@siglo/postgres & @siglo/redis)...');
    const pgClient = new MockPostgresClient();
    const redisClient = new MockRedisClient();
    const {workflow: billingWf} = setupSaaSBillingInfrastructure(pgClient, redisClient);
    const billingRes = await billingWf.run({
        billingPeriod: '2026-Q1',
        organizationId: 'ORG-ACME-CORP',
        apiRequests: 250000,
        computeMinutes: 600,
        storageGigabytes: 200
    }, {namespace: 'enterprise-acme', stackId: 'stack-acme-q1'});
    console.log(`  ✔ SaaS Billing -> Invoice: ${billingRes.invoiceId}, Total: $${billingRes.totalAmount}, Discount: $${billingRes.discount}, Status: ${billingRes.status}`);

    // --- Verification of Redis & MongoDB State ---
    console.log("\n------------------------------------------------------------------------");
    console.log("[Verification] Checking Storage Adapter State:");
    const mongoLogs = await mongo.collection("siglo_execution_logs").find();
    console.log(`  • MongoDB Execution Logs: ${mongoLogs.length} step context entries logged with stackId & namespace tracing`);
    console.log("\n[Demo] All 22 use cases executed and streamed to storage adapter successfully!");
    console.log('========================================================================\n');
}

main().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
});
