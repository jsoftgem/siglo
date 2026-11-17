import { Step, flow, when } from '@siglo/core';

// 1. Define Domain Interfaces
export interface OrderInput {
    orderId: string;
    customerId: string;
    sku: string;
    quantity: number;
    amountCents: number;
    shippingPriority: 'standard' | 'express';
}

export interface InventoryService {
    reserve(orderId: string, sku: string, qty: number): Promise<string>;
    release(reservationId: string): Promise<void>;
}

export interface PaymentService {
    charge(orderId: string, amountCents: number): Promise<string>;
    refund(chargeId: string): Promise<void>;
}

export interface ShippingService {
    dispatch(orderId: string, priority: string): Promise<string>;
}

export function createOrderFulfillmentFlow(deps: {
    inventory: InventoryService;
    payment: PaymentService;
    shipping: ShippingService;
}) {
    // 2. Validate, Transform, and Enforce Order Input via .spec() and .strict()
    const validateOrder = Step.create('validateOrder', (order: OrderInput) => {
        return { validatedAt: new Date().toISOString() };
    })
        .spec('orderId', {
            require: true,
            requireMessage: 'Order ID is required',
        })
        .spec('sku', {
            require: true,
            transform: async (sku: string) => sku.trim().toUpperCase(), // Sanitizes / normalizes input
        })
        .spec('quantity', {
            require: true,
            validate: async (qty: number) => {
                if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a positive integer');
            },
        })
        .spec('amountCents', {
            require: true,
            validate: async (amt: number) => {
                if (typeof amt !== 'number' || amt <= 0) throw new Error('amountCents must be positive');
            },
        })
        .spec('shippingPriority', {
            default: 'standard', // Fallback default value
        })
        .strict(); // Filters out any undeclared payload properties

    // 3. Reserve Stock with Compensation
    const reserveStock = Step.create('reserveStock', async (ctx: OrderInput) => {
        const reservationId = await deps.inventory.reserve(ctx.orderId, ctx.sku, ctx.quantity);
        return { reservationId };
    }).compensate(async ({ reservationId }) => {
        // Saga rollback: release reserved inventory if downstream steps fail
        if (reservationId) {
            await deps.inventory.release(reservationId);
        }
    });

    // 4. Charge Payment with Exponential Backoff & Jitter + Compensation
    const chargePayment = Step.create('chargePayment', async (ctx: OrderInput & { reservationId: string }) => {
        const chargeId = await deps.payment.charge(ctx.orderId, ctx.amountCents);
        return { chargeId };
    })
        .onFail({
            maxRetries: 3,
            delay: 100,
            backoff: 'exponential',
            jitter: true,
            retryIf: (err: any) => err.code === 'NETWORK_ERROR' || err.status >= 500,
        })
        .compensate(async ({ chargeId }) => {
            // Saga rollback: refund customer charge
            if (chargeId) {
                await deps.payment.refund(chargeId);
            }
        });

    // 5. Express vs Standard Shipping using 'when()' combinator
    const dispatchStandardShipping = Step.create('dispatchStandard', async (ctx: OrderInput) => ({
        trackingNumber: await deps.shipping.dispatch(ctx.orderId, 'standard'),
        carrier: 'Standard Ground',
    }));

    const dispatchExpressShipping = Step.create('dispatchExpress', async (ctx: OrderInput) => ({
        trackingNumber: await deps.shipping.dispatch(ctx.orderId, 'express'),
        carrier: 'Air Express Next-Day',
    }));

    const routeShipping = when(
        (ctx: OrderInput) => ctx.shippingPriority === 'express',
        dispatchExpressShipping,
        dispatchStandardShipping,
    );

    // 6. Chain into Sequential Flow
    return flow(validateOrder, reserveStock, chargePayment, routeShipping);
}
