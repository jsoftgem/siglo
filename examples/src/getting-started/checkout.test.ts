import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryIdempotencyStore } from '@siglo/core';
import { createCheckout } from './checkout';
import { createDemoServices, sampleOrder } from './checkout-demo';

test('retries payment without reserving stock twice', async () => {
    const { services, events } = createDemoServices();
    const result = await createCheckout(services).run(sampleOrder, { pojo: true });

    assert.equal(result.trackingId, 'tracking-order-1001');
    assert.equal(result.reservationId, 'reservation-order-1001');
    assert.deepEqual(events, ['reserve stock', 'charge attempt 1', 'charge attempt 2', 'arrange shipping']);
});

test('refunds payment before releasing stock when shipping fails', async () => {
    const { services, events } = createDemoServices(true);

    await assert.rejects(createCheckout(services).run(sampleOrder, { pojo: true }), /No courier available/);
    assert.deepEqual(events, [
        'reserve stock',
        'charge attempt 1',
        'charge attempt 2',
        'arrange shipping',
        'refund payment',
        'release stock',
    ]);
});

test('rejects invalid orders before calling services', async () => {
    const { services, events } = createDemoServices();
    await assert.rejects(
        createCheckout(services).run({ ...sampleOrder, quantity: 0 }, { pojo: true }),
        /positive quantity/,
    );
    assert.deepEqual(events, []);
});

test('does not retry a permanent payment failure and releases stock', async () => {
    const { services, events } = createDemoServices();
    services.charge = async () => {
        events.push('card declined');
        throw new Error('Card declined');
    };
    await assert.rejects(createCheckout(services).run(sampleOrder, { pojo: true }), /Card declined/);
    assert.deepEqual(events, ['reserve stock', 'card declined', 'release stock']);
});

test('returns the completed result for a duplicate checkout request', async () => {
    const { services, events } = createDemoServices();
    const checkout = createCheckout(services);
    const options = {
        pojo: true,
        idempotencyKey: `checkout:${sampleOrder.orderId}`,
        idempotencyStore: new InMemoryIdempotencyStore(),
    };
    const first = await checkout.run(sampleOrder, options);
    const second = await checkout.run(sampleOrder, options);

    assert.equal(second.trackingId, first.trackingId);
    assert.equal(events.filter(event => event === 'reserve stock').length, 1);
    assert.equal(events.filter(event => event === 'arrange shipping').length, 1);
});
