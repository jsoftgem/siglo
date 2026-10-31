import { Step, flow, InMemoryIdempotencyStore, buildIdempotencyKey } from 'siglo';

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
        const amount = param.amount;
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

        const txId = param.transactionId;
        const amount = param.amount;
        const currency = param.currency;
        const journalRef = `JRNL-${txId}-${Date.now()}`;

        return {
            settled: true,
            journalRef,
            amountSettled: amount,
            currency,
            settlementTimestamp: Date.now()
        };
    }).idempotent((ctx) => buildIdempotencyKey(ctx.transactionId, { namespace: 'ledger-settlement' }), {
        ttlMs: 60000,
        store
    });

    // Step 3: Issue Receipt
    const issueTransferReceipt = Step.create('issueTransferReceipt', async (param: any) => {
        return {
            pipelineStatus: 'SETTLED',
            transactionId: param.transactionId,
            sourceAccount: param.sourceAccount,
            targetAccount: param.targetAccount,
            amount: param.amount,
            journalRef: param.journalRef
        };
    });

    return {
        pipeline: flow(validateTransfer, settleLedgerEntry, issueTransferReceipt),
        store,
        stats
    };
}
