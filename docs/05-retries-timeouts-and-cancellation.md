# 05. Retries, Timeouts, and Cancellation

Enterprise systems encounter network hiccups, slow external services, and user cancellations. `Rivulet` provides built-in fault tolerance without requiring external cron daemons.

---

## 1. Retry Policies and Exponential Backoff

Declare retry logic per-step via `.onFail(RetryConfig)`:

```typescript
import { Step } from 'rivulet';

export const callPaymentGateway = Step.create('callGateway', async (param: any) => {
    return await api.chargeCustomer(param);
})
.onFail({
    maxRetries: 3,
    backoff: 'exponential', // 'fixed', 'linear', 'exponential', or custom fn
    delay: 200,            // Base delay in ms
    maxDelay: 5000,        // Cap maximum backoff delay
    jitter: true,          // Add random jitter to prevent thundering herd
    retryIf: (err, attempt) => {
        // Only retry on network errors or 5xx server codes
        return err.status >= 500 || err.code === 'ECONNRESET';
    },
    onRetry: (err, attempt, delayMs) => {
        console.warn(`Retry attempt #${attempt} scheduled after ${delayMs}ms due to: ${err.message}`);
    }
});
```

---

## 2. Timeouts

### Step-Level Timeouts
Enforce execution deadlines on individual steps:
```typescript
const querySlowDatabase = Step.create('queryDb', async () => {
    return await db.heavyAnalytics();
}).timeout(2500); // Fails with StepTimeoutException if exceeds 2.5s
```

### Workflow-Level Timeouts
Enforce end-to-end deadlines across the entire workflow sequence:
```typescript
import { flow } from 'rivulet';

const checkoutWorkflow = flow(step1, step2, step3).timeout(10000); // 10s end-to-end deadline
```

---

## 3. Cooperative Cancellation with `AbortSignal`

Pass an `AbortController.signal` into `workflow.run()`:

```typescript
const controller = new AbortController();

setTimeout(() => {
    controller.abort(new Error('User clicked cancel'));
}, 3000);

try {
    await workflow.run({ orderId: '123' }, { signal: controller.signal });
} catch (err: any) {
    console.log(err.name); // 'CancellationException'
}
```

Steps can access the active abort signal via `param.$signal`:
```typescript
const downloadFile = Step.create('download', async (param: any) => {
    const signal = param.$signal;
    return await fetch('https://example.com/file', { signal });
});
```

---

## 4. Sagas and Compensating Transactions

When a multi-step transaction fails midway, `Rivulet` automatically executes registered compensation handlers in reverse (LIFO) order:

```typescript
import { Step, flow } from 'rivulet';

const reserveHotel = Step.create('reserveHotel', async () => {
    const booking = await hotelApi.book();
    return { hotelBookingId: booking.id };
})
.compensate(async (ctx) => {
    // Automatic rollback if subsequent steps fail
    await hotelApi.cancel(ctx.hotelBookingId);
});

const reserveFlight = Step.create('reserveFlight', async () => {
    const flight = await flightApi.book();
    return { flightBookingId: flight.id };
})
.compensate(async (ctx) => {
    await flightApi.cancel(ctx.flightBookingId);
});

const chargeCard = Step.create('chargeCard', async () => {
    throw new Error('Credit card declined'); // Triggers saga compensation!
});

export const travelBookingSaga = flow(reserveHotel, reserveFlight, chargeCard);
```

---

## Minimal Example

```typescript
import { Step, flow } from 'rivulet';

let attempts = 0;
const flaky = Step.create('flaky', async () => {
    attempts++;
    if (attempts < 2) throw new Error('Network timeout');
    return { recovered: true };
}).onFail({ maxRetries: 3, delay: 50 });

const wf = flow(flaky);
const res = await wf.run();
console.log(res.recovered); // true
```

---

## Failure Example: Exceeded Retries & Compensation Diagnostics

```typescript
import { Step, flow, CompensationException } from 'rivulet';

const step1 = Step.create('step1', () => ({ ok: true }))
    .compensate(async () => {
        throw new Error('Compensation network error');
    });

const step2 = Step.create('step2', () => {
    throw new Error('Step 2 failed');
});

const sagaFlow = flow(step1, step2);

try {
    await sagaFlow.run();
} catch (err: any) {
    if (err instanceof CompensationException) {
        console.error('Original Error:', err.originalError.message);
        console.error('Failed Compensations:', err.compensationErrors);
    }
}
```

---

## Testing Example

```typescript
import { expect } from 'chai';
import { createWorkflowHarness } from '@rivulet/testing';
import { Step, flow } from 'rivulet';

let calls = 0;
const step = Step.create('apiCall', () => {
    calls++;
    if (calls < 3) throw new Error('Rate limit');
    return { status: 200 };
}).onFail({ maxRetries: 3, delay: 10 });

const testWf = flow(step);

describe('Retry Fault Tolerance Suite', () => {
    it('retries until success and verifies attempt count', async () => {
        const harness = createWorkflowHarness(testWf);
        const result = await harness.run();

        expect(result.status).to.equal(200);
        harness.assertStepRetried('apiCall', 2);
    });
});
```

---

## Operational Caveats

1. **Compensations Must Be Idempotent**: Compensation handlers may be retried if network interruptions occur during rollback. Ensure cleanup functions (e.g., refunding payments) can be called multiple times safely.
2. **Backoff Jitter**: Always enable `jitter: true` on retries targeting shared downstream dependencies to prevent synchronized waves of retry requests.

---

## API Reference Links

- [Core Concepts Guide](./02-core-concepts.md)
- [Durable Workflows](./06-durable-workflows.md)
- [Testing & Replay Reference](./09-testing-and-replay.md)
