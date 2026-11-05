# Concurrency and Parallelism

`Siglo` v1.0.0 introduces built-in combinators for concurrent execution, conditional branching, and collection mapping with bounded concurrency.

---

## 1. Parallel Execution (`parallel`, `all`, `allSettled`, `race`)

### `parallel(...branches, options?)`

Executes branches concurrently. Defaults to fail-fast mode with abort signal propagation:

```typescript
import { Step, flow, parallel } from '@siglo/core';

const orderWorkflow = flow(
  validateOrder,
  parallel(
    reserveInventory,
    authorizePayment,
    calculateTax
  ),
  fulfillOrder
);

const result = await orderWorkflow.execute(orderData, { pojo: true });
```

### Modes

1. **`fail-fast` (default, alias `all`)**:
   - If any branch rejects or throws, an `AbortController` triggers immediate cancellation across all sibling in-flight branches.
   - The workflow rejects immediately with the error of the first failed branch.

2. **`allSettled`**:
   - Executes all branches to completion, preserving both fulfilled values and rejection reasons.
   - Outputs a `$branches` metadata array and `$settled` summary without throwing prematurely.

3. **`race`**:
   - Resolves or rejects as soon as the first branch settles.
   - Automatically aborts losing branches to avoid resource leaks.

### Merge Strategies

When branches complete, their outputs are merged into the workflow context according to `mergeStrategy`:
- **`'shallow'` (default)**: Properties from completed branches are shallow-copied onto the parent context (`Object.assign`).
- **`'deep'`**: Nested object properties are recursively merged.
- **`'error'`**: Detects conflicts between branches. If two or more branches attempt to write different values to the same field, execution halts immediately by throwing `FieldCollisionException`.
- **Custom Function**: `(target, source, branchKey) => mergedTarget`.

```typescript
import { parallel, FieldCollisionException } from '@siglo/core';

const safeParallel = parallel([branchA, branchB], {
  mergeStrategy: 'error'
});
```

---

## 2. Conditions and Branching (`when`, `branch`)

### `when(predicate, thenStep, elseStep?)`

Executes conditional logic based on a predicate function:

```typescript
import { Step, flow, when } from '@siglo/core';

const approvalWorkflow = flow(
  calculateRisk,
  when(
    (ctx) => ctx.riskScore > 80,
    Step.create('manualReview', reviewApplication),
    Step.create('autoApprove', instantApproval)
  )
);
```

- When the predicate resolves to `true`, `thenStep` executes.
- When `false`, `elseStep` executes (if provided).
- If `elseStep` is omitted and the predicate is `false`, the step returns `$skipped: true` and leaves context unmodified.
- History tracks `$branchSelected` (`'then'` or `'else'`) and `$skippedBranches`.

### `branch(selector, branchesMap, defaultBranch?)`

Multi-way branching based on a selector function or context key:

```typescript
import { branch, Step } from '@siglo/core';

const paymentBranch = branch(
  (ctx) => ctx.paymentMethod,
  {
    creditCard: processCreditCard,
    paypal: processPayPal,
    crypto: processCrypto
  },
  defaultPaymentFallback
);
```

---

## 3. Mapping with Bounded Concurrency (`map`)

The `map` combinator processes collections or streams with strict concurrency bounds:

```typescript
import { map, flow } from '@siglo/core';

const batchProcess = flow(
  map(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    async (item, { index, signal }) => {
      return await processRecord(item, { signal });
    },
    {
      concurrency: 3,       // Max 3 active concurrent tasks
      stopOnError: true,    // Fail-fast on first error
      preserveOrder: true   // Maintain original sequence in result array
    }
  )
);

const result = await batchProcess.execute({}, { pojo: true });
console.log(result.items); // Ordered processed items
```

### Features
- **Async Iterables**: Streams asynchronous generators without unbounded memory growth.
- **Fail-Fast vs Collect**: Set `stopOnError: false` to accumulate both successes and errors without interrupting other items.
- **Cancellation Propagation**: Cancelling the workflow's `AbortSignal` halts pending queue dispatch and in-flight item workers.
