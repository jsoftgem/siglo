import { Step, flow, waitForEvent } from '@siglo/core';

export interface ExpenseReportInput {
    reportId: string;
    employeeEmail: string;
    expenseCategory: string;
    amount: number;
}

/**
 * Use Case 16: Durable Long-Running Human-in-the-Loop Expense Approval & Webhook Resumption
 * Features demonstrated:
 * - waitForEvent('expense.decision', { correlationKey, timeout })
 * - Durable checkpoint suspension and WorkflowSuspendedException
 * - flow.version('v2.0.0') and version migration on resumption
 * - flow.resume(correlationKey, payload) continuation to downstream steps
 */
export function createDurableExpenseApprovalWorkflow() {
    // Step 1: Submit & Check Corporate Policy
    const submitExpenseReport = Step.create('submitExpenseReport', async (param: any) => {
        const amount = param.amount;
        const reportId = param.reportId;
        const employeeEmail = param.employeeEmail;
        const requiresExecutiveSignoff = amount > 1000;

        return {
            reportId,
            employeeEmail,
            amount,
            submissionTimestamp: Date.now(),
            requiresExecutiveSignoff,
            workflowPhase: 'PENDING_APPROVAL'
        };
    });

    // Step 2: Durable Suspension Point (Awaits webhook / human approval event)
    const awaitManagerApproval = waitForEvent('expense.decision', {
        correlationKey: (ctx) => ctx.reportId,
        timeout: '7d' // Human SLA: 7 days
    });

    // Step 3: Process Disbursement upon Resumption
    const disburseFunds = Step.create('disburseFunds', async (param: any) => {
        const approvedBy = param.approvedBy || 'auto-system';
        const approvedAmount = param.approvedAmount || param.amount || 0;
        const reportId = param.reportId;
        const employeeEmail = param.employeeEmail;
        const disbursementRef = `ACH-EXP-${reportId}-${Date.now()}`;

        return {
            pipelineStatus: 'REIMBURSED',
            reportId,
            employeeEmail,
            approvedBy,
            disbursedAmount: approvedAmount,
            disbursementRef,
            policyV2Applied: param.policyV2Applied ?? false
        };
    });

    const workflow = flow(
        submitExpenseReport,
        awaitManagerApproval,
        disburseFunds
    ).version('v2.0.0');

    return workflow;
}
