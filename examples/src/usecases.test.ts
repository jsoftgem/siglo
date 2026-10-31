import test from 'node:test';
import assert from 'node:assert/strict';
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
