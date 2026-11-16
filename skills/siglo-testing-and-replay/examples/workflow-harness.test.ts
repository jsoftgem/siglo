import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Step, flow } from '@siglo/core';
import { createWorkflowHarness, FakeClock } from '@siglo/testing';

// Sample Workflow Under Test
const stepA = Step.create('validateCustomer', (input: { customerId: string }) => {
    if (!input.customerId) throw new Error('Missing customerId');
    return { customerTier: 'PREMIUM' };
});

const stepB = Step.create('chargeCustomer', async (ctx: { customerTier: string; amount: number }) => {
    // In real life this calls Stripe / payment gateway
    return { transactionId: 'tx_live_123' };
})
    .onFail({
        maxRetries: 2,
        delay: 50,
        backoff: 'fixed',
    })
    .compensate(async ({ transactionId }) => {
        // Refund on rollback
    });

const stepC = Step.create('generateInvoice', async (ctx: { transactionId: string }) => {
    return { invoicePdfUrl: `https://invoices.example.com/${ctx.transactionId}.pdf` };
});

const billingWorkflow = flow(stepA, stepB, stepC);

describe('Billing Workflow with Siglo Test Harness', () => {
    test('executes full pipeline successfully with mocked payment', async () => {
        const harness = createWorkflowHarness(billingWorkflow);

        // Mock payment step to return mock transactionId
        harness.mockStep('chargeCustomer', async param => {
            assert.equal(param.customerTier, 'PREMIUM');
            return { transactionId: 'tx_mock_999' };
        });

        const spyInvoice = harness.spyStep('generateInvoice');

        const result = await harness.run({ customerId: 'cust-101', amount: 50 });

        assert.equal(result.customerTier, 'PREMIUM');
        assert.equal(result.transactionId, 'tx_mock_999');
        assert.equal(result.invoicePdfUrl, 'https://invoices.example.com/tx_mock_999.pdf');

        // Harness Assertions
        harness.assertStepExecuted('validateCustomer', 1);
        harness.assertStepExecuted('chargeCustomer', 1);
        harness.assertStepExecuted('generateInvoice', 1);

        // Spy assertions
        assert.equal(spyInvoice.called, true);
        assert.equal(spyInvoice.callCount, 1);
        assert.equal(spyInvoice.firstCall()?.input.transactionId, 'tx_mock_999');
    });

    test('asserts retry attempts when transient failure occurs', async () => {
        const clock = new FakeClock(1000);
        const harness = createWorkflowHarness(billingWorkflow, { clock });

        let attempts = 0;
        harness.mockStep('chargeCustomer', async () => {
            attempts++;
            if (attempts === 1) {
                throw new Error('Temporary 503 from gateway');
            }
            return { transactionId: 'tx_recovered' };
        });

        const result = await harness.run({ customerId: 'cust-101', amount: 50 });

        assert.equal(result.transactionId, 'tx_recovered');
        harness.assertStepRetried('chargeCustomer', 2);
    });

    test('records step failure when error is permanent', async () => {
        const harness = createWorkflowHarness(billingWorkflow);

        await assert.rejects(harness.run({ customerId: '' }), /Missing customerId/);

        harness.assertStepFailed('validateCustomer', /Missing customerId/);
    });
});
