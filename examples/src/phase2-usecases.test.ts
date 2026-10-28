import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedisClient } from './database/redis';
import { createMongoClient } from './database/mongodb';
import { registerRedisMongoStorage } from './plugin/redis-mongo-storage';
import {
    createTravelBookingSagaPipeline,
    createBoundedBatchIngestionPipeline,
    createMultiCloudReplicationPipeline,
    createLoanUnderwritingPipeline,
    createIdempotentSettlementPipeline,
    createDurableExpenseApprovalWorkflow,
    createGovernedDeploymentPipeline
} from './workflow/phase2';
import {
    Step,
    flow,
    CompensationException
} from 'rivulet';

test('Phase 2 Workflow Power Integration Test Suite', async (t) => {
    // 0. Initialize storage adapters and register plugins
    const redis = createRedisClient();
    const mongo = createMongoClient();
    registerRedisMongoStorage(redis, mongo);

    await t.test('Use Case 11: Multi-Service Travel Booking Saga with LIFO Compensations', async (st) => {
        await st.test('Successful forward execution without rollback', async () => {
            const audit = { actions: [], compensations: [] };
            const saga = createTravelBookingSagaPipeline(audit);

            const result = await saga.run({
                bookingId: 'BK-1001',
                passengerName: 'Ada Lovelace',
                flightNumber: 'BA-249',
                hotelName: 'The Savoy London',
                shouldFailPayment: false
            });

            assert.equal(result.sagaStatus(), 'COMPLETED');
            assert.equal(result.vouchersIssued(), true);
            assert.equal(result.totalAmount(), 800);
            assert.equal(audit.compensations.length, 0);
            assert.equal(audit.actions.length, 4);
        });

        await st.test('Failure triggering automatic reverse LIFO rollback', async () => {
            const audit = { actions: [], compensations: [] };
            const saga = createTravelBookingSagaPipeline(audit);

            try {
                await saga.run({
                    bookingId: 'BK-1002',
                    passengerName: 'Charles Babbage',
                    flightNumber: 'LH-404',
                    hotelName: 'Grand Hotel Berlin',
                    shouldFailPayment: true
                });
                assert.fail('Should have thrown payment error');
            } catch (err: any) {
                // Original failure is preserved and propagated
                assert.ok(err.message.includes('Payment gateway declined transaction'));

                // Verify LIFO order: Hotel was reserved second, so it must be cancelled FIRST
                assert.equal(audit.compensations.length, 2);
                assert.equal(audit.compensations[0], 'Cancelled Hotel: HOTEL-BK-1002-ROOM');
                assert.equal(audit.compensations[1], 'Cancelled Flight: TKT-BK-1002-FLIGHT');
            }
        });

        await st.test('Compensation failure raises CompensationException with diagnostics', async () => {
            const failingHotelSaga = flow(
                Step.create('stepA', async () => ({ stepA: true })).compensate(async () => {
                    throw new Error('Hotel cancellation network timeout');
                }),
                Step.create('stepB', async () => {
                    throw new Error('Primary booking failed');
                })
            );

            try {
                await failingHotelSaga.run();
                assert.fail('Should have thrown CompensationException');
            } catch (err: any) {
                assert.ok(err instanceof CompensationException);
                assert.ok(err.compensationErrors.length > 0);
                assert.equal(err.compensationErrors[0].stepName, 'stepA');
                assert.ok(err.originalError.message.includes('Primary booking failed'));
            }
        });
    });

    await t.test('Use Case 12: High-Throughput Document Batch Processing with Bounded Worker Pool', async () => {
        const tracker = { current: 0, peak: 0, processedIds: [] };
        const pipeline = createBoundedBatchIngestionPipeline(tracker);

        const documents = Array.from({ length: 9 }, (_, i) => ({
            docId: `DOC-BATCH-${i + 1}`,
            title: `Chapter ${i + 1}: Microservices & Event Orchestration`,
            category: 'Architecture',
            content: 'Detailed discussion on distributed systems and saga patterns.'
        }));

        const result = await pipeline.run({
            batchId: 'BATCH-2026-X',
            department: 'AI Research',
            documents
        });

        assert.equal(result.pipelineStatus(), 'COMPLETED');
        assert.equal(result.totalIndexed(), 9);
        assert.ok(result.totalTokens() > 0);
        // Concurrency must have been bounded to max 3
        assert.ok(tracker.peak <= 3, `Peak concurrency was ${tracker.peak}, expected <= 3`);
        assert.equal(tracker.processedIds.length, 9);
    });

    await t.test('Use Case 13: Latency-Optimized Multi-Cloud Storage Race & Parallel Replication', async () => {
        const pipeline = createMultiCloudReplicationPipeline();

        const result = await pipeline.run({
            assetId: 'ASSET-GLOBAL-42',
            fileName: 'quarterly-keynote.mp4',
            byteSize: 104857600,
            mimeType: 'video/mp4'
        });

        assert.equal(result.pipelineStatus(), 'REPLICATED');
        assert.equal(result.selectedEdge(), 'US_EAST_EDGE');

        // Verify deep merged replica receipts from all 3 parallel branches
        const replicas = result.replicas();
        assert.ok(replicas.aws);
        assert.equal(replicas.aws.status, 'SYNCED');
        assert.ok(replicas.gcp);
        assert.equal(replicas.gcp.status, 'SYNCED');
        assert.ok(replicas.azure);
        assert.equal(replicas.azure.status, 'SYNCED');
    });

    await t.test('Use Case 14: Dynamic Loan Underwriting Engine with Multi-Path Routing', async (st) => {
        const pipeline = createLoanUnderwritingPipeline();

        await st.test('Prime applicant with partner promo gets promo rate', async () => {
            const result = await pipeline.run({
                applicationId: 'LOAN-PRIME-1',
                applicantName: 'Katherine Johnson',
                creditScore: 800,
                annualIncome: 150000,
                requestedAmount: 25000,
                hasPartnerPromo: true
            });

            assert.equal(result.riskTier(), 'PRIME');
            assert.equal(result.decision(), 'APPROVED_INSTANT');
            assert.equal(result.interestRate(), 4.25);
            assert.equal(result.stipulationsRequired(), false);
        });

        await st.test('Prime applicant without promo gets standard rate', async () => {
            const result = await pipeline.run({
                applicationId: 'LOAN-PRIME-2',
                applicantName: 'Dorothy Vaughan',
                creditScore: 780,
                annualIncome: 120000,
                requestedAmount: 20000,
                hasPartnerPromo: false
            });

            assert.equal(result.riskTier(), 'PRIME');
            assert.equal(result.decision(), 'APPROVED_INSTANT');
            assert.equal(result.interestRate(), 4.85);
        });

        await st.test('Near-prime applicant routed to conditional approval', async () => {
            const result = await pipeline.run({
                applicationId: 'LOAN-NEAR-1',
                applicantName: 'Mary Jackson',
                creditScore: 690,
                annualIncome: 80000,
                requestedAmount: 15000
            });

            assert.equal(result.riskTier(), 'NEAR_PRIME');
            assert.equal(result.decision(), 'APPROVED_WITH_CONDITIONS');
            assert.equal(result.stipulationsRequired(), true);
        });

        await st.test('Subprime applicant routed to automated decline', async () => {
            const result = await pipeline.run({
                applicationId: 'LOAN-SUB-1',
                applicantName: 'Test Applicant',
                creditScore: 580,
                annualIncome: 45000,
                requestedAmount: 10000
            });

            assert.equal(result.riskTier(), 'SUBPRIME');
            assert.equal(result.decision(), 'DECLINED');
        });
    });

    await t.test('Use Case 15: Scoped Financial Settlement & Idempotent Claim Locking', async () => {
        const { pipeline, stats } = createIdempotentSettlementPipeline();

        const input = {
            transactionId: 'TXN-BANK-SECURE-8821',
            sourceAccount: 'ACC-DEPOSIT-100',
            targetAccount: 'ACC-INVESTMENT-200',
            amount: 50000,
            currency: 'USD'
        };

        // First execution -> Executes sensitive settlement logic
        const firstResult = await pipeline.run(input);
        assert.equal(firstResult.pipelineStatus(), 'SETTLED');
        assert.equal(firstResult.amount(), 50000);
        assert.equal(stats.settlementExecutionCount, 1);
        const originalJournal = firstResult.journalRef();

        // Duplicate second execution with identical transactionId -> Returns memoized claim result
        const secondResult = await pipeline.run(input);
        assert.equal(secondResult.pipelineStatus(), 'SETTLED');
        assert.equal(secondResult.amount(), 50000);
        assert.equal(secondResult.journalRef(), originalJournal);
        // Sensitive ledger logic was NOT executed a second time!
        assert.equal(stats.settlementExecutionCount, 1, 'Critical settlement logic must not execute twice');
    });

    await t.test('Use Case 16: Durable Long-Running Human-in-the-Loop Expense Approval & Webhook Resumption', async (st) => {
        const workflow = createDurableExpenseApprovalWorkflow();
        const reportId = 'EXP-CORP-9481';

        await st.test('Non-durable execution passes through wait step as fallback', async () => {
            const fallbackResult = await workflow.run({
                reportId: 'EXP-TRANSIENT-1',
                employeeEmail: 'user@corp.com',
                expenseCategory: 'TRAVEL',
                amount: 500
            });
            assert.equal(fallbackResult.pipelineStatus(), 'REIMBURSED');
            assert.equal(fallbackResult.reportId(), 'EXP-TRANSIENT-1');
        });

        await st.test('Durable execution captures suspension and safely resumes with version migration', async () => {
            // 1. Worker A: Run until durable suspension
            const suspendedResult = await workflow.run({
                reportId,
                employeeEmail: 'margaret.hamilton@apollo.nasa',
                expenseCategory: 'LAB_EQUIPMENT',
                amount: 4200
            }, { durable: true });

            assert.equal(suspendedResult.status, 'waiting');
            assert.equal(suspendedResult.eventName, 'expense.decision');
            assert.equal(suspendedResult.correlationKey, reportId);

            // 2. Worker B: Resume with manager webhook approval payload and state migration
            const resumedResult = await workflow.resume(reportId, {
                approvedBy: 'flight.director@nasa.gov',
                approvedAmount: 4200
            }, {
                migrations: {
                    'v1.0.0': (oldState: any) => ({
                        ...oldState,
                        policyV2Applied: true
                    })
                }
            });

            assert.equal(resumedResult.pipelineStatus(), 'REIMBURSED');
            assert.equal(resumedResult.reportId(), reportId);
            assert.equal(resumedResult.approvedBy(), 'flight.director@nasa.gov');
            assert.equal(resumedResult.disbursedAmount(), 4200);
        });
    });

    await t.test('Use Case 17: CI/CD Pipeline Governance with Workflow Graph AST Inspection', async () => {
        const { workflow, auditWorkflowGovernance } = createGovernedDeploymentPipeline();

        // 1. Pre-execution static audit & policy verification
        const audit = auditWorkflowGovernance();
        assert.equal(audit.isCompliant, true);
        assert.equal(audit.validation.valid, true);
        assert.ok(audit.metrics.totalNodes >= 4);
        assert.ok(audit.metrics.nodes.some(n => n.name === 'runSecurityScan'));

        // 2. Safe execution of compliant workflow
        const result = await workflow.run({
            releaseId: 'REL-2.0.0-PROD',
            commitSha: 'a1b2c3d4e5f6',
            environment: 'production'
        });

        assert.equal(result.deploymentStatus(), 'DEPLOYED');
        assert.equal(result.releaseId(), 'REL-2.0.0-PROD');
        assert.equal(result.activeCluster(), 'k8s-production-cluster-1');
    });
});
