import { Step, flow } from '@siglo/core';

export interface CheckoutInput {
    orderId: string;
    sku: string;
    quantity: number;
    amountCents: number;
}

export interface CheckoutResult {
    orderId: string;
    reservationId: string;
    paymentId: string;
    trackingId: string;
}

export interface LegacyCheckoutServices {
    inventoryService: {
        reserve(input: CheckoutInput): Promise<string>;
        release(reservationId: string): Promise<void>;
    };
    paymentService: {
        charge(input: { orderId: string; amountCents: number }): Promise<string>;
        refund(paymentId: string): Promise<void>;
    };
    shippingService: {
        dispatch(input: { orderId: string; reservationId: string; paymentId: string }): Promise<string>;
    };
}

/**
 * Creates unmodified legacy service fakes that record an audit trail of calls.
 * Simulates one transient payment failure on the first attempt and an optional courier failure.
 */
export function createLegacyServices(options: { failShipment?: boolean; retryDelayMs?: number } = {}) {
    const events: string[] = [];
    let chargeAttempts = 0;

    const services: LegacyCheckoutServices = {
        inventoryService: {
            async reserve({ orderId, sku, quantity }) {
                events.push(`inventory.reserve(${orderId}, ${sku} x${quantity})`);
                return `res_${orderId}`;
            },
            async release(reservationId) {
                events.push(`inventory.release(${reservationId})`);
            },
        },
        paymentService: {
            async charge({ orderId, amountCents }) {
                chargeAttempts += 1;
                events.push(`payment.charge(${orderId}, ${amountCents}c) [attempt ${chargeAttempts}]`);
                if (chargeAttempts === 1) {
                    throw new Error('503 Payment gateway timeout');
                }
                return `pay_${orderId}`;
            },
            async refund(paymentId) {
                events.push(`payment.refund(${paymentId})`);
            },
        },
        shippingService: {
            async dispatch({ orderId, reservationId, paymentId }) {
                events.push(`shipping.dispatch(${orderId}, ${reservationId}, ${paymentId})`);
                if (options.failShipment) {
                    throw new Error('Courier service unavailable for region');
                }
                return `trk_${orderId}`;
            },
        },
    };

    return { services, events };
}

/**
 * 1. BEFORE: Typical controller function with manual retry loops, mutable state flags,
 *    and nested try/catch LIFO rollback blocks.
 */
export async function imperativeCheckout(
    input: CheckoutInput,
    services: LegacyCheckoutServices,
    retryDelayMs = 5,
): Promise<CheckoutResult> {
    const { orderId, sku, quantity, amountCents } = input;
    const { inventoryService, paymentService, shippingService } = services;
    let reservationId: string | undefined;
    let paymentId: string | undefined;

    try {
        // 1. Reserve inventory
        reservationId = await inventoryService.reserve({ orderId, sku, quantity });

        // 2. Charge payment with ad-hoc retry loop
        for (let attempt = 1; ; attempt++) {
            try {
                paymentId = await paymentService.charge({ orderId, amountCents });
                break;
            } catch (err) {
                if (attempt >= 3) throw err;
                await new Promise(r => setTimeout(r, retryDelayMs * 2 ** attempt));
            }
        }

        // 3. Create shipment
        const trackingId = await shippingService.dispatch({
            orderId,
            reservationId,
            paymentId,
        });

        return { orderId, reservationId, paymentId, trackingId };
    } catch (err) {
        // Manual reverse-order rollback
        if (paymentId) {
            try {
                await paymentService.refund(paymentId);
            } catch {}
        }
        if (reservationId) {
            try {
                await inventoryService.release(reservationId);
            } catch {}
        }
        throw err;
    }
}

/**
 * 2. AFTER: Wrap the exact same unmodified services in `Step.create()` and compose with `flow()`.
 */
export function createCheckoutWorkflow(services: LegacyCheckoutServices, retryDelayMs = 5) {
    const { inventoryService, paymentService, shippingService } = services;

    // 1. Wrap inventory reservation + attach its rollback compensation
    const reserveStock = Step.create('reserveStock', async (input: CheckoutInput) => {
        const reservationId = await inventoryService.reserve(input);
        return { reservationId };
    }).compensate(async ctx => {
        await inventoryService.release(ctx.reservationId);
    });

    // 2. Wrap payment charge + declarative retry backoff + refund compensation
    const chargeCustomer = Step.create('chargeCustomer', async ({ orderId, amountCents }: CheckoutInput) => {
        const paymentId = await paymentService.charge({ orderId, amountCents });
        return { paymentId };
    })
        .onFail({ maxRetries: 3, backoff: 'exponential', delay: retryDelayMs, jitter: 'full' })
        .compensate(async ctx => {
            await paymentService.refund(ctx.paymentId);
        });

    // 3. Wrap shipment creation (receives reservationId & paymentId with static type inference)
    const createShipment = Step.create(
        'createShipment',
        async ({ orderId, reservationId, paymentId }: CheckoutInput & { reservationId: string; paymentId: string }) => {
            const trackingId = await shippingService.dispatch({
                orderId,
                reservationId,
                paymentId,
            });
            return { trackingId };
        },
    );

    return flow(reserveStock, chargeCustomer, createShipment).timeout(10_000);
}

export const sampleCheckoutInput: CheckoutInput = {
    orderId: 'ord_5001',
    sku: 'ergonomic-keyboard',
    quantity: 1,
    amountCents: 12900,
};

async function main() {
    console.log('=== 1. Happy Path (Transient Payment Retry Recovery) ===');

    const beforeRun = createLegacyServices();
    const beforeOut = await imperativeCheckout(sampleCheckoutInput, beforeRun.services);
    console.log('[Before: Imperative] Result:', beforeOut);
    console.log('[Before: Imperative] Events:', beforeRun.events.join(' -> '));

    const afterRun = createLegacyServices();
    const checkoutWorkflow = createCheckoutWorkflow(afterRun.services);
    const afterOut = await checkoutWorkflow.run(sampleCheckoutInput, { pojo: true });
    console.log('[After: Siglo Flow]  Result:', {
        orderId: afterOut.orderId,
        reservationId: afterOut.reservationId,
        paymentId: afterOut.paymentId,
        trackingId: afterOut.trackingId,
    });
    console.log('[After: Siglo Flow]  Events:', afterRun.events.join(' -> '));

    console.log('\n=== 2. Shipping Failure -> Automatic LIFO Saga Rollback ===');
    const rollbackRun = createLegacyServices({ failShipment: true });
    const rollbackWorkflow = createCheckoutWorkflow(rollbackRun.services);
    try {
        await rollbackWorkflow.run({ ...sampleCheckoutInput, orderId: 'ord_5002' }, { pojo: true });
    } catch (err) {
        console.log('[After: Siglo Flow]  Caught Error:', err instanceof Error ? err.message : String(err));
    }
    console.log('[After: Siglo Flow]  Saga Trail:  ', rollbackRun.events.join(' -> '));

    console.log('\n=== 3. Exported Mermaid Architecture Diagram ===');
    console.log(checkoutWorkflow.toMermaid({ direction: 'TD' }));
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
