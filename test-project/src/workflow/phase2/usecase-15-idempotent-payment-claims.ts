import { Step, flow, InMemoryIdempotencyStore, buildIdempotencyKey } from 'fluid-func';

export interface BankTransferInput {
    transactionId: string;
    sourceAccount: string;
    targetAccount: string;
    amount: number;
    currency: string;
}

export interface BankLedgerStats {
    settlementExecutionCount: number;
}

/**
 * Use Case 15: Scoped Financial Settlement & Idempotent Claim Locking
 * Features demonstrated:
 * - step.idempotent(keyFn, { ttlMs, store })
 * - InMemoryIdempotencyStore claim and complete lifecycle
 * - Deterministic key derivation via buildIdempotencyKey
 * - Protection against double-settlement on re-deliveries and duplicate retries
 */
export function createIdempotentSettlementPipeline(
    store: InMemoryIdempotencyStore = new InMemoryIdempotencyStore(),
    stats: BankLedgerStats = { settlementExecutionCount: 0 }
) {
    // Step 1: Validate Accounts & Limits
    const validateTransfer = Step.create('validateTransfer', async (param: any) => {
        const amount = param.amount.val;
        if (amount <= 0) {
            throw new Error('Transfer amount must be positive');
        }

        return {
            transferValidated: true
        };
    });

    // Step 2: Critical Financial Settlement (Protected by Scoped Idempotency)
    const settleLedgerEntry = Step.create('settleLedgerEntry', async (param: any) => {
        // Track how many times this sensitive logic actually runs
        stats.settlementExecutionCount++;

        const txId = param.transactionId.val;
        const amount = param.amount.val;
        const currency = param.currency.val;
        const journalRef = `JRNL-${txId}-${Date.now()}`;

        return {
            settled: true,
            journalRef,
            amountSettled: amount,
            currency,
            settlementTimestamp: Date.now()
        };
    }).idempotent((ctx) => buildIdempotencyKey('ledger-settlement', { txId: ctx.transactionId.val }), {
        ttlMs: 60000,
        store
    });

    // Step 3: Issue Receipt
    const issueTransferReceipt = Step.create('issueTransferReceipt', async (param: any) => {
        return {
            pipelineStatus: 'SETTLED',
            transactionId: param.transactionId.val,
            sourceAccount: param.sourceAccount.val,
            targetAccount: param.targetAccount.val,
            amount: param.amount.val,
            journalRef: param.journalRef.val
        };
    });

    return {
        pipeline: flow(validateTransfer, settleLedgerEntry, issueTransferReceipt),
        store,
        stats
    };
}
