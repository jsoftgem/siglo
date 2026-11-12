import { type WorkflowEventEmitter, Step, flow, parallel, toPOJO } from '@siglo/core';
import { instrumentWorkflow, instrumentStep } from '@siglo/opentelemetry';
import { initTelemetry, getRecordedSpans, clearRecordedSpans, printTraceWaterfall, runScenario } from '../tracer';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Scenario 1: Step Latencies and Parallel Fan-Out
 * Visualizes execution duration waterfalls and parallel branch timings.
 */
export async function runStepLatenciesScenario(options: { silent?: boolean; emitter?: WorkflowEventEmitter } = {}) {
    clearRecordedSpans();
    const tracer = initTelemetry({ serviceName: 'order-service' });

    // 1. Sequential validation
    const validateOrder = Step.create('validateOrder', async (param: any) => {
        await sleep(30);
        return { orderId: param.orderId, amount: param.amount, validated: true };
    });

    const enrichCustomer = Step.create('enrichCustomer', async () => {
        await sleep(40);
        return { tier: 'GOLD', loyaltyPoints: 450 };
    });

    // 2. Parallel fan-out branches (concurrent evaluation)
    const checkInventory = instrumentStep(
        Step.create('checkInventory', async () => {
            await sleep(75);
            return { inStock: true, warehouse: 'WH-EAST-1' };
        }),
        { tracer },
    );

    const performRiskAssessment = instrumentStep(
        Step.create('performRiskAssessment', async () => {
            await sleep(90);
            return { riskScore: 0.02, fraudFlag: false };
        }),
        { tracer },
    );

    const fetchPricingRules = instrumentStep(
        Step.create('fetchPricingRules', async () => {
            await sleep(50);
            return { discountApplied: 0.1, taxRate: 0.08 };
        }),
        { tracer },
    );

    const parallelChecks = parallel(checkInventory, performRiskAssessment, fetchPricingRules);

    // 3. Final sequential generation
    const generateInvoice = Step.create('generateInvoice', async (param: any) => {
        await sleep(25);
        return { invoiceId: `INV-${param.orderId}`, total: 108.0 };
    });

    const orderPipeline = flow(validateOrder, enrichCustomer, parallelChecks, generateInvoice);

    if (options.emitter) orderPipeline.monitor(options.emitter);

    // Instrument with OpenTelemetry
    const monitoredFlow = instrumentWorkflow(orderPipeline, {
        tracer,
        workflowName: 'OrderFulfillmentPipeline',
        workflowVersion: '1.2.3',
    });

    const rawResult = await monitoredFlow.run({ orderId: 'ORD-1001', amount: 100.0 });
    const result = toPOJO(rawResult);
    const spans = getRecordedSpans();

    if (!options.silent) {
        printTraceWaterfall('Scenario 1: Step Latencies & Parallel Fan-out Waterfall', spans);
    }

    return { result, spans };
}

if (process.argv[1]?.endsWith('1-step-latencies.ts')) {
    void runScenario(() => runStepLatenciesScenario());
}
