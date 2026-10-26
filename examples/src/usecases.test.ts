import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedisClient } from './database/redis';
import { createMongoClient } from './database/mongodb';
import { registerRedisMongoStorage } from './plugin/redis-mongo-storage';
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

test('Top 10 Event-Driven Use Cases Integration Test Suite', async (t) => {
    // 0. Initialize storage adapters and register plugins
    const redis = createRedisClient();
    const mongo = createMongoClient();
    registerRedisMongoStorage(redis, mongo);

    await t.test('Use Case 1: E-Commerce Distributed Checkout & Saga Orchestration', async () => {
        const pipeline = createEcommerceSagaPipeline();

        const input = {
            orderId: 'ORD-SAGA-991',
            customerId: 'CUST-402',
            cartItems: [
                { sku: 'SKU-LAPTOP', name: 'Dev Laptop', price: 1200, quantity: 1 },
                { sku: 'SKU-MOUSE', name: 'Wireless Mouse', price: 50, quantity: 2 }
            ],
            paymentDetails: {
                cardNumber: '4111-XXXX-XXXX-1111',
                amount: 1300
            },
            shippingAddress: {
                street: '100 Infinite Loop',
                city: 'Cupertino',
                zip: '95014'
            }
        };

        const result = await pipeline.run(input);

        assert.equal(result.cartValid(), true);
        assert.equal(result.totalAmount(), 1300);
        assert.equal(result.inventoryReserved(), true);
        assert.equal(result.paymentStatus(), 'CAPTURED');
        assert.equal(result.shipmentCreated(), true);
        assert.equal(result.destinationCity(), 'Cupertino');
        assert.equal(result.confirmationEmailSent(), true);
        assert.equal(result.sagaStatus(), 'COMPLETED');
    });

    await t.test('Use Case 2: Multi-Stage AI / LLM & RAG Ingestion Pipeline', async () => {
        const { pipeline, getEmbeddingCallCount } = createAiRagPipeline();

        const input = {
            documentId: 'DOC-RAG-882',
            sourceUri: 's3://company-docs/architecture-overview.pdf',
            mimeType: 'application/pdf',
            rawText: 'Fluid-func provides discrete step execution, deterministic caching, and pluggable storage hooks. ' +
                     'Combined with Apache Kafka, teams can build fault-tolerant, event-driven pipelines across distributed clusters.'
        };

        const result = await pipeline.run(input);

        assert.equal(result.documentId(), 'DOC-RAG-882');
        assert.equal(result.extractionStatus(), 'SUCCESS');
        assert.ok(result.chunkCount() > 0);
        assert.ok(result.indexedVectors() > 0);
        assert.equal(result.ragPipelineStatus(), 'INDEXED');
        assert.equal(getEmbeddingCallCount(), 1);
    });

    await t.test('Use Case 3: Financial Transaction Processing & Fraud Detection', async () => {
        const pipeline = createFinancialFraudPipeline();

        const input = {
            transactionId: 'TXN-FIN-501',
            sourceAccountId: 'ACCT-USER-100',
            destinationAccountId: 'ACCT-USER-200',
            amount: 2500,
            currency: 'USD',
            clientIp: '192.168.1.50',
            timestamp: Date.now()
        };

        const result = await pipeline.run(input);

        assert.equal(result.idempotencyVerified(), true);
        assert.equal(result.kycVerified(), true);
        assert.equal(result.fraudCheckPassed(), true);
        assert.equal(result.fraudAssessment(), 'LOW_RISK');
        assert.equal(result.ledgerStatus(), 'POSTED');
        assert.equal(result.auditLogged(), true);
        assert.equal(result.finStatus(), 'COMPLETED');
    });

    await t.test('Use Case 4: Asynchronous Media Transcoding & Asset Processing', async () => {
        const pipeline = createMediaTranscodingPipeline();

        const input = {
            assetId: 'VID-ASSET-773',
            sourceS3Url: 's3://raw-video-bucket/uploads/product-demo.mp4',
            targetResolutions: ['1080p', '720p', '480p'] as const,
            uploadedBy: 'usr_creative_director'
        };

        const result = await pipeline.run(input);

        assert.equal(result.uploadReceived(), true);
        assert.equal(result.metadataExtracted(), true);
        assert.equal(result.codec(), 'h264');
        assert.equal(result.variantCount(), 3);
        assert.equal(result.thumbnailsGenerated(), true);
        assert.equal(result.mediaPipelineStatus(), 'READY_TO_STREAM');
        assert.equal(result.cdnPurgedAndWarm(), true);
    });

    await t.test('Use Case 5: High-Throughput IoT Telemetry & Anomaly Detection', async () => {
        const pipeline = createIotTelemetryPipeline();

        const input = {
            deviceId: 'TURBINE-EDGE-04',
            fleetId: 'WIND-FARM-NORTH',
            batchSequence: 1042,
            readings: [
                {
                    sensorId: 'TEMP-01',
                    temperatureFahrenheit: 195.0, // ~90.56 C (Overheating anomaly > 80C)
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
        };

        const result = await pipeline.run(input);

        assert.equal(result.batchAccepted(), true);
        assert.equal(result.sampleCount(), 2);
        assert.ok(result.metrics().avgTempCelsius > 80.0);
        assert.equal(result.anomalyDetected(), true);
        assert.equal(result.alertDispatched(), true);
        assert.equal(result.iotPipelineStatus(), 'PROCESSED');
    });

    await t.test('Use Case 6: CDC (Change Data Capture) & Data Lakehouse ETL', async () => {
        const pipeline = createCdcLakehousePipeline();

        const input = {
            op: 'c' as const,
            source: {
                db: 'production_store',
                table: 'tbl_users',
                lsn: 94827104,
                ts_ms: Date.now()
            },
            before: null,
            after: {
                usr_id_pk: 'U9921',
                usr_email_addr: 'ada.lovelace@pioneer.org',
                first_nm: 'Ada',
                last_nm: 'Lovelace',
                acct_bal_amt: '7500.00'
            }
        };

        const result = await pipeline.run(input);

        assert.equal(result.cdcCaptured(), true);
        assert.equal(result.operation(), 'INSERT');
        assert.equal(result.transformedRow().firstName, 'Ada');
        assert.equal(result.transformedRow().accountBalance, 7500);
        assert.equal(result.enrichedRow().customerTier, 'GOLD');
        assert.equal(result.isDuplicate(), false);
        assert.equal(result.cdcPipelineStatus(), 'COMMITTED');
    });

    await t.test('Use Case 7: Customer Onboarding & Identity Verification (KYC/AML)', async () => {
        const pipeline = createKycOnboardingPipeline();

        const input = {
            applicantId: 'APP-9982-KYC',
            fullName: 'Alan Turing',
            country: 'UK',
            idType: 'PASSPORT' as const,
            documentNumber: 'GBR-88392019',
            documentBase64: 'data:image/jpeg;base64,sampledoc...',
            selfieBase64: 'data:image/jpeg;base64,sampleselfie...'
        };

        const result = await pipeline.run(input);

        assert.equal(result.applicationReceived(), true);
        assert.equal(result.ocrSuccess(), true);
        assert.equal(result.biometricsVerified(), true);
        assert.ok(result.matchConfidence() >= 0.90);
        assert.equal(result.sanctionsScreeningPassed(), true);
        assert.equal(result.accountStatus(), 'ACTIVE');
        assert.equal(result.kycPipelineStatus(), 'APPROVED');
    });

    await t.test('Use Case 8: Healthcare HL7 / FHIR Clinical Event Integration', async () => {
        const pipeline = createHealthcareFhirPipeline();

        const input = {
            feedId: 'HL7-FEED-ICU-03',
            hospitalUnit: 'Cardiology-ICU',
            traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
            observation: {
                resourceType: 'Observation' as const,
                id: 'obs-heart-rate-99',
                status: 'final' as const,
                code: {
                    coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart Rate' }]
                },
                subject: {
                    reference: 'Patient/1029',
                    patientSsn: '000-12-3456',
                    patientName: 'Grace Hopper'
                },
                effectiveDateTime: new Date().toISOString(),
                valueQuantity: {
                    value: 145, // abnormal high heart rate tachycardia > 130 bpm
                    unit: 'beats/minute',
                    system: 'http://unitsofmeasure.org'
                }
            }
        };

        const result = await pipeline.run(input);

        assert.equal(result.feedAccepted(), true);
        assert.equal(result.fhirValid(), true);
        assert.equal(result.hipaaCompliant(), true);
        assert.equal(result.pseudonymousPatientId(), 'HASH-PAT-3456');
        assert.equal(result.ehrUpdated(), true);
        assert.equal(result.alertTriggered(), true);
        assert.equal(result.alertLevel(), 'STAT_EMERGENCY');
        assert.equal(result.healthcarePipelineStatus(), 'SYNCHRONIZED');
    });

    await t.test('Use Case 9: Multi-Channel Notification & Marketing Campaign Dispatch', async () => {
        const pipeline = createOmnichannelNotificationPipeline();

        const input = {
            campaignId: 'CAMP-SPRING-2026',
            userId: 'USR-8821',
            recipientEmail: 'clarke@author.org',
            recipientPhone: '+1-555-0199',
            templateKey: 'PROMO_FLASH_SALE',
            templateVariables: {
                name: 'Arthur',
                promoCode: 'ODYSSEY20'
            },
            fallbackChannels: ['PUSH', 'EMAIL'] as const
        };

        const result = await pipeline.run(input);

        assert.equal(result.campaignTriggered(), true);
        assert.equal(result.optedIn(), true);
        assert.ok(result.renderedBody().includes('ODYSSEY20'));
        assert.equal(result.deliveryStatus(), 'SENT');
        assert.equal(result.notificationPipelineStatus(), 'DELIVERED');
    });

    await t.test('Use Case 10: Automated SecOps & Infrastructure Incident Remediation', async () => {
        const pipeline = createSecOpsRemediationPipeline();

        const input = {
            alertId: 'SEC-CPU-SPIKE-99',
            clusterName: 'prod-us-east-k8s',
            nodeId: 'worker-node-14a',
            podId: 'crypto-miner-rogue-7df9',
            anomalyMetric: 'cpu_usage_core',
            metricValue: 7.9,
            threshold: 4.0,
            severity: 'CRITICAL' as const,
            maintenanceWindowActive: false
        };

        const result = await pipeline.run(input);

        assert.equal(result.incidentRegistered(), true);
        assert.equal(result.rootCauseIdentified(), true);
        assert.equal(result.remediationExecuted(), true);
        assert.equal(result.quarantinedNode(), 'worker-node-14a');
        assert.equal(result.clusterHealthy(), true);
        assert.equal(result.slackDispatched(), true);
        assert.equal(result.secopsPipelineStatus(), 'RESOLVED');
    });

    // Final verification: inspect MongoDB execution logs for recorded context telemetry
    const logs = await mongo.collection("fluid_execution_logs").find();
    assert.ok(logs.length >= 30, "Execution logs should be recorded for all use cases");
    assert.ok(logs.every(l => typeof l.stackId === "string" && l.stackId.length > 0), "Every log must have a valid string stackId");
});
