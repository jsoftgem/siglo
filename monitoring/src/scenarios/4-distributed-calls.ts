import { Step, flow, toPOJO } from 'siglo';
import {
    instrumentWorkflow,
    injectTraceContext,
    extractTraceContext
} from '@siglo/opentelemetry';
import { context as otelContext } from '@opentelemetry/api';
import { initTelemetry, getRecordedSpans, clearRecordedSpans, printTraceWaterfall } from '../tracer';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Scenario 4: Distributed Parent-Child Calls Across Microservices
 * Demonstrates W3C Traceparent injection in an upstream API gateway
 * and context extraction in a downstream asynchronous worker.
 */
export async function runDistributedCallsScenario(options: { silent?: boolean } = {}) {
    clearRecordedSpans();

    // -------------------------------------------------------------------------
    // SERVICE A: Checkout Gateway API (order-api-service)
    // -------------------------------------------------------------------------
    const apiTracer = initTelemetry({ serviceName: 'checkout-api' });

    const validatePayload = Step.create('validatePayload', async (param: any) => {
        await sleep(20);
        return { orderId: param.orderId, items: param.items, validated: true };
    });

    const publishOrderEvent = Step.create('publishOrderEvent', async (param: any) => {
        await sleep(30);
        // Inject active trace context into message carrier headers (e.g., Kafka / SQS / BullMQ)
        const carrierHeaders: Record<string, string> = {};
        injectTraceContext(carrierHeaders);

        return {
            orderId: param.orderId,
            carrierHeaders,
            eventPublished: true
        };
    });

    const checkoutFlow = flow(validatePayload, publishOrderEvent);
    const monitoredCheckout = instrumentWorkflow(checkoutFlow, {
        tracer: apiTracer,
        workflowName: 'CheckoutAPIFlow',
        workflowVersion: '3.0.0'
    });

    const rawUpstreamResult = await monitoredCheckout.run({
        orderId: 'ORD-7740',
        items: ['Mechanical Keyboard', 'Desk Mat']
    });
    const upstreamResult = toPOJO(rawUpstreamResult);

    const outgoingHeaders = upstreamResult.carrierHeaders;

    // -------------------------------------------------------------------------
    // SERVICE B: Warehouse Fulfillment Worker (warehouse-worker)
    // -------------------------------------------------------------------------
    const workerTracer = initTelemetry({ serviceName: 'warehouse-worker' });

    // Extract W3C trace context from incoming message headers
    const parentContext = extractTraceContext(outgoingHeaders);

    const pickItems = Step.create('pickItems', async (param: any) => {
        await sleep(40);
        return { itemsPicked: param.items?.length || 2, binLocation: 'BIN-C14' };
    });

    const packAndShip = Step.create('packAndShip', async (param: any) => {
        await sleep(35);
        return { trackingCode: `SHIP-${param.orderId}-FAST`, status: 'DISPATCHED' };
    });

    const fulfillmentFlow = flow(pickItems, packAndShip);
    const monitoredFulfillment = instrumentWorkflow(fulfillmentFlow, {
        tracer: workerTracer,
        workflowName: 'WarehouseFulfillmentFlow',
        workflowVersion: '1.0.0'
    });

    // Run downstream flow within the extracted parent trace context
    const rawDownstreamResult = await otelContext.with(parentContext, async () => {
        return monitoredFulfillment.run({
            orderId: upstreamResult.orderId,
            items: upstreamResult.items
        });
    });
    const downstreamResult = toPOJO(rawDownstreamResult);

    const spans = getRecordedSpans();

    if (!options.silent) {
        printTraceWaterfall(
            'Scenario 4: Distributed Parent-Child Tracing (checkout-api -> warehouse-worker)',
            spans
        );
    }

    return { upstreamResult, downstreamResult, spans, outgoingHeaders };
}

if (process.argv[1]?.endsWith('4-distributed-calls.ts')) {
    runDistributedCallsScenario().then(() => process.exit(0));
}
