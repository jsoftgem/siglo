import { flow, Step, parallel, branch } from '@siglo/core';
import { httpStep } from '@siglo/http';
import { sendNotificationStep } from '@siglo/notifications';
import { aiStep } from '@siglo/ai';
import { verifyWebhookStep } from '@siglo/crypto';

const stepVerifySignature = verifyWebhookStep('verifyOrderSignature', {
  provider: 'stripe',
  secret: 'whsec_test',
  payload: (ctx: any) => ctx.rawBody,
  signature: (ctx: any) => ctx.headers?.['stripe-signature'],
});

const stepFetchUser = Step.create('fetchUser', async () => {
  return { id: 'usr_123' };
})
  .timeout(3000)
  .onFail({ maxRetries: 2 });

const stepRefund = Step.create('refundCard', async () => {});

const stepChargeCard = httpStep('chargeCard', {
  method: 'POST',
  url: 'https://api.stripe.com/v1/charges',
}).compensate(stepRefund);

const stepSendEmail = sendNotificationStep('sendReceipt', {
  channel: 'email',
  recipient: 'customer@example.com',
  template: 'order-receipt',
});

const stepAnalyzeFraud = aiStep('analyzeFraud', {
  model: {
    provider: 'openai',
    model: 'gpt-4o',
  },
  prompt: 'Analyze fraud risk for order',
});

export const orderWorkflow = flow(
  stepVerifySignature,
  stepFetchUser,
  stepChargeCard,
  parallel(stepSendEmail, stepAnalyzeFraud),
  branch(
    (ctx: any) => (ctx.isVip ? 'vip' : 'standard'),
    {
      vip: Step.create('vipPerk', async () => {}),
      standard: Step.create('standardPerk', async () => {}),
    },
  ),
);
