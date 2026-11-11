import { flow, Step, waitForEvent, branch } from '@siglo/core';
import { httpStep } from '@siglo/http';
import { encryptFieldsStep } from '@siglo/crypto';

// 1. Duplicate step IDs within the same workflow
const stepFetch = Step.create('fetchUser', () => {});
const duplicateFetch = Step.create('fetchUser', () => {});

// 2. Saga side-effect step missing compensation
const chargeCard = httpStep('chargeCard', { method: 'POST', url: 'https://api.stripe.com/charges' });
const encryptPayload = encryptFieldsStep('encryptPayload', { fields: ['cardNumber'] });
const refundCard = Step.create('refundCard', () => {});

// 3. Durable unhandled error branch (branch without default/fallback route)
const awaitApproval = waitForEvent('order.approved', { timeout: '24h' });
const priorityRouter = branch(ctx => ctx.priority, {
    HIGH: Step.create('expediteOrder', () => {}),
    NORMAL: Step.create('standardShip', () => {}),
});

export const orderDiagnosticsWorkflow = flow('orderDiagnosticsWorkflow')
    .then(stepFetch)
    .then(duplicateFetch)
    .then(chargeCard)
    .compensate(refundCard)
    .then(encryptPayload)
    .then(awaitApproval)
    .then(priorityRouter);
