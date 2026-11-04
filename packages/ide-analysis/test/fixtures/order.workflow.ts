import { flow, Step } from 'siglo';
import { httpStep } from '@siglo/http';
import { sendNotificationStep } from '@siglo/notifications';
import { aiStep } from '@siglo/ai';

const stepFetchUser = Step.create('fetchUser', { retries: 2, timeoutMs: 3000 }, async () => {
  return { id: 'usr_123' };
});

const stepChargeCard = httpStep('chargeCard', {
  method: 'POST',
  url: 'https://api.stripe.com/v1/charges',
});

const stepSendEmail = sendNotificationStep('sendReceipt', {
  channel: 'email',
});

const stepAnalyzeFraud = aiStep('analyzeFraud', {
  provider: 'openai',
  model: 'gpt-4o',
});

const stepRefund = Step.create('refundCard', async () => {});

export const orderWorkflow = flow('orderWorkflow')
  .then(stepFetchUser)
  .then(stepChargeCard)
  .compensate(stepRefund)
  .parallel([stepSendEmail, stepAnalyzeFraud])
  .branch(
    (ctx: any) => ctx.isVip,
    Step.create('vipPerk', async () => {}),
    Step.create('standardPerk', async () => {})
  )
  .fallback(Step.create('handleOrderError', async () => {}));
