---
title: 'Branching and Parallelism'
description: 'High-performance workflow combinators for concurrent fan-out, racing, conditional routing, and bounded batch mapping in Siglo.'
---

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

export const verificationPipeline = flow(parallel([fetchCreditScore, fetchBankHistory, fetchIdentity]));
```

### Concurrency Modes & Merge Strategies

Configure merge behavior using `ParallelOptions`:

```typescript
parallel([branchA, branchB], {
    mode: 'fail-fast', // 'fail-fast', 'allSettled', or 'race'
    mergeStrategy: 'shallow', // 'shallow', 'deep', 'namespace', or custom merge fn
});
```

Branches execute concurrently and merge in branch-list order. Context metadata exposes `$branches` and `$settled`. Note that `parallel([...])` is unbounded; for bounded concurrency across large collections, use `map()` below.

---

## 2. Competitive Racing with `race()`

Execute multiple alternatives concurrently and accept the fastest result:

```typescript
import { Step, flow, race } from '@siglo/core';

const queryFastReplica = Step.create('queryFast', async () => ({ source: 'replica-1', price: 99.5 }));
const queryPrimaryDb = Step.create('queryPrimary', async () => ({ source: 'primary', price: 99.5 }));

export const pricingWorkflow = flow(race([queryFastReplica, queryPrimaryDb]));
```

---

## 3. Conditional Branching with `branch()` and `when()`

Route execution based on runtime conditions:

### Boolean Routing with `when(predicate, thenStep, elseStep?)`

Ideal for binary branching decisions:

```typescript
import { Step, flow, when } from '@siglo/core';

export const approvalFlow = flow(
    when(
        param => param.amount > 10000,
        Step.create('flagHighValue', () => ({ reviewRequired: true })),
        Step.create('autoApprove', () => ({ reviewRequired: false })),
    ),
);
```

### Multi-Way Routing with `branch(selectorFn, branchesMap, defaultBranch?)`

Ideal for dictionary dispatch across named routes:

```typescript
import { Step, flow, branch } from '@siglo/core';

const handleUsCustomer = Step.create('usTax', async () => ({ taxRate: 0.08 }));
const handleEuCustomer = Step.create('euVat', async () => ({ taxRate: 0.2 }));
const handleGlobalCustomer = Step.create('globalTax', async () => ({ taxRate: 0.0 }));

export const checkoutRouting = flow(
    branch(
        param => param.country,
        {
            US: handleUsCustomer,
            DE: handleEuCustomer,
            FR: handleEuCustomer,
        },
        handleGlobalCustomer,
    ), // Fallback default
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
    map(param => param.orderItems, processItem, {
        concurrency: 4, // Max 4 concurrent items
        stopOnError: false, // Continue processing remaining items on failure
    }),
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
        mode: 'allSettled',
    }),
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
import { Step, flow, when, branch } from '@siglo/core';

// 1. Boolean decision with when()
const decisionWf = flow(
    when(
        (p: { vip: boolean }) => p.vip === true,
        Step.create('vipStep', () => ({ discount: 50 })),
        Step.create('standardStep', () => ({ discount: 10 })),
    ),
);

// 2. Multi-way route dispatch with branch()
const multiWf = flow(
    branch(
        (p: { region: string }) => p.region,
        {
            US: Step.create('usTax', () => ({ tax: 0.08 })),
            EU: Step.create('euVat', () => ({ tax: 0.2 })),
        },
        Step.create('defaultTax', () => ({ tax: 0.05 })),
    ),
);

describe('Branching Test Suite', () => {
    it('routes VIP customer via when()', async () => {
        const harness = createWorkflowHarness(decisionWf);
        const res = await harness.run({ vip: true });

        expect(res.discount).to.equal(50);
        expect(res.$branchSelected).to.equal('then');
        expect(res.$skippedBranches).to.deep.equal(['else']);
    });

    it('routes regular customer via when()', async () => {
        const harness = createWorkflowHarness(decisionWf);
        const res = await harness.run({ vip: false });

        expect(res.discount).to.equal(10);
        expect(res.$branchSelected).to.equal('else');
        expect(res.$skippedBranches).to.deep.equal(['then']);
    });

    it('routes multi-way branch with branch() key dispatch', async () => {
        const harness = createWorkflowHarness(multiWf);
        const res = await harness.run({ region: 'EU' });

        expect(res.tax).to.equal(0.2);
        expect(res.$branchSelected).to.equal('EU');
    });
});
```

---

## Operational Caveats

1. **Parallel Fan-Out is Unbounded**: `parallel([...])` initiates all branches simultaneously. When calling external services with limited connection pools, do not use `parallel([...])` for large arrays—use `map(items, step, { concurrency: N })` to bound concurrent executions.
2. **Key Collisions in Parallel Branches**: If parallel branches produce identically named output keys without a custom reducer or namespace strategy, the last resolved branch will overwrite prior ones. Specify `{ mergeStrategy: 'namespace' }` to isolate branch keys.

---

## API Reference Links

- [Core Concepts Guide](/02-core-concepts)
- [Sequential Workflows](/03-sequential-workflows)
- [Retries, Timeouts, and Cancellation](/05-retries-timeouts-and-cancellation)
- [Testing & Replay Reference](/09-testing-and-replay)
