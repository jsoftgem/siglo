---
title: 'Idempotency and Deduplication'
description: 'Workflow-level and step-level idempotency guarantees, atomic claim lifecycle, wait-and-settle thundering herd defense, and error classification.'
---

Workflows in distributed environments are subject to network retries, duplicate webhooks, and at-least-once execution semantics. `Siglo` provides first-class idempotency guarantees at both the workflow level and individual step level.

---

## 1. Idempotency Store Interface

The `IdempotencyStore` abstraction governs key claiming, caching, and completion:

```typescript
interface IdempotencyStore {
    claim(key: string, ttlMs?: number): Promise<'claimed' | 'completed' | 'in-progress'>;
    complete(key: string, result: unknown): Promise<void>;
    fail(key: string, error: unknown): Promise<void>;
    get?(key: string): Promise<unknown>;
    getResult?(key: string): Promise<unknown>;
    clear?(): void;
}
```

Both `get(key)` and `getResult(key)` are supported for reading completed results across store implementations (e.g. `RedisIdempotencyStore`, `PostgresIdempotencyStore`, `InMemoryIdempotencyStore`).

### Claim States

- **`'claimed'`**: Key was successfully acquired. Execution may proceed.
- **`'completed'`**: Key was previously executed to completion. The orchestrator returns the cached output immediately without re-executing steps.
- **`'in-progress'`**: Another execution is currently running with the same key. The orchestrator throws `IdempotencyConflictException` (or waits if `settleTimeoutMs` is configured).

`InMemoryIdempotencyStore` is provided by default. Custom stores (such as Redis or PostgreSQL) can be plugged in seamlessly.

---

## 2. Key Scoping and Namespacing (`buildIdempotencyKey`)

To prevent key collisions across namespaces or versions, keys are automatically scoped:

```typescript
import { buildIdempotencyKey } from '@siglo/core';

const key = buildIdempotencyKey('order-1234', {
    namespace: 'tenant-a',
    workflowVersion: '2.0.0',
});
// Yields: 'ff:idemp:tenant-a:2.0.0:order-1234'
```

---

## 3. Workflow-Level Idempotency

Workflow-level deduplication wraps the entire flow execution. Subsequent requests with identical idempotency keys return the prior result:

```typescript
import { flow, Step } from '@siglo/core';

const checkoutFlow = flow(chargeCard, sendReceipt);

// First invocation -> executes steps and caches output
const res1 = await checkoutFlow.run(orderPayload, {
    idempotencyKey: 'req-checkout-9876',
    namespace: 'tenant-acme',
    idempotencyTtlMs: 3600000, // 1 hour TTL
});

// Second invocation with same key -> returns cached result instantly without re-running chargeCard
const res2 = await checkoutFlow.run(orderPayload, {
    idempotencyKey: 'req-checkout-9876',
    namespace: 'tenant-acme',
});
```

Dynamic keys can be specified as a context accessor:

```typescript
{
    idempotencyKey: ctx => `checkout:${ctx.orderId}`;
}
```

---

## 4. Step-Level Idempotency (Atomic Lifecycle Commitment)

Individual steps (including array `.reduce()` steps) can declare idempotency with `.idempotent(...)`.

Fine-grained deduplication on individual steps prevents redundant side effects (e.g. charging a payment gateway twice):

```typescript
import { Step } from '@siglo/core';

const chargePayment = Step.create('chargePayment', async ({ invoiceId, amount }) => {
    return await paymentGateway.charge({ invoiceId, amount });
}).idempotent(ctx => `charge:${ctx.invoiceId}`, { ttlMs: 86400000 });
```

### Atomic Commitment Rule

A step's idempotency record transitions to `'completed'` atomically only after all post-execution hooks (`onAfter`) successfully pass. This prevents dirty cached reads by concurrent executions if post-processing fails.

If a step action or hook fails, the idempotency claim is automatically released via `store.fail(key)`, allowing safe retries.

---

## 5. Wait-and-Settle Thundering Herd Defense

When high-frequency webhooks (e.g. Stripe, Shopify) or distributed messaging queues (Kafka, BullMQ, SQS) deliver duplicate messages concurrently within milliseconds, failing fast with `IdempotencyConflictException` can cause unnecessary client errors.

Configure **Wait-and-Settle** on idempotent steps:

```typescript
export const chargeCardStep = Step.create('chargeCard', async (ctx: any) => {
    return await paymentGateway.charge({ amount: ctx.amount, customerId: ctx.customerId });
}).idempotent(ctx => `charge:${ctx.orderId}`, {
    ttlMs: 86400000, // 24-hour retention
    settleTimeoutMs: 3000, // Spin-wait up to 3000ms for in-flight request to settle
    pollIntervalMs: 50, // Check state every 50ms
});
```

- When the second concurrent request arrives while the first is `'in-progress'`, it pauses and polls the store every `pollIntervalMs`.
- If the first request finishes within `settleTimeoutMs`, the second request returns the cached result cleanly without re-executing.
- If the first request does not finish within `settleTimeoutMs`, `IdempotencyConflictException` is thrown.

---

## 6. Two-Tier Error Classification

When an idempotent step throws, Siglo differentiates between **permanent business declines** and **transient infrastructure faults**:

```typescript
import { isPermanentBusinessError } from '@siglo/core';
```

- **Permanent Business Errors** (e.g. `CardDeclined`, `AccountNotFound`, `InvalidCurrency`): Call `idempotencyStore.complete(key, { error: 'CardDeclined' })` or configure error predicates so that subsequent retries return the cached decline immediately without re-invoking payment gateways.
- **Transient Infrastructure Errors** (e.g. `ETIMEDOUT`, `503 Service Unavailable`, `ECONNRESET`): Siglo invokes `idempotencyStore.fail(key)`, releasing the claim so subsequent retry attempts or backoff poller sweeps can re-execute cleanly.
