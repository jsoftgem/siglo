# Phase 4: TypeScript and Developer Experience

## Goal

Make complex workflows pleasant to design, type-check, test, inspect, and maintain in large TypeScript codebases.

## Outcomes

- Context types flow through composed steps.
- Workflow graphs are easy to understand visually.
- Tests can deterministically reproduce failures.
- Teams can scaffold and evolve workflows safely.

## Workstreams

### 1. Accumulated Context Inference

Move from broad `any` types toward compositional inference.

```ts
const workflow = flow(
  Step.create<{ userId: string }, { user: User }>(...),
  Step.create<{ user: User }, { account: Account }>(...)
);

const result = await workflow.run({ userId: 'user-1' });
// Promise<{ user: User; account: Account }>
```

#### Tasks

1. Define separate input, accumulated-context, and output generic types.
2. Implement type-level merging for sequential steps.
3. Define conflict behavior for duplicate output keys.
4. Infer optional fields from conditional branches.
5. Infer arrays and result unions from parallel nodes.
6. Preserve named step output types.
7. Expose an escape hatch for dynamic workflows.
8. Add compile-only type tests using `tsd` or an equivalent tool.

### 2. Typed Step History

Provide typed access where step names are compile-time literals:

```ts
const workflow = flow(
  Step.create('loadUser', loadUser),
  Step.create('loadAccount', loadAccount)
);

// Desired:
// context.$steps.loadUser.user
// context.$steps.loadAccount.account
```

#### Requirements

- Detect duplicate names when statically possible.
- Provide numeric fallback for anonymous steps.
- Keep runtime names and type-level names aligned.
- Avoid forcing names on users who do not need them.

### 3. Workflow Visualization

Add graph export APIs:

```ts
workflow.toMermaid();
workflow.toJSON();
workflow.toDot();
```

#### Diagram Information

- Step names and IDs
- Branches and merge points
- Retry policies
- Timeouts
- Compensation handlers
- Durable waits
- Cache configuration

Provide a VS Code-friendly output path and CLI integration.

### 4. Deterministic Test Utilities

Create a test package or test helpers:

```ts
const harness = createWorkflowHarness(workflow, {
  clock: fakeClock(),
  storage: inMemoryStorage(),
  random: deterministicRandom()
});
```

#### Features

- Fake timers
- Controlled promises
- Step mocks and spies
- Storage adapter fakes
- Signal cancellation controls
- Retry attempt assertions
- Checkpoint fixtures
- Event injection for durable waits
- Execution trace snapshots

### 5. Replay and Failure Reproduction

#### Tasks

1. Define a sanitized execution-record format.
2. Capture workflow version, input fixture, selected outputs, errors, and timing decisions.
3. Exclude secrets by default.
4. Replay deterministic portions without invoking external side effects.
5. Allow individual steps to be replaced with fixtures.
6. Compare replay output with the original execution.
7. Provide CLI support through Phase 3 tooling.

### 6. Dependency Injection and Testability

Support explicit runtime dependencies:

```ts
const workflow = flow(
  fetchUser.withDependencies({ users: userRepository }),
  charge.withDependencies({ payments: paymentGateway })
);
```

Alternatively, define a typed execution environment:

```ts
await workflow.run(input, {
  services: {
    users: userRepository,
    payments: paymentGateway
  }
});
```

Requirements:

- No hidden global service state
- Per-execution overrides
- Type-safe service access
- Clear behavior for missing dependencies
- Easy substitution in tests

### 7. Scaffolding and Templates

Add:

```bash
fluid-func init
fluid-func generate workflow order
fluid-func generate step authorize-payment
```

Templates should include:

- Strict TypeScript configuration
- Recommended directory structure
- Test harness
- Error handling
- Observability setup
- Storage adapter configuration
- Example workflow and integration test

### 8. Documentation Information Architecture

Organize documentation into:

1. Getting started
2. Core concepts
3. Sequential workflows
4. Branching and parallelism
5. Retries, timeouts, and cancellation
6. Durable workflows
7. Storage and adapters
8. Observability
9. Testing and replay
10. TypeScript reference
11. Migration and compatibility
12. Production operations

Every advanced feature should have:

- Minimal example
- Failure example
- Testing example
- Operational caveats
- API reference link

## Suggested Deliverables

- Accumulated-context type inference
- Typed named-step history
- Mermaid, JSON, and DOT graph export
- Deterministic workflow harness
- Replay fixture format and CLI support
- Dependency injection API
- Project and workflow generators
- Reorganized documentation

## Dependencies

This phase depends on the final workflow graph and execution model from Phase 2 and the CLI/observability foundations from Phase 3. Type inference should be designed alongside new combinators rather than added after their APIs are fixed.

