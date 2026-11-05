import { expect } from 'chai';
import { flow, Step } from '@siglo/core';
import { httpStep } from '../src/step';
import { createMockHttpServer } from '../src/testing/mock-agent';

describe('@siglo/http: Declarative Sagas & Compensation', () => {
  let mockServer: ReturnType<typeof createMockHttpServer>;

  beforeEach(() => {
    mockServer = createMockHttpServer();
  });

  afterEach(() => {
    mockServer.restore();
  });

  it('automatically rolls back external state via HTTP DELETE when downstream step fails', async () => {
    let refundExecuted = false;

    // 1. Charge mock
    mockServer.get('https://api.stripe.com').intercept({ path: '/v1/charges', method: 'POST' })
      .reply(200, { id: 'ch_12345', amount: 5000, status: 'succeeded' });

    // 2. Compensation refund mock
    mockServer.get('https://api.stripe.com').intercept({ path: '/v1/refunds', method: 'POST' })
      .reply(200, () => {
        refundExecuted = true;
        return { id: 're_12345', status: 'refunded' };
      });

    const processPayment = httpStep('processPayment', {
      url: 'https://api.stripe.com/v1/charges',
      method: 'POST',
      body: (ctx: any) => ({
        amount: ctx.amount,
        customer: ctx.customerId
      }),
      compensate: {
        url: 'https://api.stripe.com/v1/refunds',
        method: 'POST',
        headers: (ctx: any) => ({
          Authorization: `Bearer ${ctx.apiKey}`
        }),
        body: (ctx: any, res: any) => ({
          charge: res.id,
          reason: 'downstream_fulfillment_failed'
        })
      }
    });

    const fulfillInventory = Step.create('fulfillInventory', async () => {
      throw new Error('Warehouse inventory unavailable');
    });

    const orderWorkflow = flow(processPayment, fulfillInventory);

    try {
      await orderWorkflow.run({
        amount: 5000,
        customerId: 'cust_999',
        apiKey: 'sk_test_secret'
      });
      expect.fail('Expected workflow to fail and trigger compensation');
    } catch (err: any) {
      expect(err.message).to.include('Warehouse inventory unavailable');
      expect(refundExecuted).to.be.true;
    }
  });

  it('supports declarative .compensateWithHttp fluent chaining', async () => {
    let cancelExecuted = false;

    // Booking mock
    mockServer.get('https://api.airline.com').intercept({ path: '/bookings', method: 'POST' })
      .reply(200, { bookingId: 'BK-789' });

    // Compensation DELETE mock
    mockServer.get('https://api.airline.com').intercept({ path: '/bookings/BK-789', method: 'DELETE' })
      .reply(200, () => {
        cancelExecuted = true;
        return { cancelled: true };
      });

    const bookFlight = httpStep('bookFlight', {
      url: 'https://api.airline.com/bookings',
      method: 'POST',
      body: { flight: 'AA100' }
    }).compensateWithHttp({
      url: (ctx: any, res: any) => `https://api.airline.com/bookings/${res.bookingId}`,
      method: 'DELETE',
      headers: { 'X-Reason': 'workflow_aborted' }
    });

    const nextStep = Step.create('nextFailingStep', () => {
      throw new Error('Seat assignment failed');
    });

    const flightWorkflow = flow(bookFlight, nextStep);

    try {
      await flightWorkflow.run({});
      expect.fail('Expected flightWorkflow to fail');
    } catch (err: any) {
      expect(err.message).to.include('Seat assignment failed');
      expect(cancelExecuted).to.be.true;
    }
  });

  it('does not execute compensation when workflow succeeds', async () => {
    let deleteCalled = false;

    mockServer.get('https://api.example.com').intercept({ path: '/resource', method: 'POST' })
      .reply(200, { id: 'res_1' });

    mockServer.get('https://api.example.com').intercept({ path: '/resource/res_1', method: 'DELETE' })
      .reply(200, () => {
        deleteCalled = true;
        return { ok: true };
      });

    const createResource = httpStep('createResource', {
      url: 'https://api.example.com/resource',
      method: 'POST',
      compensate: {
        url: (ctx: any, res: any) => `https://api.example.com/resource/${res.id}`,
        method: 'DELETE'
      }
    });

    const successStep = Step.create('successStep', (ctx: any) => ({
      finished: true
    }));

    const workflow = flow(createResource, successStep);
    const result = await workflow.run({});

    expect(result.id).to.equal('res_1');
    expect(result.finished).to.be.true;
    expect(deleteCalled).to.be.false;
  });
});
