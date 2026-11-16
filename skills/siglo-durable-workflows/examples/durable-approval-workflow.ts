import express from 'express';
import { Step, flow, waitForEvent, resumeWorkflow, useStorage } from '@siglo/core';
import { PostgresStorageAdapter } from '@siglo/postgres';
import { Pool } from 'pg';

// 1. Initialize PostgreSQL Storage Adapter
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/siglo_db',
});
const storageAdapter = new PostgresStorageAdapter({ client: pool });
useStorage(storageAdapter);

// 2. Define Durable Expense Approval Workflow
export interface ExpenseSubmission {
    expenseId: string;
    submitterEmail: string;
    amountCents: number;
    description: string;
}

export const expenseWorkflow = flow(
    Step.create('registerExpense', async (input: ExpenseSubmission) => {
        console.log(`[Workflow] Expense ${input.expenseId} submitted for amount ${input.amountCents}`);
        return {
            status: 'PENDING_APPROVAL',
            registeredAt: new Date().toISOString(),
        };
    }),

    // Suspend execution and wait for human webhook approval (auto-expires in 7 days)
    waitForEvent('managerApproval', {
        correlationKey: (ctx: ExpenseSubmission) => ctx.expenseId,
        timeout: '7d',
    }),

    Step.create(
        'payoutIfApproved',
        async (ctx: { expenseId: string; amountCents: number; approved: boolean; approverEmail: string }) => {
            if (!ctx.approved) {
                console.log(`[Workflow] Expense ${ctx.expenseId} was rejected by ${ctx.approverEmail}`);
                return { payoutStatus: 'REJECTED' };
            }

            console.log(`[Workflow] Expense ${ctx.expenseId} approved! Initiating payout of ${ctx.amountCents} cents.`);
            const payoutTxId = `tx_${Date.now()}_${ctx.expenseId}`;
            return {
                payoutStatus: 'PAID',
                payoutTxId,
                paidAt: new Date().toISOString(),
            };
        },
    ),
);

// 3. Express Web Server Handling Ingestion and Resumption
export function createExpenseServer() {
    const app = express();
    app.use(express.json());

    // Submit expense -> Starts durable workflow and suspends
    app.post('/api/expenses', async (req, res) => {
        const { expenseId, submitterEmail, amountCents, description } = req.body;
        if (!expenseId || !amountCents) {
            return res.status(400).json({ error: 'Missing expenseId or amountCents' });
        }

        try {
            const runResult = await expenseWorkflow.run(
                { expenseId, submitterEmail, amountCents, description },
                { durable: true, namespace: 'expenses' },
            );

            // Workflow suspends at waitForEvent and returns status 'waiting'
            return res.status(202).json({
                message: 'Expense submitted and waiting for manager approval',
                status: runResult.status,
                expenseId,
            });
        } catch (err: any) {
            return res.status(500).json({ error: err.message });
        }
    });

    // Approval Webhook -> Resumes durable workflow
    app.post('/api/expenses/approval-webhook', async (req, res) => {
        const { expenseId, approved, approverEmail } = req.body;
        if (!expenseId || typeof approved !== 'boolean') {
            return res.status(400).json({ error: 'Missing expenseId or approved boolean' });
        }

        try {
            // Resume workflow by its correlationKey
            const finalResult = await resumeWorkflow(
                expenseWorkflow,
                expenseId,
                { approved, approverEmail },
                { pojo: true },
            );

            return res.json({
                message: 'Workflow completed successfully',
                result: finalResult,
            });
        } catch (err: any) {
            if (err.name === 'ExpiredWaitException') {
                return res.status(410).json({ error: 'Approval expired' });
            }
            return res.status(500).json({ error: err.message });
        }
    });

    return app;
}
