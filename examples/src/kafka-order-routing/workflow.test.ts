import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createOrderRoutingWorkflow, OrderOutcome, UnsupportedOrderEvent, validateOrderEvent } from './workflow';

const base = { eventId: 'event-1', type: 'order.placed', orderId: 'order-1', tenant: 'shop-demo', amountCents: 5000 };
for (const [name, changes, status, actions] of [
    ['ordinary order', {}, 'shipped', ['reserveStock', 'chargePayment', 'shipOrder']],
    ['gift order', { giftWrap: true }, 'shipped', ['reserveStock', 'chargePayment', 'wrapGift', 'shipOrder']],
    ['high-value order', { amountCents: 120000, giftWrap: true }, 'review-required', ['queueReview']],
    ['threshold boundary', { amountCents: 100000 }, 'review-required', ['queueReview']],
    ['cancellation', { type: 'order.cancelled' }, 'cancellation-recorded', ['recordCancellation']],
] as const) {
    test(name, async () => {
        const saved: OrderOutcome[] = [];
        const workflow = createOrderRoutingWorkflow(async outcome => { saved.push(outcome); return outcome; });
        const result = await workflow.run({ ...base, ...changes }, { pojo: true });
        assert.equal(result.status, status);
        assert.deepEqual(result.actions, actions);
        assert.equal(saved.length, 1);
        assert.equal(result.giftWrapped === true, name === 'gift order');
    });
}
test('unsupported event takes the explicit fallback without saving an outcome', async () => {
    let saves = 0;
    const workflow = createOrderRoutingWorkflow(async outcome => { saves++; return outcome; });
    await assert.rejects(workflow.run({ ...base, type: 'order.refunded' }, { pojo: true }), UnsupportedOrderEvent);
    assert.equal(saves, 0);
});
test('validation rejects bad amounts, identifiers, and optional flags', () => {
    validateOrderEvent(base);
    validateOrderEvent({ ...base, type: 'order.cancelled', amountCents: undefined });
    for (const changes of [{ amountCents: 0 }, { amountCents: 1.5 }, { eventId: '' }, { giftWrap: 'true' }]) {
        assert.throws(() => validateOrderEvent({ ...base, ...changes }));
    }
});
