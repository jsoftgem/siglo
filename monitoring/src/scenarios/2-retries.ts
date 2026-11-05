import { Step, flow, toPOJO } from '@siglo/core';
import { instrumentWorkflow } from '@siglo/opentelemetry';
import { initTelemetry, getRecordedSpans, clearRecordedSpans, printTraceWaterfall } from '../tracer';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Scenario 2: Retries and Exponential Backoff
 * Visualizes transient failures, retry attempt spans (retry #2, retry #3), and recovery.
 */
export async function runRetriesScenario(options: { silent?: boolean } = {}) {
    clearRecordedSpans();
    const tracer = initTelemetry({ serviceName: 'billing-service' });

    let attempts = 0;

    const preparePayment = Step.create('preparePayment', async (param: any) => {
        await sleep(20);
        return { paymentIntentId: `PI-${param.orderId}`, amount: param.amount };
    });

    // Transient failure: fails first 2 times, succeeds on the 3rd
    const chargeCreditCard = Step.create('chargeCreditCard', async (param: any) => {
        attempts++;
        await sleep(35);

        if (attempts < 3) {
            throw new Error(`UpstreamGateway503: Payment processor timed out (attempt ${attempts})`);
        }

        return {
            chargeId: `CHG-${param.orderId}-SUCCESS`,
            status: 'CAPTURED',
            totalAttempts: attempts
        };
    })
        .onFail({ maxRetries: 3, delay: 50 })
        ;

    const notifyReceipt = Step.create('notifyReceipt', async (param: any) => {
        await sleep(15);
        return { receiptSent: true, chargeId: param.chargeId };
    });

    const paymentWorkflow = flow(
        preparePayment,
        chargeCreditCard,
        notifyReceipt
    );

    const monitoredFlow = instrumentWorkflow(paymentWorkflow, {
        tracer,
        workflowName: 'ResilientPaymentWorkflow',
        workflowVersion: '2.1.0'
    });

    const rawResult = await monitoredFlow.run({ orderId: 'ORD-2002', amount: 250.0 });
    const result = toPOJO(rawResult);
    const spans = getRecordedSpans();

    if (!options.silent) {
        printTraceWaterfall('Scenario 2: Retries, Backoff & Attempt Spans', spans);
    }

    return { result, spans, attempts };
}

if (process.argv[1]?.endsWith('2-retries.ts')) {
    runRetriesScenario().then(() => process.exit(0));
}
