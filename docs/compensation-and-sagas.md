# Compensation and Sagas

Distributed workflows frequently require undoing partial side effects when a downstream step fails (the Saga Pattern). `Siglo` v1.0.0 provides first-class support for forward execution with automatic backward compensation.

---

## 1. Registering Compensations (`step.compensate()`)

Compensations are attached directly to steps that produce external side effects:

```typescript
import { Step, flow } from '@siglo/core';

// Step 1: Reserve Inventory (with compensation)
const reserveInventory = Step.create('reserveInventory', async ({ item, quantity }) => {
  const reservation = await inventoryService.reserve(item, quantity);
  return { reservationId: reservation.id };
})
  .compensate(async (output, input) => {
    await inventoryService.releaseReservation(output.reservationId);
  });

// Step 2: Authorize Payment (with compensation)
const authorizePayment = Step.create('authorizePayment', async ({ amount }) => {
  const charge = await paymentGateway.charge(amount);
  return { chargeId: charge.id };
})
  .compensate(async (output) => {
    await paymentGateway.refund(output.chargeId);
  });

// Step 3: Dispatch Delivery (Fails!)
const dispatchDelivery = Step.create('dispatchDelivery', async () => {
  throw new Error('No courier available');
});

const orderSaga = flow(reserveInventory, authorizePayment, dispatchDelivery);

try {
  await orderSaga.execute({ item: 'laptop', quantity: 1, amount: 1200 });
} catch (err) {
  // Compensation is executed automatically in reverse order:
  // 1. authorizePayment compensation runs (refund charge)
  // 2. reserveInventory compensation runs (release reservation)
}
```

---

## 2. Execution Semantics (LIFO)

- **Reverse Order (LIFO)**: Compensations execute in exact reverse order of step completion.
- **Input and Output Accessibility**: Compensation handlers receive both the completed step's `output` and original `input`.
- **Targeted Triggering**: Compensations only run for steps that successfully completed prior to the point of failure.
- **Full Lifecycle & Reducer Support**: Both standard single-action steps and array `.reduce()` steps register compensations with the saga manager.
- **Fault-Tolerant Payload Mapping**: User-supplied `compensationPayloadMapper` functions are executed safely without halting workflow resolution on mapping errors.

---

## 3. Compensation Retry Policy

Compensations can be configured with exponential backoff and retry limits:

```typescript
step.compensate(releaseInventory, {
  maxRetries: 3,
  delay: 1000,
  retryIf: (err, attempt) => err.code !== 'FATAL_RECORD_NOT_FOUND'
});
```

---

## 4. Handling Compensation Failures (`CompensationException`)

If one or more compensations fail and exhaust all retries, `Siglo` throws a `CompensationException`:

```typescript
import { CompensationException } from '@siglo/core';

try {
  await orderSaga.execute(payload);
} catch (err) {
  if (err instanceof CompensationException) {
    console.error('Original failure:', err.originalError);
    console.error('Failed compensations:', err.compensationErrors);
    console.error('Completed compensations:', err.completedCompensations);
  }
}
```

---

## 5. Manual Sagas and Compensation Restarts

Compensations can also be triggered or resumed manually via `flow.compensate(stackId)`:

```typescript
const result = await orderSaga.compensate('stack-123-uuid');
console.log('Compensated steps:', result.completed);
```
