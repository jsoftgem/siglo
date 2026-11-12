---
title: 'Why We Built a Zero-Daemon Saga Orchestrator in Pure TypeScript'
description: 'Architectural comparison of in-process orchestration and PostgreSQL Optimistic Concurrency Control vs. external cluster engines.'
---

# Why We Built a Zero-Daemon Saga Orchestrator in Pure TypeScript

Every backend service starts with a clean, linear async function:

```typescript
async function checkout(orderId: string, amount: number) {
    const reservation = await inventory.reserve(orderId);
    const charge = await stripe.charge(amount);
    const shipment = await shipping.dispatch(orderId, reservation.id);
    return { reservation, charge, shipment };
}
```

Then production happens:

1. The payment gateway throws a transient `503`—so you wrap `stripe.charge` in a `for` loop with exponential backoff.
2. `shipping.dispatch` fails after the customer's card was already charged—so you add mutable `let chargeId` and `let reservationId` flags outside a giant `try/catch` block and manually call `stripe.refund()` and `inventory.release()` in reverse order.
3. A mobile client double-taps "Pay" on a flaky connection—so you bolt on Redis or PostgreSQL idempotency keys.
4. A webhook-driven fraud check needs to pause the workflow for 10 minutes—so you split the function across two queue handlers and a database state machine.

At this point, teams usually face an uncomfortable binary choice:

- **Keep writing ad-hoc imperative plumbing** in every endpoint and hope nobody forgets a rollback branch.
- **Adopt a distributed workflow cluster** (like Temporal or Inngest), introducing external server daemons, separate worker fleets, deterministic replay constraints, and millisecond-to-second RPC hops for every step.

We built [**Siglo**](https://github.com/jsoftgem/siglo) (`@siglo/core`) to occupy the missing middle: **zero-daemon, in-process workflow orchestration in pure TypeScript** that scales up to durable PostgreSQL Optimistic Concurrency Control (OCC) checkpoints when you need durability—using the database you already run.

---

## Architecture: In-Process Execution vs. External Orchestrator Daemons

| Dimension                 | Siglo (`@siglo/core` + `@siglo/postgres`)                          | External Cluster Engines (Temporal, Inngest)             |
| :------------------------ | :----------------------------------------------------------------- | :------------------------------------------------------- |
| **Infrastructure**        | Zero daemons; runs inside your existing Node.js process            | Separate orchestrator cluster, queues, and worker fleets |
| **Step Dispatch Latency** | Microseconds (direct in-memory function invocation)                | Milliseconds to seconds (network RPC / queue polling)    |
| **Runtime Constraints**   | Standard V8 runtime (`fs`, `crypto`, `fetch` work normally)        | Deterministic V8 sandbox or HTTP step boundary           |
| **Durability Model**      | Optional pluggable checkpoints (`@siglo/postgres`, `@siglo/redis`) | Mandatory centralized event-history log                  |
| **Static Type Safety**    | Automatic accumulated context + `$steps` history inference         | Manual type annotations across activity boundaries       |

For 95% of backend workflows—checkout pipelines, multi-provider AI agents, onboarding flows, Kafka consumers, and multi-service sagas—you don't need an external orchestration cluster. You need structured control flow, LIFO compensations, retries, idempotency, and atomic state checkpoints inside your existing application.

---

## 1. Declarative Sagas Without Nested `try/catch`

In Siglo, a workflow is a composition of typed `Step` primitives. Each step can declare its own retry policy (`.onFail()`) and its own rollback logic (`.compensate()`):

```typescript
import { Step, flow } from '@siglo/core';

const reserveInventory = Step.create('reserveInventory', async ({ orderId }: { orderId: string; amount: number }) => ({
    reservationId: await inventory.reserve(orderId),
})).compensate(async ctx => {
    await inventory.release(ctx.reservationId);
});

const chargeCard = Step.create('chargeCard', async ({ amount }) => ({
    chargeId: await stripe.charge(amount),
}))
    .onFail({ maxRetries: 3, backoff: 'exponential', delay: 200, jitter: 'full' })
    .compensate(async ctx => {
        await stripe.refund(ctx.chargeId);
    });

const shipOrder = Step.create('shipOrder', async ({ orderId, reservationId }) => ({
    trackingId: await shipping.dispatch(orderId, reservationId),
}));

export const checkoutFlow = flow(reserveInventory, chargeCard, shipOrder);
```

When `shipOrder` throws an unrecoverable error:

1. Siglo halts forward execution immediately.
2. It unwinds the completed steps in **strict LIFO (Last-In, First-Out) order**: `chargeCard` is refunded first, and then `reserveInventory` is released.
3. Even if a process crashes mid-flight, durable compensation records stored in the checkpoint allow a background reconciler (`Step.reconcileAbandonedStacks`) or explicit `checkoutFlow.compensate(stackId)` call to finish unwinding the Saga cleanly.

---

## 2. Durable Checkpoints with PostgreSQL Optimistic Concurrency Control (OCC)

How do you get crash recovery and distributed suspension (`waitForEvent`) without a central coordinator daemon? By turning your existing PostgreSQL database into an OCC state store via `@siglo/postgres`.

When you register `PostgresStorageAdapter`, Siglo persists `SerializedExecutionStack` snapshots after each step with an atomic monotonically increasing `version` column:

```sql
UPDATE siglo_checkpoints
SET state = CASE
        WHEN state->>'status' = 'cancelled'
        THEN jsonb_set($1::jsonb, '{status}', '"cancelled"')
        ELSE $1::jsonb
    END,
    namespace = $2,
    version = version + 1,
    updated_at = NOW()
WHERE stack_id = $3 AND version = $4
RETURNING version;
```

Notice two critical properties in that single SQL statement:

1. **Zero Split-Brain (`WHERE stack_id = $3 AND version = $4`)**: If two worker replicas attempt to advance or resume the same workflow `stackId` concurrently, exactly one `UPDATE` matches `version = $4`. The losing replica receives `rowCount === 0` and immediately throws an `OptimisticLockException` before executing duplicate downstream side effects.
2. **Monotonic Cancellation Preservation**: Even if an in-flight step finishes writing a checkpoint milliseconds after another node cancels the workflow, the `CASE WHEN state->>'status' = 'cancelled'` guard prevents overwriting a terminal cancellation state.

---

## 3. Suspending for Webhooks Without Holding a Thread (`waitForEvent`)

Because state is checkpointed to PostgreSQL or Redis, a workflow can pause for minutes or days waiting for an external webhook (like a Stripe 3DS callback or human approval) with **zero active memory or open connections**:

```typescript
import { Step, flow, waitForEvent, WorkflowSuspendedException } from '@siglo/core';
import { PostgresStorageAdapter } from '@siglo/postgres';

const adapter = new PostgresStorageAdapter({ client: pgPool });
await adapter.ensureTables();
Step.useStorage(adapter);

const orderApprovalFlow = flow(
    reserveInventory,
    waitForEvent<{ approvedBy: string }>('manager.approval', {
        correlationKey: ctx => `order:${ctx.orderId}`,
        timeout: '24h',
    }),
    chargeCard,
    shipOrder,
);
```

When execution reaches `waitForEvent`:

1. Siglo writes a `WAITING` record to `siglo_wait_records` keyed by `order:${ctx.orderId}` along with the `continuation_step_index`.
2. The `run()` promise throws `WorkflowSuspendedException` (or HTTP `202 Accepted` when mounted via `@siglo/express`, `@siglo/fastify`, or `@siglo/hono`), freeing the Node.js event loop.
3. When the webhook arrives hours later, calling `await orderApprovalFlow.resume('order:ord_123', { approvedBy: 'alice' })` atomically claims the wait record (`WHERE correlation_key = $1 AND status = 'WAITING'`), hydrates the checkpoint, merges the webhook payload into the accumulated context, and resumes at `chargeCard`.

---

## 4. Static AST Extraction: Your Code _Is_ the Architecture Diagram

Because Siglo workflows are composed from declarative primitives (`Step.create`, `flow`, `parallel`, `branch`, `when`, `map`, `waitForEvent`), the workflow graph is inspectable **before a single line of business logic runs**.

- Call `checkoutFlow.toMermaid()` or `npx @siglo/cli export src/checkout.ts --format=mermaid` in CI to auto-comment architecture diagrams on every Pull Request.
- Install the **VS Code** or **JetBrains IntelliJ** extension to view live interactive workflow DAGs side-by-side with your editor.
- Attach `@siglo/monitor` in development or staging to watch live execution waterfalls, inspect step input/output diffs, and replay failed runs from `http://localhost:4000`.

---

## Try It in 60 Seconds

You don't need Docker, a local daemon, or a cloud account to try Siglo:

```bash
# Scaffold a runnable project with a deterministic test suite
npm exec --package=@siglo/cli -- siglo init

# Or install directly into an existing service
npm install @siglo/core
```

- **GitHub Repository**: [github.com/jsoftgem/siglo](https://github.com/jsoftgem/siglo)
- **Incremental Adoption Guide**: [Migrate 1 Endpoint in 5 Minutes](../migrate-one-endpoint.md)
- **Documentation**: [siglo.dev](https://siglo.dev)
