// Screenshot fixture: analyzed as source, never executed or imported.
import { Step, flow, parallel } from '@siglo/core';
import { httpStep } from '@siglo/http';
import { sendNotificationStep } from '@siglo/notifications';

const validateOrder = Step.create('validateOrder', async (input: any) => input)
    .spec('orderId', { require: true, requireMessage: 'An order ID is required.' })
    .spec('email', { require: true, transform: (value: string) => value.trim().toLowerCase() })
    .spec('currency', { default: 'PHP' })
    .spec('quantity', { validate: (value: number) => value > 0 })
    .timeout(1000);

const reserveInventory = Step.create('reserveInventory', { retries: 2, timeoutMs: 3000 }, async () => ({}));
const authorizePayment = httpStep('authorizePayment', {
    method: 'POST',
    url: 'https://api.payments.example.com/v1/charge',
    maxRetries: 3,
    timeoutMs: 5000,
});
const confirmOrder = Step.create('confirmOrder', async () => ({}));

export const checkoutWorkflow = flow(validateOrder, parallel(reserveInventory, authorizePayment), confirmOrder)
    .timeout(15000)
    .version('v1.0')
    .networkPolicy({
        defaultPolicy: 'deny',
        allowedHosts: ['api.payments.example.com', 'inventory.example.com'],
        allowLocalhost: false,
    });

const composeReceipt = Step.create('composeReceipt', async () => ({}));
const deliverReceipt = sendNotificationStep('deliverReceipt', { channel: 'email', template: 'tpl_receipt_v1' });
export const receiptWorkflow = flow(composeReceipt, deliverReceipt).timeout(5000).version('v1.0');
