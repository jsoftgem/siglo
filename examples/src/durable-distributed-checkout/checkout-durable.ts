import { Step, flow, waitForEvent } from '@siglo/core';
import { TemporaryPaymentError, type CheckoutServices, type Order } from '../getting-started/checkout';

export class ApprovalRejectedError extends Error {}

export function createDurableCheckout(services: CheckoutServices) {
    const reserveStock = Step.create('reserveStock', async (order: Order) => ({
        reservationId: await services.reserve(order),
    })).compensate(async (output: { reservationId: string }) => services.release(output.reservationId));

    const chargePayment = Step.create('chargePayment', async (order: Order) => ({
        paymentId: await services.charge(order),
    }))
        .onFail({
            maxRetries: 2,
            delay: 10,
            backoff: 'exponential',
            retryIf: error => error instanceof TemporaryPaymentError,
        })
        .compensate(async (output: { paymentId: string }) => services.refund(output.paymentId));

    const awaitApproval = waitForEvent('order.approved', {
        correlationKey: (order: Order) => `order:${order.orderId}`,
        timeout: '24h',
    });

    const arrangeShipping = Step.create(
        'arrangeShipping',
        async (
            order: Order & { reservationId: string; paymentId: string; approved?: boolean; approverId?: string },
        ) => {
            if (order.approved !== true) {
                // Continuations do not reconstruct compensation handlers from earlier
                // processes. Reconcile the persisted provider IDs explicitly here.
                await services.refund(order.paymentId);
                await services.release(order.reservationId);
                throw new ApprovalRejectedError('Order rejected by reviewer');
            }
            return {
                status: 'confirmed',
                trackingId: await services.ship(order),
                approvedBy: order.approverId,
            };
        },
    );

    return flow(reserveStock, chargePayment, awaitApproval, arrangeShipping).version('1.0.0');
}
