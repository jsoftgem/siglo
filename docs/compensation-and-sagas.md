---
title: 'Compensation and Sagas'
description: 'Saga pattern implementation in Siglo: automatic LIFO rollback, inline closures, named persistent handlers, retry policies, strict vs best-effort execution, and abandoned stack reconciliation.'
---

Distributed workflows frequently require undoing partial side effects when a downstream step fails (the Saga Pattern). `Siglo` provides first-class support for forward execution with automatic backward compensation.

---

## 1. Core Saga Pattern & Automatic LIFO Rollback

Compensations execute in **exact reverse order (LIFO)** of step completion. Only steps that completed successfully prior to the point of failure are compensated.

```typescript
import { Step, flow } from '@siglo/core';

// Step 1: Reserve Inventory (with compensation)
const reserveInventory = Step.create(
    'reserveInventory',
    async (input: { item: string; quantity: number; amount: number }) => {
        const reservation = await inventoryService.reserve(input.item, input.quantity);
        // Forward original input along with step output for downstream steps
        return { ...input, reservationId: reservation.id };
    },
).compensate(async (output, input) => {
    // output contains step output, input contains original step input
    await inventoryService.releaseReservation(output.reservationId);
});

// Step 2: Authorize Payment (with compensation)
const authorizePayment = Step.create('authorizePayment', async (input: { amount: number; reservationId: string }) => {
    const charge = await paymentGateway.charge(input.amount);
    return { ...input, chargeId: charge.id };
}).compensate(async output => {
    await paymentGateway.refund(output.chargeId);
});

// Step 3: Dispatch Delivery (Fails!)
const dispatchDelivery = Step.create('dispatchDelivery', async () => {
    throw new Error('No courier available');
});

const orderSaga = flow(reserveInventory, authorizePayment, dispatchDelivery);

try {
    await orderSaga.run({ item: 'laptop', quantity: 1, amount: 1200 });
} catch (err: any) {
    // If all compensations succeed, Siglo re-throws the original forward error:
    console.error(err.message); // "No courier available"

    // Compensations executed automatically in reverse order:
    // 1. authorizePayment compensation runs (refund charge)
    // 2. reserveInventory compensation runs (release reservation)
}
```

---

## 2. Compensation Registration Patterns

Siglo supports both inline closures and decoupled named compensation handlers.

### A. Inline Closures (In-Memory Sagas)

Suitable for single-process, short-lived workflows:

```typescript
step.compensate(async (output, input) => {
    await service.rollback(output.id);
});
```

### B. Named Handlers & Global Registry (Durable & Multi-Process Sagas)

When workflows are persisted to storage (PostgreSQL, Redis) across service restarts or code deployments, JavaScript closures cannot be serialized. Register named handlers at application startup:

```typescript
import { Step, registerCompensationHandler } from '@siglo/core';

// 1. Register named handlers globally at service bootstrap
registerCompensationHandler('inventory:releaseReservation', async (payload, input) => {
    await inventoryService.releaseReservation(payload.reservationId);
});

registerCompensationHandler('payment:refundCharge', async payload => {
    await paymentGateway.refund(payload.chargeId);
});

// 2. Attach named compensations to steps with optional payload mappers
const reserveInventory = Step.create('reserveInventory', async input => {
    const reservation = await inventoryService.reserve(input.item, input.quantity);
    return { reservationId: reservation.id };
})
    // Syntax: .compensate(handlerName, payloadMapper?, options?)
    .compensate(
        'inventory:releaseReservation',
        (output, input) => ({
            reservationId: output.reservationId,
        }),
        { maxRetries: 2 },
    );
```

---

## 3. Compensation Retry Policy

Transient failures during compensation can be retried with fixed delays or custom conditional predicates:

```typescript
step.compensate('payment:refundCharge', {
    maxRetries: 3,
    delay: 1000, // ms between retries
    retryIf: (err, attempt) => err.code !== 'FATAL_INVALID_ACCOUNT',
});
```

---

## 4. Execution Modes: Strict vs. Best-Effort

When rolling back compensations, Siglo supports two execution modes via `CompensationRunOptions`:

| Mode                   | Behavior                                                                                              | Use Case                                                                                   |
| :--------------------- | :---------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| `'strict'` _(default)_ | Aborts rollback at the first compensation failure. Remaining compensations are halted.                | Dependent side effects where subsequent rollbacks depend on earlier rollbacks succeeding.  |
| `'best-effort'`        | Continues executing remaining compensations even if one fails. All errors are collected and reported. | Independent external services where maximizing partial rollback is preferred over halting. |

```typescript
await orderSaga.run(payload, {
    mode: 'best-effort',
});
```

---

## 5. Dead Letter Queue (DLQ) & Failure Callbacks

Capture compensation failures that exhaust all retry attempts without losing context:

```typescript
const deadLetterQueue = {
    send: async (entry: {
        stackId: string;
        stepName: string;
        handlerName?: string;
        failedCompensation: any;
        error: string;
        timestamp: number;
    }) => {
        await sqs.sendMessage({
            QueueUrl: process.env.COMPENSATION_DLQ_URL!,
            MessageBody: JSON.stringify(entry),
        });
    },
};

await orderSaga.run(payload, {
    mode: 'best-effort',
    deadLetterQueue,
    onFailure: async ({ stepName, error, record }, err) => {
        logger.error(`Compensation failed for ${stepName}:`, err);
    },
});
```

---

## 6. Error Handling & Exceptions

```typescript
import { CompensationException, UnresolvableCompensationException } from '@siglo/core';

try {
    await orderSaga.run(payload);
} catch (err) {
    if (err instanceof CompensationException) {
        // Thrown when one or more compensations fail
        console.error('Root forward cause:', err.originalError);
        console.error('Failed compensations:', err.compensationErrors);
        console.error('Successfully rolled back:', err.completedCompensations);
    } else if (err instanceof UnresolvableCompensationException) {
        // Thrown if a named handler cannot be found in the registry
        console.error(`Missing handler '${err.handlerName}' for step '${err.stepName}'`);
    } else {
        // Normal forward step failure (all compensations rolled back cleanly)
        console.error('Workflow failed forward:', err.message);
    }
}
```

---

## 7. Crash Recovery & Abandoned Stack Reconciler

### Manual Saga Compensation

Resume or trigger compensations on an existing or interrupted stack:

```typescript
const report = await orderSaga.compensate('stack-123-uuid', {
    mode: 'best-effort',
    deadLetterQueue,
});

console.log('Compensated steps:', report.completed);
console.log('Failed steps:', report.failed);
```

### Background Reconciliation (`reconcileAbandonedStacks`)

Detect crashed processes or abandoned workflows in storage and roll them back safely:

```typescript
import { reconcileAbandonedStacks } from '@siglo/core';

const report = await reconcileAbandonedStacks({
    staleThresholdMs: 15 * 60 * 1000, // 15 minutes without progress
    action: 'compensate', // 'compensate' | 'fail' | 'inspect'
    mode: 'best-effort',
    namespace: 'order-service',
    deadLetterQueue,
});

console.log(`Reconciled ${report.reconciled.length} abandoned stacks.`);
```
