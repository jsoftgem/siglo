import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { clearStorage, defaultDurableManager, resumeWorkflow } from '@siglo/core';
import { createDemoServices, sampleOrder } from '../getting-started/checkout-demo';
import { createDurableCheckout } from './checkout-durable';

function reset() {
    clearStorage();
    defaultDurableManager.clear();
}
beforeEach(reset);
afterEach(reset);

test('checkout retries payment, suspends before shipping, and resumes with persisted provider IDs', async () => {
    const { services, events } = createDemoServices();
    const workflow = createDurableCheckout(services);
    const waiting = (await workflow.run(sampleOrder, { durable: true, pojo: true })) as unknown as {
        status: string;
        correlationKey: string;
    };
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.correlationKey, `order:${sampleOrder.orderId}`);
    assert.deepEqual(events, ['reserve stock', 'charge attempt 1', 'charge attempt 2']);
    const result = await resumeWorkflow(
        workflow,
        waiting.correlationKey,
        { approved: true, approverId: 'tester' },
        { pojo: true },
    );
    assert.equal(result.status, 'confirmed');
    assert.equal(result.trackingId, `tracking-${sampleOrder.orderId}`);
    assert.equal(result.paymentId, `payment-${sampleOrder.orderId}`);
    assert.equal(result.reservationId, `reservation-${sampleOrder.orderId}`);
    assert.equal(result.approvedBy, 'tester');
    assert.equal(events.filter(event => event === 'arrange shipping').length, 1);
    await assert.rejects(resumeWorkflow(workflow, waiting.correlationKey, { approved: true }));
    assert.equal(events.filter(event => event === 'arrange shipping').length, 1);
});

test('a rejected approval refunds the charge and releases the reservation before failing', async () => {
    const { services, events } = createDemoServices();
    const workflow = createDurableCheckout(services);
    const waiting = (await workflow.run(sampleOrder, { durable: true, pojo: true })) as unknown as {
        status: string;
        correlationKey: string;
    };
    await assert.rejects(
        resumeWorkflow(workflow, waiting.correlationKey, { approved: false, approverId: 'tester' }),
        /Order rejected by reviewer/,
    );
    assert.deepEqual(events.slice(-2), ['refund payment', 'release stock']);
    assert.ok(!events.includes('arrange shipping'));
});

test('competing approval deliveries ship once and preserve the accepted decision', async () => {
    const { services, events } = createDemoServices();
    const workflow = createDurableCheckout(services);
    const waiting = (await workflow.run(sampleOrder, { durable: true, pojo: true })) as unknown as {
        correlationKey: string;
    };
    const deliveries = await Promise.allSettled([
        resumeWorkflow(workflow, waiting.correlationKey, { approved: true, approverId: 'first' }, { pojo: true }),
        resumeWorkflow(workflow, waiting.correlationKey, { approved: true, approverId: 'duplicate' }, { pojo: true }),
    ]);
    assert.equal(deliveries.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(deliveries.filter(result => result.status === 'rejected').length, 1);
    assert.equal(events.filter(event => event === 'arrange shipping').length, 1);
    assert.equal(events.filter(event => event === 'charge attempt 2').length, 1);
});
