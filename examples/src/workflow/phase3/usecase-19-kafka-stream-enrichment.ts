import { Step, flow } from 'rivulet';
import { createKafkaMessageHandler } from '@rivulet/kafka';

export interface KafkaTransactionPayload {
    transactionId: string;
    accountId: string;
    amount: number;
    currency: string;
    ipAddress: string;
    timestamp: number;
}

export interface EnrichedTransactionOutput {
    transactionId: string;
    accountId: string;
    amount: number;
    accountTier: 'BASIC' | 'PREMIUM' | 'VIP';
    riskScore: number;
    isFlagged: boolean;
    namespace: string;
    processedAt: number;
}

/**
 * Use Case 19: High-Volume Event-Driven Kafka Stream Enrichment
 * Adapter demonstrated: @rivulet/kafka
 * Features demonstrated:
 * - Consumption of streaming messages via createKafkaMessageHandler
 * - Namespace extraction from Kafka headers (`x-namespace`)
 * - Multi-stage enrichment (account tier lookup, fraud detection, scoring)
 * - Error isolation and dead-letter queue routing for malformed payloads
 */
export function createKafkaEnrichmentWorkflow() {
    // Step 1: Decode & Validate Message
    const decodeEvent = Step.create('decodeEvent', async (param: any) => {
        const { transactionId, accountId, amount, currency } = param;
        if (!transactionId || !accountId || amount === undefined) {
            throw new Error('KafkaPayloadError: Missing transactionId or accountId');
        }
        return {
            transactionId,
            accountId,
            amount,
            currency: currency || 'USD',
            decodedAt: Date.now()
        };
    }).modern();

    // Step 2: Lookup Account Profile by Namespace & Account
    const enrichAccountProfile = Step.create('enrichAccountProfile', async (param: any) => {
        const { accountId, amount } = param;
        const accountTier: 'BASIC' | 'PREMIUM' | 'VIP' =
            accountId.startsWith('VIP') ? 'VIP' : (accountId.startsWith('PREM') ? 'PREMIUM' : 'BASIC');

        const namespace = typeof param.$namespace === 'function' ? param.$namespace() : (param.$namespace || 'default');

        return {
            accountTier,
            namespace,
            isHighValue: amount > 5000
        };
    }).modern();

    // Step 3: Compute Real-Time Risk Score
    const scoreTransaction = Step.create('scoreTransaction', async (param: any) => {
        const { amount, accountTier, isHighValue } = param;

        let riskScore = 10;
        if (isHighValue) riskScore += 40;
        if (accountTier === 'BASIC' && amount > 2000) riskScore += 30;
        if (amount > 10000) riskScore += 25;

        const isFlagged = riskScore >= 70;

        return {
            riskScore,
            isFlagged,
            pipelineStatus: isFlagged ? 'FLAGGED_FOR_REVIEW' : 'ENRICHED_CLEARED',
            processedAt: Date.now()
        };
    }).modern();

    return flow(decodeEvent, enrichAccountProfile, scoreTransaction);
}

/**
 * Creates Kafka message consumer handler.
 */
export function createKafkaTransactionConsumer(workflow = createKafkaEnrichmentWorkflow()) {
    const handler = createKafkaMessageHandler(workflow, {
        output: (result: any, message: any) => ({
            status: 'COMMITTED',
            key: message.key ? message.key.toString() : null,
            enriched: {
                transactionId: typeof result.transactionId === 'function' ? result.transactionId() : result.transactionId,
                riskScore: typeof result.riskScore === 'function' ? result.riskScore() : result.riskScore,
                isFlagged: typeof result.isFlagged === 'function' ? result.isFlagged() : result.isFlagged,
                accountTier: typeof result.accountTier === 'function' ? result.accountTier() : result.accountTier,
                namespace: typeof result.namespace === 'function' ? result.namespace() : result.namespace
            }
        })
    });

    return async (payload: any) => {
        const msg = payload.message || payload;
        try {
            return await handler(payload);
        } catch (err: any) {
            return {
                status: 'DEAD_LETTER',
                error: err.message,
                key: msg.key ? msg.key.toString() : null,
                offset: msg.offset
            };
        }
    };
}
