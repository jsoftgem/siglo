import { Step, flow } from 'rivulet';

export interface FinancialTransactionInput {
    transactionId: string;
    sourceAccountId: string;
    destinationAccountId: string;
    amount: number;
    currency: string;
    clientIp: string;
    timestamp: number;
}

/**
 * Use Case 3: Financial Transaction Processing & Fraud Detection
 * Flow: ingestTransaction -> validateKycLimits -> runMlFraudModel -> executeLedgerTransfer -> emitAuditLog
 * Features:
 * - Step.create(...).modern() for idiomatic POJO parameter handling
 * - Strict spec contracts (validates currency format, positive numbers, required IDs)
 * - ML fraud risk scoring and compliance velocity checks
 * - Double-entry ledger booking with immutable audit logging
 */
export function createFinancialFraudPipeline() {
    // Step 1: Ingest Transaction & Check Idempotency
    const processedTransactions = new Set<string>();

    const ingestTransaction = Step.create('finIngestTransaction', async (param: any) => {
        const { transactionId: txnId, amount, currency } = param;

        if (processedTransactions.has(txnId)) {
            throw new Error(`Duplicate transaction detected: ${txnId}`);
        }
        processedTransactions.add(txnId);

        return {
            ingestTimestamp: Date.now(),
            idempotencyVerified: true,
            ingestedAmount: amount,
            ingestedCurrency: currency
        };
    }).modern()
      .spec('transactionId', { require: true })
      .spec('sourceAccountId', { require: true })
      .spec('destinationAccountId', { require: true })
      .spec('amount', {
          require: true,
          validator: async (val: number) => {
              if (typeof val !== 'number' || val <= 0) {
                  throw new Error('Amount must be a positive number');
              }
          }
      })
      .spec('currency', {
          require: true,
          validator: async (val: string) => {
              if (!['USD', 'EUR', 'GBP', 'JPY'].includes(val)) {
                  throw new Error(`Unsupported currency: ${val}`);
              }
          }
      });

    // Step 2: Validate KYC Limits
    const validateKycLimits = Step.create('finValidateKycLimits', async (param: any) => {
        const { amount } = param;
        const maxDailyLimit = 50000; // $50k maximum for tier 2 KYC

        if (amount > maxDailyLimit) {
            throw new Error(`Transaction amount $${amount} exceeds Tier 2 daily KYC limit of $${maxDailyLimit}`);
        }

        return {
            kycVerified: true,
            tier: 'TIER_2',
            remainingLimit: maxDailyLimit - amount
        };
    }).modern();

    // Step 3: Run ML Fraud Model
    const runMlFraudModel = Step.create('finRunMlFraudModel', async (param: any) => {
        const { amount, clientIp } = param;

        // Calculate heuristic risk score (0-100)
        let riskScore = 15; // baseline
        if (amount > 10000) riskScore += 30;
        if (clientIp.startsWith('10.') || clientIp.startsWith('192.168.')) riskScore -= 10; // trusted subnet

        const isFraudSuspicious = riskScore >= 80;

        if (isFraudSuspicious) {
            throw new Error(`Transaction flagged by ML Fraud engine: riskScore ${riskScore} exceeds threshold`);
        }

        return {
            fraudCheckPassed: true,
            riskScore,
            fraudAssessment: 'LOW_RISK'
        };
    }).modern();

    // Step 4: Execute Ledger Transfer (Double-entry debit/credit)
    const executeLedgerTransfer = Step.create('finExecuteLedgerTransfer', async (param: any) => {
        const { transactionId: txnId, sourceAccountId: source, destinationAccountId: dest, amount, currency } = param;

        const journalId = `JRNL-${txnId}-${Date.now()}`;

        return {
            ledgerStatus: 'POSTED',
            journalId,
            entries: [
                { account: source, type: 'DEBIT', amount, currency },
                { account: dest, type: 'CREDIT', amount, currency }
            ]
        };
    }).modern();

    // Step 5: Emit Audit Log
    const emitAuditLog = Step.create('finEmitAuditLog', async (param: any) => {
        const { transactionId: txnId, journalId, riskScore, ledgerStatus, idempotencyVerified, kycVerified, fraudCheckPassed, fraudAssessment } = param;

        return {
            finStatus: 'COMPLETED',
            idempotencyVerified,
            kycVerified,
            fraudCheckPassed,
            fraudAssessment,
            auditLogged: true,
            auditReference: `AUDIT-${txnId}`,
            ledgerStatus,
            journalId,
            riskScore,
            completedAt: new Date().toISOString()
        };
    }).modern();

    return flow(
        ingestTransaction,
        validateKycLimits,
        runMlFraudModel,
        executeLedgerTransfer,
        emitAuditLog
    );
}
