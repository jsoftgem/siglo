import { branch, flow, Step, when } from '@siglo/core';

export interface RoutingOutcome {
    eventId: string;
    status: string;
    actions: string[];
}
export function createRoutingWorkflow(onOutcome: (result: RoutingOutcome) => void | Promise<void>) {
    // Independent copy of the routing idea; no imports from another tutorial.
    const fulfill = flow(
        Step.create('reserveStock', async () => ({ actions: ['reserveStock'] })),
        Step.create('chargePayment', async (order: { actions: string[] }) => ({
            actions: [...order.actions, 'chargePayment'],
        })),
        when(
            order => order.giftWrap === true,
            Step.create('wrapGift', async (order: { actions: string[] }) => ({
                actions: [...order.actions, 'wrapGift'],
            })),
        ),
        Step.create('shipOrder', async (order: { actions: string[] }) => ({
            status: 'shipped',
            actions: [...order.actions, 'shipOrder'],
        })),
    );
    return flow(
        branch(
            order => order.type,
            {
                'order.placed': when(
                    order => order.amountCents >= 100000,
                    Step.create('queueReview', async () => ({ status: 'review-required', actions: ['queueReview'] })),
                    fulfill,
                ),
            },
            Step.create('rejectUnsupported', async () => {
                throw new Error('Unsupported order');
            }),
        ),
        Step.create('logOutcome', async (result: RoutingOutcome) => {
            await onOutcome({ eventId: result.eventId, status: result.status, actions: result.actions });
            return {};
        }),
    );
}
