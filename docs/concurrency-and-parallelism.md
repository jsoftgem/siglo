---
title: 'Concurrency and Parallelism'
description: 'Comprehensive guide to concurrent execution, parallel fan-out, competitive racing, conditional routing, and bounded collection mapping in Siglo.'
---

# Concurrency and Parallelism

`Siglo` provides high-performance, functional combinators for concurrent execution, competitive racing, conditional routing, and bounded batch mapping. Designed around cooperative cancellation, state isolation, and deterministic merging, Siglo enables complex asynchronous coordination while preventing race conditions, unhandled rejections, and resource exhaustion.

---

## 1. Parallel Execution (`parallel`, `all`, `allSettled`, `race`)

### `parallel(...branches, options?)`

Executes multiple steps, flows, or async functions concurrently. Each branch receives an isolated clone of the context, guaranteeing that sibling branches cannot mutate shared state during execution.

Siglo supports both spread and array argument overloads:

```typescript
import { Step, flow, parallel } from '@siglo/core';

const reserveInventory = Step.create('reserveInventory', async ctx => ({
    inventoryReserved: true,
    reservationId: 'inv_982',
}));

const authorizePayment = Step.create('authorizePayment', async ctx => ({
    paymentAuthorized: true,
    authCode: 'ch_3821',
}));

const calculateTax = Step.create('calculateTax', async ctx => ({
    taxAmount: 18.5,
}));

// Spread syntax or array syntax:
const orderWorkflow = flow(parallel(reserveInventory, authorizePayment, calculateTax));

const result = await orderWorkflow.run({ orderId: 'ord_123', total: 200 });
console.log(result.inventoryReserved); // true
console.log(result.paymentAuthorized); // true
console.log(result.taxAmount); // 18.50
console.log(result.$timing.durationMs); // Total execution time in ms
```

### Execution Modes

Set the mode using `ParallelOptions`:

```typescript
export interface ParallelOptions {
    name?: string;
    mode?: 'fail-fast' | 'allSettled' | 'race';
    mergeStrategy?:
        'shallow' | 'deep' | 'error' | 'namespace' | ((target: any, source: any, branchKey: string | number) => any);
}
```

1. **`fail-fast` (default, alias `all`)**:
    - Executes all branches concurrently.
    - If any branch throws or rejects, an internal `AbortController` triggers immediate cancellation across all sibling in-flight branches.
    - The workflow rejects immediately with the error of the first failed branch.
    - On completion, attaches `$branches: BranchExecutionSummary[]` and `$timing: { durationMs: number }`.

2. **`allSettled`**:
    - Executes all branches to completion regardless of individual failures.
    - Accumulates fulfilled values as well as rejection reasons.
    - Context output contains:
        - Each branch's result keyed by its step/function name (or `{ error: Error }` if rejected).
        - `$branches`: An array of `BranchExecutionSummary` records detailing name, index, status (`'completed'` | `'failed'`), duration, output, and error.
        - `$settled`: The raw `PromiseSettledResult<any>[]` array.

3. **`race`**:
    - Resolves or rejects as soon as the first branch settles.
    - Automatically aborts losing branches via `AbortController` to avoid orphaned background work and resource leaks.

### Convenience Combinators: `all`, `allSettled`, and `race`

Instead of passing `{ mode: '...' }`, Siglo exports dedicated helper functions:

```typescript
import { flow, all, allSettled, race, Step } from '@siglo/core';

// 1. all: Explicit fail-fast fan-out
const fetchAllData = flow(all([fetchProfile, fetchPreferences, fetchBilling]));

// 2. allSettled: Resilient batch execution without premature termination
const syncThirdParties = flow(allSettled([syncHubspot, syncStripe, syncSlack]));
const syncResult = await syncThirdParties.run({ customerId: 'cust_42' });
if (syncResult.syncHubspot?.error) {
    console.warn('HubSpot sync failed:', syncResult.syncHubspot.error);
}

// 3. race: Fastest responder wins; slower sibling is automatically aborted
const queryData = flow(
    race(
        Step.create('replica', async (_, { signal }) => await queryReplica({ signal })),
        Step.create('primary', async (_, { signal }) => await queryPrimary({ signal })),
    ),
);
```

### Merge Strategies

When branches complete, their outputs are integrated into the workflow context according to `mergeStrategy`:

| Strategy                  | Description                                                                                             | Collision Handling                                                                         |
| :------------------------ | :------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------- |
| **`'shallow'` (default)** | Shallow-copies properties from each completed branch into the context via `Object.assign`.              | Later branches overwrite earlier branches if keys collide.                                 |
| **`'deep'`**              | Recursively deep-merges nested object properties and concatenates arrays.                               | Merges objects; scalar collisions favor later branches.                                    |
| **`'namespace'`**         | Nests each branch's output dictionary under its branch/step name (`result[branchName] = branchOutput`). | Completely eliminates collisions between sibling branches.                                 |
| **`'error'`**             | Detects conflicting field values across branches.                                                       | Throws `FieldCollisionException` if two branches output different values for the same key. |
| **Custom Function**       | `(target, source, branchKey) => mergedTarget`                                                           | You control custom reduction logic.                                                        |

#### Example: Collision Detection with `mergeStrategy: 'error'`

```typescript
import { parallel, FieldCollisionException, flow, Step } from '@siglo/core';

const branchA = Step.create('branchA', () => ({ status: 'pending', id: 101 }));
const branchB = Step.create('branchB', () => ({ status: 'pending', id: 202 })); // 'id' conflict!

const safeWorkflow = flow(parallel([branchA, branchB], { mergeStrategy: 'error' }));

try {
    await safeWorkflow.run({});
} catch (err) {
    if (err instanceof FieldCollisionException) {
        console.error('Colliding fields:', err.collisions);
        // [{ field: 'id', values: [101, 202], branchNames: ['branchA', 'branchB'] }]
    }
}
```

#### Example: Namespaced Merging with `mergeStrategy: 'namespace'`

```typescript
const branchA = Step.create('crm', () => ({ customerId: 123 }));
const branchB = Step.create('billing', () => ({ customerId: 456 }));

const namespacedFlow = flow(parallel([branchA, branchB], { mergeStrategy: 'namespace' }));

const res = await namespacedFlow.run({});
console.log(res.crm.customerId); // 123
console.log(res.billing.customerId); // 456
```

---

## 2. Conditions and Branching (`when`, `branch`)

### `when(predicate, thenStep, elseStep?)`

Executes conditional logic based on a synchronous or asynchronous predicate function:

```typescript
import { Step, flow, when } from '@siglo/core';

const reviewApplication = Step.create('manualReview', async ctx => ({
    status: 'UNDER_REVIEW',
    reviewer: 'team_fraud',
}));

const instantApproval = Step.create('autoApprove', async ctx => ({
    status: 'APPROVED',
    approvalDate: new Date().toISOString(),
}));

const approvalWorkflow = flow(
    calculateRisk,
    when(async (ctx, meta) => ctx.riskScore > 80, reviewApplication, instantApproval),
);

const result = await approvalWorkflow.run({ riskScore: 85 });
console.log(result.status); // 'UNDER_REVIEW'
console.log(result.$branchSelected); // 'then'
console.log(result.$skippedBranches); // ['else']
```

#### Key Characteristics

- **Predicate Metadata**: Receives `(ctx, meta)` where `meta` includes `{ attempt, stackId, namespace }`.
- **Async Support**: Predicate can return `boolean` or `Promise<boolean>`.
- **Omitted `elseStep`**: If the predicate evaluates to `false` and no `elseStep` is defined, the step returns `$skipped: true`, `$skippedBranches: ['then']`, leaving the rest of context unmodified.
- **Traceability**: Context metadata tracks `$branchSelected` (`'then'` or `'else'`) and `$skippedBranches`.

### `branch(selectorOrBranches, branchesMap?, defaultBranch?)`

Multi-way branching supporting both function-driven selection and dictionary-based routing:

#### 1. Function Selector Routing

```typescript
import { branch, Step, flow } from '@siglo/core';

const paymentWorkflow = flow(
    branch(
        ctx => ctx.paymentMethod,
        {
            creditCard: processCreditCard,
            paypal: processPayPal,
            crypto: processCrypto,
        },
        fallbackPaymentStep, // Optional default fallback
    ),
);
```

#### 2. Shorthand Object-First Routing

When a selector function is omitted, `branch` inspects `ctx.branch`, `ctx.status`, `ctx.choice`, or defaults to `'default'`:

```typescript
const dispatchWorkflow = flow(
    branch(
        {
            approved: Step.create('shipOrder', () => ({ trackingNumber: 'TRK_001' })),
            declined: Step.create('notifyDeclined', () => ({ emailSent: true })),
        },
        defaultFallbackStep,
    ),
);

// Automatically routes to 'approved' branch because status is 'approved'
await dispatchWorkflow.run({ status: 'approved' });
```

#### Unmatched Branches

If the selector returns a key that is not in `branchesMap` and no `defaultBranch` is provided, the step gracefully skips:

```typescript
{
  $skipped: true,
  $branchSelected: undefined,
  $skippedBranches: ['creditCard', 'paypal', 'crypto']
}
```

---

## 3. Mapping with Bounded Concurrency (`map`)

Unbounded concurrency across large collections can exhaust memory, crash external APIs, or saturate database connection pools. The `map` combinator processes collections with strict concurrency limits and built-in backpressure.

### `map(itemsOrAccessor, processItem, options?)`

```typescript
import { map, flow, Step } from '@siglo/core';

const batchWorkflow = flow(
    // Extract items dynamically from workflow context
    map(
        ctx => ctx.records,
        async (item, { index, total, signal }) => {
            return await processRecord(item, { signal });
        },
        {
            concurrency: 5, // Max 5 concurrent workers (default: 10)
            stopOnError: true, // Fail-fast on first worker error (default: true)
            preserveOrder: true, // Preserve input sequence in results (default: true)
        },
    ),
);

const result = await batchWorkflow.run({ records: [10, 20, 30, 40, 50] });
console.log(result.items); // [processed10, processed20, ...]
console.log(result.count); // 5
```

### Options Specification (`MapOptions`)

| Option          | Type      | Default | Description                                                                                                                            |
| :-------------- | :-------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency`   | `number`  | `10`    | Maximum number of worker tasks active simultaneously (minimum `1`).                                                                    |
| `stopOnError`   | `boolean` | `true`  | When `true`, stops immediately on first error and cancels pending/active items. When `false`, accumulates both successes and failures. |
| `preserveOrder` | `boolean` | `true`  | Ensures the returned `items` array aligns precisely with the input ordering regardless of individual completion order.                 |
| `name`          | `string`  | `'map'` | Optional step name for tracing and APM observability.                                                                                  |

### Advanced Map Patterns

#### 1. Resilient Processing with `stopOnError: false`

When processing non-critical batches (e.g. bulk notifications or ingest pipelines), collect errors without halting execution:

```typescript
const ingestWorkflow = flow(
    map(
        ctx => ctx.rawEvents,
        async event => ingestEvent(event),
        { stopOnError: false, concurrency: 4 },
    ),
);

const result = await ingestWorkflow.run({ rawEvents });
console.log(`Processed ${result.count} items.`);
if (result.errors) {
    console.warn(`Encountered ${result.errors.length} failures:`, result.errors);
}
// Failed entries inside result.items will be formatted as: { error: Error }
```

#### 2. Memory-Bounded Async Generators

`map` natively consumes `AsyncIterable` generators. Items are pulled on demand by the worker pool, preventing unbounded memory growth when processing millions of rows:

```typescript
async function* streamFromDatabase() {
    let page = 0;
    while (true) {
        const rows = await fetchPage(page++);
        if (!rows.length) break;
        for (const row of rows) yield row;
    }
}

const streamPipeline = flow(
    map(
        () => streamFromDatabase(),
        async (row, { signal }) => transformAndSink(row, { signal }),
        { concurrency: 10 },
    ),
);

await streamPipeline.run({});
```

---

## 4. Cancellation & Signal Propagation

All Siglo concurrency combinators are deeply integrated with the standard `AbortController` and `AbortSignal` architecture:

1. **Outer Cancellation**: Passing a signal into the parent workflow (`flow.run(input, { signal })`) aborts all active combinator branches, queues, and child workers immediately.
2. **Inner Signal Combination**: Combinators use `combineAbortSignals` to merge outer signals with internal fail-fast controllers. When one branch in `fail-fast` or `race` terminates, sibling operations receive an abort notification.
3. **Cooperative Cancellation**: Long-running child steps should register abort listeners or pass `meta.signal` to downstream HTTP or database clients:

```typescript
const queryStep = Step.create('fetchData', async (ctx, { signal }) => {
    const response = await fetch('https://api.example.com/data', { signal });
    return await response.json();
});
```

---

## 5. Combinator Selection Guide

| Use Case                                                              | Recommended Combinator  | Key Configuration                                |
| :-------------------------------------------------------------------- | :---------------------- | :----------------------------------------------- |
| Run independent tasks concurrently (e.g., fetch user + fetch balance) | `parallel()` or `all()` | `mergeStrategy: 'shallow'` or `'namespace'`      |
| Run tasks concurrently where partial failures are acceptable          | `allSettled()`          | Inspect `$branches` and `$settled`               |
| Fallback / fastest responder pattern                                  | `race()`                | Automatic cancellation of losers                 |
| Strict schema validation against field collisions                     | `parallel()`            | `mergeStrategy: 'error'`                         |
| Binary routing (e.g., approval vs reject)                             | `when()`                | `when(predicate, thenStep, elseStep?)`           |
| Polymorphic dictionary routing                                        | `branch()`              | `branch(selector, branchesMap, defaultFallback)` |
| Bounded processing of collections / streams                           | `map()`                 | `{ concurrency: N, stopOnError: true/false }`    |
