import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryIdempotencyStore } from '@siglo/core';
import {
    createCheckoutWorkflow,
    createLegacyServices,
    imperativeCheckout,
    sampleCheckoutInput,
} from './migrate-one-endpoint';

test('migrate-one-endpoint: Siglo flow matches imperative checkout output and retry behavior', async () => {
    const before = createLegacyServices();
    const after = createLegacyServices();

    const imperativeResult = await imperativeCheckout(sampleCheckoutInput, before.services, 1);
    const sigloResult = await createCheckoutWorkflow(after.services, 1).run(sampleCheckoutInput, { pojo: true });

    assert.equal(sigloResult.orderId, imperativeResult.orderId);
    assert.equal(sigloResult.reservationId, imperativeResult.reservationId);
    assert.equal(sigloResult.paymentId, imperativeResult.paymentId);
    assert.equal(sigloResult.trackingId, imperativeResult.trackingId);
    assert.deepEqual(after.events, before.events);
});

test('migrate-one-endpoint: executes LIFO saga compensation (refund before release) when shipment fails', async () => {
    const { services, events } = createLegacyServices({ failShipment: true });
    const workflow = createCheckoutWorkflow(services, 1);

    await assert.rejects(
        workflow.run({ ...sampleCheckoutInput, orderId: 'ord_5002' }, { pojo: true }),
        /Courier service unavailable/,
    );

    assert.deepEqual(events, [
        'inventory.reserve(ord_5002, ergonomic-keyboard x1)',
        'payment.charge(ord_5002, 12900c) [attempt 1]',
        'payment.charge(ord_5002, 12900c) [attempt 2]',
        'shipping.dispatch(ord_5002, res_ord_5002, pay_ord_5002)',
        'payment.refund(pay_ord_5002)',
        'inventory.release(res_ord_5002)',
    ]);
});

test('migrate-one-endpoint: supports idempotency and Mermaid diagram generation out of the box', async () => {
    const { services, events } = createLegacyServices();
    const workflow = createCheckoutWorkflow(services, 1);
    const idempotencyStore = new InMemoryIdempotencyStore();

    const first = await workflow.run(sampleCheckoutInput, {
        pojo: true,
        idempotencyKey: `checkout:${sampleCheckoutInput.orderId}`,
        idempotencyStore,
    });
    const second = await workflow.run(sampleCheckoutInput, {
        pojo: true,
        idempotencyKey: `checkout:${sampleCheckoutInput.orderId}`,
        idempotencyStore,
    });

    assert.equal(second.trackingId, first.trackingId);
    assert.equal(events.filter(e => e.startsWith('inventory.reserve')).length, 1);

    const mermaid = workflow.toMermaid({ direction: 'TD' });
    assert.match(mermaid, /reserveStock/);
    assert.match(mermaid, /chargeCustomer/);
    assert.match(mermaid, /createShipment/);
});
