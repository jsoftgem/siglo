import { Step, flow } from '@siglo/core';

export interface FulfillmentInput {
    orderId: string;
    sku: string;
    quantity: number;
    amountCents: number;
}

export interface FulfillmentResult {
    orderId: string;
    inventoryStatus: string;
    reservationId: string;
    paymentId: string;
    trackingId: string;
    fulfilledAt: string;
}

// 1. Check stock availability for the item
const checkInventory = Step.create('fulfillment:checkInventory', async (_input: FulfillmentInput) => {
    // Artificial small delay to make timeline observable in the live monitor
    await new Promise(resolve => setTimeout(resolve, 40));
    return {
        inventoryStatus: 'AVAILABLE',
        availableQuantity: 42,
    };
});

// 2. Reserve stock in inventory warehouse
const reserveStock = Step.create(
    'fulfillment:reserveStock',
    async (ctx: FulfillmentInput & { inventoryStatus: string }) => {
        await new Promise(resolve => setTimeout(resolve, 35));
        return {
            reservationId: `res_${ctx.orderId}_${ctx.sku}`,
        };
    },
);

// 3. Process payment through payment gateway
const chargePayment = Step.create(
    'fulfillment:chargePayment',
    async (ctx: FulfillmentInput & { reservationId: string }) => {
        await new Promise(resolve => setTimeout(resolve, 60));
        return {
            paymentId: `pay_${ctx.orderId}_${Date.now()}`,
            amountPaid: ctx.amountCents,
        };
    },
);

// 4. Generate courier shipping label and tracking number
const generateShippingLabel = Step.create(
    'fulfillment:generateShippingLabel',
    async (ctx: FulfillmentInput & { reservationId: string; paymentId: string }) => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return {
            trackingId: `trk_${ctx.orderId}_express`,
            fulfilledAt: new Date().toISOString(),
        };
    },
);

export const fulfillmentWorkflow = flow(
    checkInventory,
    reserveStock,
    chargePayment,
    generateShippingLabel,
).networkPolicy({
    enabled: false,
});

export interface FulfillmentServiceHandler {
    handleRequest: (
        payload: FulfillmentInput,
        headers: { stackId: string; parentStackId?: string; namespace?: string },
    ) => Promise<FulfillmentResult>;
}

export function createFulfillmentService(options: { monitor?: any } = {}): FulfillmentServiceHandler {
    return {
        async handleRequest(
            payload: FulfillmentInput,
            headers: { stackId: string; parentStackId?: string; namespace?: string },
        ) {
            // Run the downstream domain workflow with the exact same stackId and namespace
            const result = await fulfillmentWorkflow.run(payload, {
                stackId: headers.stackId,
                namespace: headers.namespace,
                workflowId: 'fulfillment-service',
                monitor: options.monitor,
                pojo: true,
            });

            return {
                orderId: payload.orderId,
                inventoryStatus: result.inventoryStatus,
                reservationId: result.reservationId,
                paymentId: result.paymentId,
                trackingId: result.trackingId,
                fulfilledAt: result.fulfilledAt,
            };
        },
    };
}
