import { SigloError, Step, branch, flow, when } from '@siglo/core';

export interface OrderEvent {
    eventId: string;
    type: string;
    orderId: string;
    tenant: string;
    amountCents?: number;
    giftWrap?: boolean;
}
export interface OrderOutcome extends OrderEvent {
    status: 'shipped' | 'review-required' | 'cancellation-recorded';
    actions: string[];
    giftWrapped?: boolean;
    handledBy?: string;
}
export class UnsupportedOrderEvent extends SigloError {
    constructor(type: string) {
        super(`Unsupported event type: ${type}`, { retryable: false });
        this.name = 'UnsupportedOrderEvent';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Fake fulfillment operations: no payment, warehouse, or shipping credentials needed. */
export function createOrderRoutingWorkflow(save: (outcome: OrderOutcome) => Promise<OrderOutcome>) {
    const reserveStock = Step.create('reserveStock', async () => ({ actions: ['reserveStock'] }));
    const chargePayment = Step.create('chargePayment', async (order: { actions: string[] }) => ({
        actions: [...order.actions, 'chargePayment'],
    }));
    const wrapGift = Step.create('wrapGift', async (order: { actions: string[] }) => ({
        giftWrapped: true, actions: [...order.actions, 'wrapGift'],
    }));
    const shipOrder = Step.create('shipOrder', async (order: { actions: string[] }) => ({
        status: 'shipped' as const, actions: [...order.actions, 'shipOrder'],
    }));
    const queueReview = Step.create('queueReview', async () => ({
        status: 'review-required' as const, actions: ['queueReview'],
    }));
    const cancelOrder = Step.create('recordCancellation', async () => ({
        status: 'cancellation-recorded' as const, actions: ['recordCancellation'],
    }));
    const rejectUnsupported = Step.create('rejectUnsupported', async (event: OrderEvent) => {
        throw new UnsupportedOrderEvent(event.type);
    });
    const saveOutcome = Step.create('saveOutcome', async (outcome: OrderOutcome) => save(outcome));

    const fulfillment = flow(
        reserveStock,
        chargePayment,
        when(order => order.giftWrap === true, wrapGift),
        shipOrder,
    );
    const placedOrder = when(
        order => order.amountCents >= 100000,
        queueReview,
        fulfillment,
    );
    return flow(
        branch(event => event.type, {
            'order.placed': placedOrder,
            'order.cancelled': cancelOrder,
        }, rejectUnsupported),
        saveOutcome,
    );
}

export function validateOrderEvent(value: unknown): asserts value is OrderEvent {
    if (!value || typeof value !== 'object') throw new Error('Expected an order event');
    const event = value as Partial<OrderEvent>;
    for (const name of ['eventId', 'type', 'orderId', 'tenant'] as const) {
        if (typeof event[name] !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(event[name]!)) {
            throw new Error(`${name} must be a nonempty identifier (up to 100 characters)`);
        }
    }
    if (event.type === 'order.placed' && (!Number.isSafeInteger(event.amountCents) || event.amountCents! <= 0)) {
        throw new Error('order.placed requires positive integer amountCents');
    }
    if (event.giftWrap !== undefined && typeof event.giftWrap !== 'boolean') throw new Error('giftWrap must be boolean');
}
