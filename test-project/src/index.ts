import { createRedisClient } from './database/redis';
import { createMongoClient } from './database/mongodb';
import { registerRedisMongoStorage } from './plugin/redis-mongo-storage';
import { createOrderPipeline, OrderInput } from './workflow/order-pipeline';
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
    createSecOpsRemediationPipeline
} from './workflow/usecases';

async function main() {
    console.log('========================================================================');
    console.log('   fluid-func: Top 10 Event-Driven Use Cases & Storage Plugins Demo');
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
        customer: { name: 'Sarah Connor', email: 'sarah.connor@example.com' },
        items: [
            { id: 'item_1', name: 'Mechanical Keyboard', price: 80, quantity: 1 },
            { id: 'item_2', name: 'USB-C Cable', price: 15, quantity: 2 }
        ],
        couponCode: 'SAVE10'
    };
    const orderResult = await orderPipeline.run(orderInput);
    console.log(`  ✔ Base Order Pipeline -> Invoice ID: ${orderResult.invoiceId()}, Total: $${orderResult.amountCharged()}`);

    // --- 1. E-Commerce Saga ---
    console.log('\n[Demo] 1. E-Commerce Distributed Checkout & Saga Orchestration...');
    const saga = createEcommerceSagaPipeline();
    const sagaRes = await saga.run({
        orderId: 'ORD-SAGA-991',
        customerId: 'CUST-402',
        cartItems: [
            { sku: 'SKU-LAPTOP', name: 'Dev Laptop', price: 1200, quantity: 1 },
            { sku: 'SKU-MOUSE', name: 'Wireless Mouse', price: 50, quantity: 2 }
        ],
        paymentDetails: { cardNumber: '4111-XXXX-XXXX-1111', amount: 1300 },
        shippingAddress: { street: '100 Infinite Loop', city: 'Cupertino', zip: '95014' }
    });
    console.log(`  ✔ E-Commerce Saga -> Status: ${sagaRes.sagaStatus()}, Tracking: ${sagaRes.trackingNumber()}, Payment: ${sagaRes.paymentStatus()}`);

    // --- 2. AI RAG Pipeline ---
    console.log('\n[Demo] 2. Multi-Stage AI / LLM & RAG Ingestion Pipeline...');
    const { pipeline: ragPipeline } = createAiRagPipeline();
    const ragRes = await ragPipeline.run({
        documentId: 'DOC-RAG-882',
        sourceUri: 's3://company-docs/architecture-overview.pdf',
        mimeType: 'application/pdf',
        rawText: 'Fluid-func provides discrete step execution, deterministic caching, and pluggable storage hooks. ' +
                 'Combined with Apache Kafka, teams can build fault-tolerant, event-driven pipelines across distributed clusters.'
    });
    console.log(`  ✔ AI / RAG Pipeline -> Status: ${ragRes.ragPipelineStatus()}, Vectors Indexed: ${ragRes.indexedVectors()}`);

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
    console.log(`  ✔ Financial Pipeline -> Status: ${finRes.finStatus()}, Journal: ${finRes.journalId()}, Risk Score: ${finRes.riskScore()}`);

    // --- 4. Asynchronous Media Transcoding ---
    console.log('\n[Demo] 4. Asynchronous Media Transcoding & Asset Processing...');
    const mediaPipeline = createMediaTranscodingPipeline();
    const mediaRes = await mediaPipeline.run({
        assetId: 'VID-ASSET-773',
        sourceS3Url: 's3://raw-video-bucket/uploads/product-demo.mp4',
        targetResolutions: ['1080p', '720p', '480p'],
        uploadedBy: 'usr_creative_director'
    });
    console.log(`  ✔ Media Transcoding -> Status: ${mediaRes.mediaPipelineStatus()}, Manifest: ${mediaRes.masterManifestUrl()}`);

    // --- 5. IoT Telemetry & Anomaly Detection ---
    console.log('\n[Demo] 5. High-Throughput IoT Telemetry & Anomaly Detection...');
    const iotPipeline = createIotTelemetryPipeline();
    const iotRes = await iotPipeline.run({
        deviceId: 'TURBINE-EDGE-04',
        fleetId: 'WIND-FARM-NORTH',
        batchSequence: 1042,
        readings: [
            { sensorId: 'TEMP-01', temperatureFahrenheit: 195.0, pressurePsi: 80.0, vibrationG: 1.2, recordedAt: Date.now() },
            { sensorId: 'TEMP-02', temperatureFahrenheit: 190.0, pressurePsi: 82.0, vibrationG: 1.1, recordedAt: Date.now() }
        ]
    });
    console.log(`  ✔ IoT Telemetry -> Status: ${iotRes.iotPipelineStatus()}, Anomaly: ${iotRes.anomalyDetected()}, Dispatched Alert: ${iotRes.alertDispatched()}`);

    // --- 6. CDC & Data Lakehouse ETL ---
    console.log('\n[Demo] 6. CDC (Change Data Capture) & Data Lakehouse ETL...');
    const cdcPipeline = createCdcLakehousePipeline();
    const cdcRes = await cdcPipeline.run({
        op: 'c',
        source: { db: 'production_store', table: 'tbl_users', lsn: 94827104, ts_ms: Date.now() },
        before: null,
        after: { usr_id_pk: 'U9921', usr_email_addr: 'ada.lovelace@pioneer.org', first_nm: 'Ada', last_nm: 'Lovelace', acct_bal_amt: '7500.00' }
    });
    console.log(`  ✔ CDC Lakehouse -> Status: ${cdcRes.cdcPipelineStatus()}, Partition: ${cdcRes.partitionPath()}`);

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
    console.log(`  ✔ KYC Onboarding -> Status: ${kycRes.kycPipelineStatus()}, Account: ${kycRes.customerAccountNumber()}`);

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
            code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart Rate' }] },
            subject: { reference: 'Patient/1029', patientSsn: '000-12-3456', patientName: 'Grace Hopper' },
            effectiveDateTime: new Date().toISOString(),
            valueQuantity: { value: 145, unit: 'beats/minute', system: 'http://unitsofmeasure.org' }
        }
    });
    console.log(`  ✔ Healthcare FHIR -> Status: ${fhirRes.healthcarePipelineStatus()}, Alert: ${fhirRes.alertLevel()}, Patient: ${fhirRes.pseudonymousPatientId()}`);

    // --- 9. Omnichannel Notifications ---
    console.log('\n[Demo] 9. Multi-Channel Notification & Marketing Campaign Dispatch...');
    const notifyPipeline = createOmnichannelNotificationPipeline();
    const notifyRes = await notifyPipeline.run({
        campaignId: 'CAMP-SPRING-2026',
        userId: 'USR-8821',
        recipientEmail: 'clarke@author.org',
        recipientPhone: '+1-555-0199',
        templateKey: 'PROMO_FLASH_SALE',
        templateVariables: { name: 'Arthur', promoCode: 'ODYSSEY20' },
        fallbackChannels: ['PUSH', 'EMAIL']
    });
    console.log(`  ✔ Omnichannel Notification -> Status: ${notifyRes.notificationPipelineStatus()}, Channel: ${notifyRes.channel()}`);

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
    console.log(`  ✔ SecOps Remediation -> Status: ${secopsRes.secopsPipelineStatus()}, Ticket: ${secopsRes.incidentTicket()}, Node Quarantined: ${secopsRes.quarantinedNode()}`);

    // --- Verification of Redis & MongoDB State ---
    console.log("\n------------------------------------------------------------------------");
    console.log("[Verification] Checking Storage Adapter State:");
    const mongoLogs = await mongo.collection("fluid_execution_logs").find();
    console.log(`  • MongoDB Execution Logs: ${mongoLogs.length} step context entries logged with stackId & tenant tracing`);
    console.log("\n[Demo] All 10 use cases executed and streamed to storage adapter successfully!");
    console.log('========================================================================\n');
}

main().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
});
