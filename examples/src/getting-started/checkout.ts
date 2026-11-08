import { Step, flow } from '@siglo/core';

export interface Order {
    orderId: string;
    sku: string;
    quantity: number;
    amountCents: number;
}

export interface CheckoutServices {
    reserve(order: Order): Promise<string>;
    release(reservationId: string): Promise<void>;
    charge(order: Order): Promise<string>;
    refund(paymentId: string): Promise<void>;
    ship(order: Order & { reservationId: string; paymentId: string }): Promise<string>;
}

export class TemporaryPaymentError extends Error {}

export function createCheckout(services: CheckoutServices) {
    const validateOrder = Step.create('validateOrder', (order: Order) => {
        if (
            !order.orderId ||
            !order.sku ||
            !Number.isInteger(order.quantity) ||
            order.quantity < 1 ||
            !Number.isSafeInteger(order.amountCents) ||
            order.amountCents < 1
        ) {
            throw new Error('An order needs an ID, SKU, positive quantity, and amount in cents');
        }
        return { validated: true };
    });

    const reserveStock = Step.create('reserveStock', async (order: Order) => ({
        reservationId: await services.reserve(order),
    })).compensate(async (output: { reservationId: string }) => {
        await services.release(output.reservationId);
    });

    const chargePayment = Step.create('chargePayment', async (order: Order) => ({
        paymentId: await services.charge(order),
    }))
        .onFail({
            maxRetries: 2,
            delay: 10,
            backoff: 'exponential',
            retryIf: error => error instanceof TemporaryPaymentError,
        })
        .compensate(async (output: { paymentId: string }) => {
            await services.refund(output.paymentId);
        });

    const arrangeShipping = Step.create(
        'arrangeShipping',
        async (order: Order & { reservationId: string; paymentId: string }) => ({
            trackingId: await services.ship(order),
        }),
    );

    return flow(validateOrder, reserveStock, chargePayment, arrangeShipping);
}
