# Branching and Parallelism

`Siglo` provides high-performance combinators for concurrent fan-out, competitive racing, conditional routing, and bounded batch processing.

---

## 1. Parallel Fan-Out with `parallel()`

Execute multiple branches or steps concurrently:

```typescript
import { Step, flow, parallel } from '@siglo/core';

const fetchCreditScore = Step.create('fetchCredit', async () => ({ creditScore: 750 }));
const fetchBankHistory = Step.create('fetchHistory', async () => ({ hasDefaults: false }));
const fetchIdentity = Step.create('fetchIdentity', async () => ({ idVerified: true }));

export const verificationPipeline = flow(
    parallel([
        fetchCreditScore,
        fetchBankHistory,
        fetchIdentity
    ])
);
```

### Concurrency Modes & Merge Strategies
Configure merge behavior using `ParallelOptions`:

```typescript
parallel([branchA, branchB], {
    mode: 'fail-fast', // 'fail-fast', 'allSettled', or 'race'
    mergeStrategy: 'shallow' // 'shallow', 'deep', 'namespace', or custom merge fn
});
```

Branches execute concurrently and merge in branch-list order. Context metadata exposes `$branches` and `$settled`. For bounded worker concurrency across collections, use `map()` below.

---

## 2. Competitive Racing with `race()`

Execute multiple alternatives concurrently and accept the fastest result:

```typescript
import { Step, flow, race } from '@siglo/core';

const queryFastReplica = Step.create('queryFast', async () => ({ source: 'replica-1', price: 99.5 }));
const queryPrimaryDb = Step.create('queryPrimary', async () => ({ source: 'primary', price: 99.5 }));

export const pricingWorkflow = flow(
    race([queryFastReplica, queryPrimaryDb])
);
```

---

## 3. Conditional Branching with `branch()` and `when()`

Route execution based on runtime conditions:

```typescript
import { Step, flow, branch, when } from '@siglo/core';

// Multi-way routing with branch(selectorFn, branchesMap, defaultBranch?)
const handleUsCustomer = Step.create('usTax', async () => ({ taxRate: 0.08 }));
const handleEuCustomer = Step.create('euVat', async () => ({ taxRate: 0.20 }));
const handleGlobalCustomer = Step.create('globalTax', async () => ({ taxRate: 0.00 }));

export const checkoutRouting = flow(
    branch((param) => param.country, {
        US: handleUsCustomer,
        DE: handleEuCustomer,
        FR: handleEuCustomer
    }, handleGlobalCustomer) // Fallback default
);
```

Or using boolean decisions with `when(predicate, thenStep, elseStep?)`:

```typescript
const taxFlow = flow(
    when(
        (param) => param.amount > 10000,
        Step.create('flagHighValue', () => ({ reviewRequired: true })),
        Step.create('autoApprove', () => ({ reviewRequired: false }))
    )
);
```

---

## 4. Bounded Batch Mapping with `map()`

Process collections with controlled concurrency without exhausting memory or database connections:

```typescript
import { Step, flow, map } from '@siglo/core';

// Steps used as mappers receive an envelope: { item, index, total, signal, ... }
const processItem = Step.create('processItem', async (ctx: { item: { sku: string; qty: number } }) => {
    return { sku: ctx.item.sku, processed: true };
});

export const batchWorkflow = flow(
    map((param) => param.orderItems, processItem, {
        concurrency: 4, // Max 4 concurrent items
        stopOnError: false // Continue processing remaining items on failure
    })
);
```

---

## Minimal Example

```typescript
import { Step, flow, parallel } from '@siglo/core';

const s1 = Step.create('s1', () => ({ a: 10 }));
const s2 = Step.create('s2', () => ({ b: 20 }));

const wf = flow(parallel([s1, s2]));
const res = await wf.run({}, { pojo: true });
console.log(res); // { a: 10, b: 20 }
```

---

## Failure Example: Handling Partial Parallel Failures

Using `allSettled` mode ensures individual step errors do not crash other concurrent operations:

```typescript
import { Step, flow, parallel } from '@siglo/core';

const goodStep = Step.create('good', async () => ({ ok: true }));
const badStep = Step.create('bad', async () => {
    throw new Error('Downstream service unreachable');
});

const tolerantFlow = flow(
    parallel([goodStep, badStep], {
        mode: 'allSettled'
    })
);

const result = await tolerantFlow.run({}, { pojo: true });
console.log(result);
// Contains successful results and error records under $parallel
```

---

## Testing Example

```typescript
import { expect } from 'chai';
import { createWorkflowHarness } from '@siglo/testing';
import { Step, flow, branch } from '@siglo/core';

const decisionWf = flow(
    branch(
        (p: { vip: boolean }) => p.vip === true,
        Step.create('vipStep', () => ({ discount: 50 })),
        Step.create('standardStep', () => ({ discount: 10 }))
    )
);

describe('Branching Test Suite', () => {
    it('routes VIP customer to vipStep', async () => {
        const harness = createWorkflowHarness(decisionWf);
        const res = await harness.run({ vip: true });

        expect(res.discount).to.equal(50);
        harness.assertStepExecuted('vipStep');
    });

    it('routes regular customer to standardStep', async () => {
        const harness = createWorkflowHarness(decisionWf);
        const res = await harness.run({ vip: false });

        expect(res.discount).to.equal(10);
        harness.assertStepExecuted('standardStep');
    });
});
```

---

## Operational Caveats

1. **Connection Pool Starvation**: When using unbounded parallel fan-out (`parallel([...])`), ensure external resource connection pools (e.g., PostgreSQL client pool) are sized appropriately. Use `{ concurrency: N }` to throttle execution.
2. **Key Collisions in Parallel Branches**: If parallel branches produce identically named output keys without a custom reducer or namespace strategy, the last resolved branch will overwrite prior ones. Specify `{ mergeStrategy: 'namespace' }` to isolate branch keys.

---

## API Reference Links

- [Sequential Workflows](./03-sequential-workflows.md)
- [Retries, Timeouts, and Cancellation](./05-retries-timeouts-and-cancellation.md)
- [Testing & Replay Reference](./09-testing-and-replay.md)
