# Phase 2: Core Workflow Power

## Goal

Expand `fluid-func` from sequential pipelines into a useful workflow runtime with branching, parallelism, concurrency control, idempotency, compensation, and durable waits.

## Outcomes

- Workflows can express common control-flow patterns without custom orchestration code.
- Parallel work has explicit failure and cancellation semantics.
- Side effects can be made safe under retries and at-least-once execution.
- Long-running workflows can pause for external events and resume safely.

## Workstreams

### 1. Workflow Graph Model

Introduce an internal graph representation while preserving the existing sequential `flow(...)` API.

```ts
type WorkflowNode =
  | StepNode
  | SequenceNode
  | ParallelNode
  | BranchNode
  | WaitNode
  | MapNode;
```

#### Tasks

1. Assign stable IDs to workflow nodes.
2. Preserve human-readable names for logs and step history.
3. Validate graph structure before execution.
4. Detect cycles unless explicitly supported.
5. Keep graph definitions separate from runtime execution state.
6. Provide a graph inspection API for tooling.

### 2. Parallel Execution

Add explicit combinators:

```ts
parallel(stepA, stepB)
all([stepA, stepB])
race(stepA, stepB)
```

#### Design Decisions

- `parallel` should default to fail-fast and cancel siblings.
- `allSettled` should preserve every result and error.
- `race` should cancel losing branches when possible.
- Branches should receive a safe copy or isolated view of context.
- Merge behavior must be explicit when branches write the same field.

#### Example

```ts
const prepareOrder = flow(
  validateOrder,
  parallel(
    reserveInventory,
    authorizePayment,
    calculateTax
  ),
  joinOrderPreparation
);
```

#### Acceptance Criteria

- Independent steps execute concurrently.
- Fail-fast cancellation does not leave unresolved branch promises.
- Shared output collisions are detected or resolved by a declared strategy.
- The final result preserves branch-level history and timing.

### 3. Conditions and Branching

Add:

```ts
when(predicate, step)
branch({
  approved: approvedFlow,
  declined: declinedFlow
})
```

#### Tasks

1. Define predicates that receive typed context and execution metadata.
2. Record skipped branches in history.
3. Support fallback output for skipped steps.
4. Ensure only the selected branch mutates the active context.
5. Include branch choice in traces and checkpoints.
6. Validate branch output compatibility.

### 4. Mapping and Concurrency Limits

Add a controlled collection primitive:

```ts
map(items, processItem, {
  concurrency: 10,
  stopOnError: false
});
```

#### Tasks

1. Support arrays and async iterables.
2. Add bounded concurrency.
3. Preserve input order optionally.
4. Support fail-fast and collect-errors modes.
5. Propagate cancellation to active and queued items.
6. Add per-item metadata and retry accounting.
7. Prevent unbounded memory growth for async iterables.

### 5. Idempotency

Introduce an idempotency interface:

```ts
interface IdempotencyStore {
  claim(key: string, ttlMs?: number): Promise<'claimed' | 'completed' | 'in-progress'>;
  complete(key: string, result: unknown): Promise<void>;
  fail(key: string, error: unknown): Promise<void>;
}
```

#### Tasks

1. Support workflow-level and step-level idempotency keys.
2. Define behavior for an in-progress duplicate.
3. Store completed results where safe.
4. Bind keys to tenant and workflow version.
5. Add Redis-compatible reference implementation outside core.
6. Document side-effect boundaries and idempotency requirements.

### 6. Compensation and Sagas

Add optional compensation handlers:

```ts
const reserveInventory = Step.create(reserve)
  .compensate(releaseInventory);
```

#### Tasks

1. Record successful compensatable steps.
2. Execute compensations in reverse order.
3. Define compensation retry policy.
4. Distinguish original failure from compensation failure.
5. Persist compensation progress in checkpoints.
6. Support manual compensation restart.
7. Make compensation opt-in and explicit.

#### Acceptance Criteria

- A failed multi-step workflow can execute compensations deterministically.
- Compensation failures remain visible and actionable.
- A process restart does not repeat completed compensations incorrectly.

### 7. Durable Waits and External Events

Add a wait abstraction:

```ts
await workflow.run(input, {
  durable: true
});

const approval = await waitForEvent('order.approved', {
  correlationKey: (ctx) => ctx.orderId,
  timeout: '24h'
});
```

#### Tasks

1. Persist workflow status as `waiting`.
2. Persist the continuation node and required context.
3. Release in-memory resources while waiting.
4. Resume using a validated event correlation key.
5. Support expiration and timeout paths.
6. Reject duplicate or late events safely.
7. Provide an explicit resume API.

### 8. Workflow Versioning

#### Tasks

1. Add a workflow version identifier to durable executions.
2. Define compatibility rules for resumed workflows.
3. Support migration functions for checkpoint state.
4. Reject incompatible versions with clear errors.
5. Document deployment strategies for long-running workflows.

## Suggested Deliverables

- Workflow graph model
- `parallel`, `all`, `race`, `when`, `branch`, and `map`
- Idempotency interface
- Compensation API
- Durable wait/resume API
- Graph validation and inspection utilities
- Comprehensive concurrency and recovery tests

## Dependencies

This phase depends on Phase 1’s error, cancellation, checkpoint, and execution semantics. Phase 3 adapters should consume these stable primitives rather than define their own behavior.

