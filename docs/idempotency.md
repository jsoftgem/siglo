# Idempotency and Deduplication

Workflows in distributed environments are subject to network retries, duplicate webhooks, and at-least-once execution semantics. `Rivulet` v1.0.0 provides first-class idempotency guarantees at both the workflow level and individual step level.

---

## 1. Idempotency Store Interface

The `IdempotencyStore` abstraction governs key claiming, caching, and completion:

```typescript
interface IdempotencyStore {
  claim(key: string, ttlMs?: number): Promise<'claimed' | 'completed' | 'in-progress'>;
  complete(key: string, result: unknown): Promise<void>;
  fail(key: string, error: unknown): Promise<void>;
  get(key: string): Promise<unknown>;
  clear?(): void;
}
```

### Claim States
- **`'claimed'`**: Key was successfully acquired. Execution may proceed.
- **`'completed'`**: Key was previously executed to completion. The orchestrator returns the cached output immediately without re-executing steps.
- **`'in-progress'`**: Another execution is currently running with the same key. The orchestrator throws `IdempotencyConflictException`.

`InMemoryIdempotencyStore` is provided by default. Custom stores (such as Redis or SQL) can be plugged in seamlessly.

---

## 2. Key Scoping and Namespacing (`buildIdempotencyKey`)

To prevent key collisions across namespaces or versions, keys are automatically scoped:

```typescript
import { buildIdempotencyKey } from 'rivulet';

const key = buildIdempotencyKey('order-1234', {
  namespace: 'tenant-a',
  workflowVersion: '2.0.0'
});
// Yields: 'ff:idemp:tenant-a:2.0.0:order-1234'
```

---

## 3. Workflow-Level Idempotency

Workflow-level deduplication wraps the entire flow execution. Subsequent requests with identical idempotency keys return the prior result:

```typescript
import { flow, Step } from 'rivulet';

const checkoutFlow = flow(chargeCard, sendReceipt);

// First invocation -> executes steps and caches output
const res1 = await checkoutFlow.execute(orderPayload, {
  idempotencyKey: 'req-checkout-9876',
  namespace: 'tenant-acme',
  idempotencyTtlMs: 3600000 // 1 hour TTL
});

// Second invocation with same key -> returns cached result instantly without re-running chargeCard
const res2 = await checkoutFlow.execute(orderPayload, {
  idempotencyKey: 'req-checkout-9876',
  namespace: 'tenant-acme'
});
```

Dynamic keys can be specified as a context accessor:
```typescript
{
  idempotencyKey: (ctx) => `checkout:${ctx.orderId}`
}
```

---

## 4. Step-Level Idempotency (`step.idempotent()`)

Fine-grained deduplication on individual steps prevents redundant side effects (e.g. charging a payment gateway twice):

```typescript
import { Step } from 'rivulet';

const chargePayment = Step.create('chargePayment')
  
  .idempotent((ctx) => `charge:${ctx.invoiceId}`, { ttlMs: 86400000 })
  .onStart(async ({ invoiceId, amount }) => {
    return await paymentGateway.charge({ invoiceId, amount });
  });
```

If a step fails, the idempotency claim is automatically released via `store.fail()`, allowing safe retries.
