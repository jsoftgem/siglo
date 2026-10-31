import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createTravelBookingSagaPipeline,
    createBoundedBatchIngestionPipeline,
    createMultiCloudReplicationPipeline,
    createLoanUnderwritingPipeline,
    createIdempotentSettlementPipeline,
    createDurableExpenseApprovalWorkflow,
    createGovernedDeploymentPipeline
} from './workflow/usecases';

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
