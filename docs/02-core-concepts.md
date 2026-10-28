# 02. Core Concepts

This chapter outlines the fundamental mental model and architecture of `Rivulet`.

---

## 1. Workflows as Directed Acyclic Graphs (AST)

In `Rivulet`, a workflow is not a simple promise chain. It is an **executable Abstract Syntax Tree (AST)** composed of nodes:
- `StepNode`: An isolated unit of work with schemas, lifecycles, and policies.
- `SequenceNode`: Sequential execution pipeline.
- `ParallelNode`: Concurrent fan-out/fan-in with merge strategies.
- `BranchNode`: Dynamic conditional routing and predicate dispatch.
- `WaitNode`: Durable event suspension or timer delay.
- `MapNode`: Concurrently bounded array transformations.

Because workflows are represented as ASTs, they can be statically inspected, validated for cycles, visualised as diagrams, and checked before runtime execution.

```typescript
import { Step, flow } from 'rivulet';

const s1 = Step.create('step1', async () => ({ a: 1 }));
const s2 = Step.create('step2', async () => ({ b: 2 }));
const pipeline = flow(s1, s2);

// Inspect the graph AST
const graph = pipeline.toGraph();
const inspection = pipeline.inspect();
console.log('Total Nodes:', inspection.totalNodes);
```

---

## 2. Context & Accumulated Inference

When steps execute sequentially, return values are merged into an **Accumulated Context**. Each subsequent step receives the combined outputs of all prior steps.

```
Input { userId } ──> [ fetchUser ] ──> { userId, user } ──> [ fetchBilling ] ──> { userId, user, balance }
```

TypeScript automatically computes the union type of this accumulated state at compile time:

```typescript
const stepA = Step.create('stepA', (p: { id: string }) => ({ name: 'Alice' }));
const stepB = Step.create('stepB', (p: { name: string }) => ({ verified: true }));

const wf = flow(stepA, stepB);
const result = await wf.run({ id: '123' });
// result is statically typed as:
// { id: string; name: string; verified: boolean; $steps: { stepA: { name: string }; stepB: { verified: boolean } } }
```

---

## 3. Step Lifecycle Pipeline

Each step goes through a strict 5-phase lifecycle:

```
  ┌─────────────────┐
  │ 1. VALIDATION   │  --> Validates input specs and schemas
  └────────┬────────┘
           ▼
  ┌─────────────────┐
  │ 2. BEFORE HOOK  │  --> Executes onBefore gate and plugin filters
  └────────┬────────┘
           ▼
  ┌─────────────────┐
  │ 3. ACTION       │  --> Executes idempotent business logic & external calls
  └────────┬────────┘
           ▼
  ┌─────────────────┐
  │ 4. AFTER HOOK   │  --> Executes onAfter transformers and context mutations
  └────────┬────────┘
           ▼ (on exception)
  ┌─────────────────┐
  │ 5. ONFAIL HOOK  │  --> Handles retry backoff, fallback, or error escalation
  └─────────────────┘
```

---

## 4. Reserved Keys and Namespaces

`Rivulet` reserves specific context keys prefixed with `$` to expose execution metadata without polluting business properties:

| Reserved Key | Description | Type |
|---|---|---|
| `$steps` / `$history` | Record of each named step's exact output | `Record<string, any>` |
| `$attempt` | Current retry attempt index (1-based) | `number` |
| `$retryDelay` | Current backoff delay applied before retry in ms | `number` |
| `$services` / `$deps` | Injected service containers and mock clients | `Record<string, any>` |
| `$signal` | AbortSignal for step or workflow cancellation | `AbortSignal` |
| `$stackId` | Unique execution instance identifier | `string` |
| `$namespace` | Multi-tenant tenant/workspace isolation tag | `string` |
| `$isDurable` | Flag indicating if durable storage is active | `boolean` |

---

## Minimal Example

```typescript
import { Step, flow } from 'rivulet';

const auditStep = Step.create('auditStep', async (param: { transactionId: string }) => {
    return {
        loggedAt: Date.now(),
        status: 'RECORDED'
    };
});

const workflow = flow(auditStep);
const res = await workflow.run({ transactionId: 'tx_99' });
console.log(res.status); // 'RECORDED'
```

---

## Failure Example: Phase Diagnostic Tagging

When an action or lifecycle hook throws, the runtime tags the error with the phase and step name:

```typescript
import { Step, flow } from 'rivulet';

const validateAge = Step.create('validateAge', (p: { age: number }) => {
    if (p.age < 18) {
        throw new Error('Customer must be at least 18');
    }
    return { eligible: true };
});

const wf = flow(validateAge);

try {
    await wf.run({ age: 16 });
} catch (err: any) {
    console.log(err.stepName); // 'validateAge'
    console.log(err.phase);    // 'action'
}
```

---

## Testing Example

```typescript
import { expect } from 'chai';
import { createWorkflowHarness } from '@rivulet/testing';
import { Step, flow } from 'rivulet';

const s1 = Step.create('load', () => ({ val: 10 }));
const s2 = Step.create('double', (p: { val: number }) => ({ doubled: p.val * 2 }));
const wf = flow(s1, s2);

describe('Core Concepts Test', () => {
    it('propagates accumulated state across sequential steps', async () => {
        const harness = createWorkflowHarness(wf);
        const res = await harness.run();

        expect(res.val).to.equal(10);
        expect(res.doubled).to.equal(20);
        expect(res.$steps.load.val).to.equal(10);
        expect(res.$steps.double.doubled).to.equal(20);
    });
});
```

---

## Operational Caveats

1. **Avoid Overwriting Context Keys**: While later steps can overwrite earlier keys if intended, naming step outputs distinctly (e.g. `user`, `order`, `payment`) maintains clean history and avoids confusion.
2. **Never Mutate Param Directly**: Treat input parameters as read-only. Always return a new object with changes.
3. **Namespace Isolation**: In multi-tenant environments, pass `{ namespace: tenantId }` in execution options to isolate caches and checkpoints.

---

## API Reference Links

- [Sequential Workflows](./03-sequential-workflows.md)
- [Branching and Parallelism](./04-branching-and-parallelism.md)
- [Storage and Adapters](./07-storage-and-adapters.md)
