import { Step, flow } from '@siglo/core';
import { FulfillmentServiceHandler, FulfillmentResult } from './fulfillment-service';

export interface OrderInput {
    orderId: string;
    customerEmail: string;
    sku: string;
    quantity: number;
    amountCents: number;
}

export interface FinalOrderResult {
    orderId: string;
    status: 'CONFIRMED' | 'FAILED';
    $stackId: string;
    namespace?: string;
    fulfillment: FulfillmentResult;
    childWorkflow: {
        service: string;
        stackId: string;
        parentStackId: string;
        triggeredBy: string;
    };
    completedAt: string;
}

export function createOrderWorkflow(fulfillmentClient: FulfillmentServiceHandler) {
    // 1. Validate order parameters and tenant business rules
    const validateOrder = Step.create('order:validate', async (input: OrderInput) => {
        if (!input.orderId) throw new Error('Order ID is required');
        if (!input.sku) throw new Error('SKU is required');
        if (input.quantity <= 0) throw new Error('Quantity must be greater than 0');

        await new Promise(resolve => setTimeout(resolve, 25));

        return {
            validated: true,
            validatedAt: new Date().toISOString(),
        };
    });

    // 2. Persist initial order record in Order domain database
    const createOrderRecord = Step.create('order:createRecord', async (ctx: OrderInput & { validated: boolean }) => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return {
            dbRecordId: `rec_${ctx.orderId}`,
            initialStatus: 'PENDING_FULFILLMENT',
        };
    });

    // 3. Dispatch to Fulfillment Service via cross-domain boundary (HTTP / Kafka)
    // CRITICAL: Extract current $stackId and propagate a correlated child stackId
    const dispatchToFulfillment = Step.create('order:dispatchToFulfillment', async (ctx: any) => {
        // Retrieve current execution stackId and tenant namespace from step context
        const stackId = typeof ctx.$stackId === 'function' ? ctx.$stackId() : ctx.$stackId || ctx.stackId;
        const namespace = typeof ctx.$namespace === 'function' ? ctx.$namespace() : ctx.$namespace || ctx.namespace;

        // Generate correlated child stackId (e.g. stack-101:fulfillment)
        // This gives Fulfillment Service its OWN clean connected DAG in Live Monitor,
        // while remaining linked to and searchable by the parent stackId.
        const childStackId = `${stackId}:fulfillment`;

        // Invoke downstream domain service, forwarding the execution stackId and tenant headers
        const fulfillmentResult = await fulfillmentClient.handleRequest(
            {
                orderId: ctx.orderId,
                sku: ctx.sku,
                quantity: ctx.quantity,
                amountCents: ctx.amountCents,
            },
            {
                stackId: childStackId,
                parentStackId: stackId,
                namespace,
            },
        );

        return {
            fulfillment: fulfillmentResult,
            childWorkflow: {
                service: 'fulfillment-service',
                stackId: childStackId,
                parentStackId: stackId,
                triggeredBy: 'order:dispatchToFulfillment',
            },
        };
    });

    // 4. Finalize order status upon successful fulfillment
    const finalizeOrder = Step.create(
        'order:finalizeOrder',
        async (_ctx: OrderInput & { fulfillment: FulfillmentResult }) => {
            await new Promise(resolve => setTimeout(resolve, 20));

            return {
                status: 'CONFIRMED' as const,
                completedAt: new Date().toISOString(),
            };
        },
    );

    return flow(validateOrder, createOrderRecord, dispatchToFulfillment, finalizeOrder).networkPolicy({
        enabled: false,
    });
}
