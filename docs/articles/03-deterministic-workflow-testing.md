---
title: 'Testing Retries, Timeouts, and Sagas in Under 5ms with Virtual Clocks'
description: 'Deterministic workflow testing with createWorkflowHarness, FakeClock, spyStep, injectEvent, and PII-redacted replayExecution in @siglo/testing.'
---

# Testing Retries, Timeouts, and Sagas in `<5ms` with Virtual Clocks (`@siglo/testing`)

Why do most backend teams skip testing their retry loops, webhook suspensions, and Saga rollback handlers?

Because in traditional services, testing failure recovery is slow, brittle, and invasive:

- Testing a 3-attempt exponential backoff means either waiting seconds of wall-clock time in CI or monkey-patching global `setTimeout`.
- Testing what happens when step 3 of a 4-step pipeline fails requires mocking global HTTP clients or mutating dependency-injected singletons.
- Reproducing a production bug locally requires manually reconstructing intermediate database states while hoping you don't leak customer PII or API keys into test fixtures.

When we built [**Siglo**](https://github.com/jsoftgem/siglo), we designed `@siglo/testing` so that **every workflow resilience feature—retries, Saga compensations, durable event suspensions, and production trace replays—can be tested deterministically in under 5 milliseconds**.

Here is how `createWorkflowHarness`, `FakeClock`, `spyStep`, and `replayExecution` work together.

---

## 1. Selective Step Mocking and Spying (`createWorkflowHarness`)

Suppose we have a 3-step checkout pipeline:

```typescript
import { Step, flow } from '@siglo/core';

const reserveInventory = Step.create('reserveInventory', async ({ orderId }: { orderId: string; amount: number }) => ({
    reservationId: `res_${orderId}`,
})).compensate(async ctx => {
    await inventoryService.release(ctx.reservationId);
});

const chargeCard = Step.create('chargeCard', async ({ amount }: { amount: number }) => ({
    chargeId: await paymentGateway.charge(amount),
}))
    .onFail({ maxRetries: 3, backoff: 'exponential', delay: 10 })
    .compensate(async ctx => {
        await paymentGateway.refund(ctx.chargeId);
    });

const shipOrder = Step.create('shipOrder', async ({ orderId, reservationId }) => ({
    trackingId: await shippingService.dispatch(orderId, reservationId),
}));

export const checkoutFlow = flow(reserveInventory, chargeCard, shipOrder);
```

With `createWorkflowHarness`, you don't need module-level mocks (`vi.mock` or `sinon.stub`) to simulate a flaky payment gateway or a downstream shipping outage. You can mock or spy on individual named steps while letting the rest of the pipeline run untouched:

```typescript
import { expect } from 'chai';
import { createWorkflowHarness } from '@siglo/testing';
import { checkoutFlow } from './checkout';

it('retries a flaky payment gateway and completes checkout', async () => {
    const harness = createWorkflowHarness(checkoutFlow);

    let attempts = 0;
    harness.mockStep('chargeCard', async ({ amount }) => {
        attempts++;
        if (attempts < 2) {
            throw new Error('503 Payment Gateway Timeout');
        }
        return { chargeId: `ch_recovered_${amount}` };
    });

    const shipSpy = harness.spyStep('shipOrder');

    const result = await harness.run({ orderId: 'ord_42', amount: 9900 });

    // Built-in trace assertions
    harness.assertStepExecuted('reserveInventory', 1);
    harness.assertStepExecuted('chargeCard', 1);
    harness.assertStepExecuted('shipOrder', 1);

    // Inspect exact inputs/outputs captured by StepSpy
    expect(shipSpy.called).to.be.true;
    expect(shipSpy.firstCall()?.input.reservationId).to.equal('res_ord_42');
    expect(result.chargeId).to.equal('ch_recovered_9900');
});
```

Under the hood, `WorkflowHarness` clones the workflow steps, attaches an isolated `InMemoryStorageFake` and `FakeClock`, and records a structured `StepTraceRecord` (`start`, `retry`, `complete`, `fail`, `skip`) for every execution phase.

---

## 2. Deterministic Virtual Time (`FakeClock`)

When testing time-dependent workflows—such as audit timestamps, SLA expirations, or scheduled checkpoints—relying on `Date.now()` leads to flaky assertions.

`@siglo/testing` provides `FakeClock`, which starts at a fixed epoch (or `Date.now()`) and advances only when you call `clock.advanceTime(ms)` or `await clock.tick(ms)`:

```typescript
import { createWorkflowHarness, FakeClock } from '@siglo/testing';

it('records deterministic step timestamps across virtual time', async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const harness = createWorkflowHarness(checkoutFlow, { clock });

    harness.mockStep('chargeCard', async () => {
        clock.advanceTime(250); // Simulate 250ms gateway latency in 0ms wall time
        return { chargeId: 'ch_1' };
    });

    harness.mockStep('shipOrder', async () => {
        clock.advanceTime(120); // Simulate 120ms carrier API latency in 0ms wall time
        return { trackingId: 'trk_1' };
    });

    await harness.run({ orderId: 'ord_1', amount: 5000 });

    const trace = harness.getTrace();
    const chargeStart = trace.find(t => t.stepName === 'chargeCard' && t.phase === 'start')!;
    const chargeEnd = trace.find(t => t.stepName === 'chargeCard' && t.phase === 'complete')!;

    expect(chargeEnd.timestamp - chargeStart.timestamp).to.equal(250);
});
```

---

## 3. Testing Webhook Suspensions (`injectEvent`)

If your workflow uses `waitForEvent` to pause for an external webhook or human approval, you don't need to spin up an HTTP server in your unit tests. `harness.injectEvent()` resumes the suspended workflow directly in memory:

```typescript
import { Step, flow, waitForEvent, WorkflowSuspendedException } from '@siglo/core';
import { createWorkflowHarness } from '@siglo/testing';

const approvalFlow = flow(
    Step.create('createDraft', async ({ orderId }: { orderId: string }) => ({ status: 'DRAFT', orderId })),
    waitForEvent<{ approvedBy: string }>('order.approved', {
        correlationKey: ctx => `approval:${ctx.orderId}`,
    }),
    Step.create('finalizeOrder', async ({ orderId, approvedBy }) => ({
        status: 'FINALIZED',
        approvedBy,
    })),
);

it('suspends at waitForEvent and resumes via injectEvent', async () => {
    const harness = createWorkflowHarness(approvalFlow);

    // 1. Initial run suspends at waitForEvent
    try {
        await harness.run({ orderId: 'ord_77' }, { durable: true });
    } catch (err) {
        expect(err).to.be.instanceOf(WorkflowSuspendedException);
    }

    // 2. Inject the webhook payload directly by correlation key
    const resumed = await harness.injectEvent('order.approved', 'approval:ord_77', {
        approvedBy: 'director@acme.com',
    });

    expect(resumed.status).to.equal('FINALIZED');
    expect(resumed.approvedBy).to.equal('director@acme.com');
});
```

---

## 4. Exporting Redacted Production Traces & Replaying Locally (`replayExecution`)

When an edge-case failure happens in staging or production, how do you turn it into a regression test without copying sensitive user credentials?

`harness.exportExecutionRecord()` (and `sanitizeExecutionRecord()`) automatically scrubs sensitive keys (`password`, `token`, `secret`, `authorization`, `apiKey`, `creditCard`, `cvv`, `ssn`, `privateKey`, plus any custom `excludeKeys`) into `'[REDACTED]'`:

```typescript
// Export a sanitized execution record safe to commit to git fixtures
const record = harness.exportExecutionRecord({
    excludeKeys: ['customerEmail'],
});

// Later, in your regression test suite:
import { replayExecution } from '@siglo/testing';

it('reproduces and verifies the fix against the recorded trace', async () => {
    const replay = await replayExecution(record, checkoutFlow, {
        substituteFixtures: {
            chargeCard: { chargeId: 'ch_replayed_fixture' },
        },
    });

    expect(replay.matched).to.be.true;
    expect(replay.discrepancies).to.be.empty;
});
```

`replayExecution` strips ephemeral runtime metadata (`stackId`, `$stepId`, `$history`), substitutes deterministic fixtures for external I/O steps, runs the current workflow code against the recorded input, and reports any structural diffs in `replay.discrepancies`.

---

## Try `@siglo/testing`

```bash
npm install @siglo/core @siglo/testing
```

- **Testing & Replay Guide**: [Testing and Replay](/09-testing-and-replay)
- **Source Code**: [`packages/testing/src/index.ts`](https://github.com/jsoftgem/siglo/blob/main/packages/testing/src/index.ts)
