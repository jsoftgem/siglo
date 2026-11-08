import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKafkaMessageHandler } from '@siglo/kafka';
import { createRoutingWorkflow, type RoutingOutcome } from './routing';

for (const [scenario, amountCents, giftWrap, status, actions] of [
    ['standard', 5000, false, 'shipped', ['reserveStock', 'chargePayment', 'shipOrder']],
    ['gift', 5000, true, 'shipped', ['reserveStock', 'chargePayment', 'wrapGift', 'shipOrder']],
    ['below-review', 99999, false, 'shipped', ['reserveStock', 'chargePayment', 'shipOrder']],
    ['review', 100000, true, 'review-required', ['queueReview']],
] as const) {
    test(`Kafka adapter routes ${scenario} orders and reports only the expected actions`, async () => {
        const outcomes: RoutingOutcome[] = [];
        const handler = createKafkaMessageHandler(
            createRoutingWorkflow(result => {
                outcomes.push(result);
            }),
            {
                input: message => JSON.parse(String(message.value)),
            },
        );
        await handler({
            topic: 'signed-order-intake.orders',
            partition: 0,
            message: {
                offset: '0',
                value: Buffer.from(
                    JSON.stringify({
                        eventId: 'test-event',
                        orderId: 'test-order',
                        tenant: 'shop-demo',
                        type: 'order.placed',
                        amountCents,
                        giftWrap,
                    }),
                ),
            },
        });
        assert.deepEqual(outcomes, [{ eventId: 'test-event', status, actions: [...actions] }]);
    });
}
test('unsupported events fail before recording a fulfillment outcome', async () => {
    const outcomes: RoutingOutcome[] = [];
    await assert.rejects(
        createRoutingWorkflow(result => {
            outcomes.push(result);
        }).run({ type: 'order.refunded' }),
    );
    assert.deepEqual(outcomes, []);
});
