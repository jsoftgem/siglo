# Phase 1: Product Clarity and Reliability

## Goal

Make `fluid-func` predictable, coherent, and safe enough for production adoption before adding more orchestration primitives.

## Outcomes

- One clearly supported public API
- Consistent versioning and documentation
- Explicit execution semantics for failures, retries, cancellation, caching, and checkpoints
- Stable error metadata for debugging and operations
- Tests covering concurrency, failure recovery, and tenant isolation

## Workstreams

### 1. Public API and Package Consistency

#### Tasks

1. Choose `Step` and `flow` as the primary API vocabulary.
2. Keep `Chain`, `Pipeline`, and `pipe` as documented compatibility aliases only.
3. Review all exports from `../src/index.ts` and remove accidental internal exports.
4. Add package `exports` mappings for ESM, CommonJS, and TypeScript declarations.
5. Align `../package.json`, `CHANGELOG.md`, README badges, and published version.
6. Document supported Node.js and TypeScript versions.
7. Define a deprecation policy with migration examples.

#### Acceptance Criteria

- A new user can identify the recommended API from the README within one minute.
- ESM, CommonJS, and TypeScript consumers resolve the same supported API.
- Deprecated APIs emit documented migration guidance without breaking existing users.
- Package metadata and changelog describe the same release.

### 2. Execution Semantics

Create a formal execution contract covering:

- Whether step outputs merge into the working context or replace it
- How `undefined`, `null`, primitives, and objects are handled
- Whether a failed step leaves a checkpoint
- What happens when a retry callback returns a fallback
- Whether lifecycle hooks run during retries
- How nested flows contribute to step history
- Whether cache hits run `onAfter`
- How flow-level and step-level timeouts interact
- Whether adapter failures fail the workflow or are best effort

Record the contract in `../docs/execution-semantics.md` and test every rule.

### 3. Error Model

Introduce a consistent base error shape:

```ts
interface ExecutionErrorMetadata {
  workflowId?: string;
  stackId?: string;
  tenantId?: string;
  stepId?: string;
  stepName?: string;
  attempt?: number;
  phase?: 'validation' | 'before' | 'action' | 'after' | 'retry' | 'checkpoint';
  retryable?: boolean;
  cause?: unknown;
}
```

#### Tasks

1. Add a base `FluidFuncError`.
2. Make timeout, validation, retry, cancellation, and storage errors preserve `cause`.
3. Attach workflow and step metadata at the point of failure.
4. Normalize rejection shapes so callers receive an `Error`-compatible object.
5. Preserve original errors while adding context.
6. Add safe serialization for operational logs.

#### Acceptance Criteria

- Every failed execution identifies the workflow and failing step when available.
- Error causes are preserved through retries and nested flows.
- Cancellation and timeout errors can be distinguished programmatically.

### 4. Retry, Timeout, and Cancellation Contract

#### Tasks

1. Define retryable error classification.
2. Support explicit retry predicates.
3. Record attempt number and delay in lifecycle context.
4. Ensure flow deadlines include retry delays.
5. Ensure step deadlines are reset per retry attempt.
6. Propagate a combined `AbortSignal` to every action and hook that can block.
7. Document that cancellation is cooperative when a dependency ignores `AbortSignal`.
8. Prevent retries after a flow-level cancellation or deadline.
9. Add jitter bounds and deterministic test hooks.

#### Example API

```ts
step.onFail({
  maxRetries: 3,
  retryIf: (error) => error.code === 'ETIMEDOUT',
  backoff: 'exponential',
  delay: 100,
  maxDelay: 5000,
  jitter: true
});
```

#### Acceptance Criteria

- No retry occurs after cancellation.
- Total execution time respects the flow deadline, including backoff.
- A timed-out step receives an abort signal.
- Retry behavior is deterministic under a supplied test clock.

### 5. Cache Semantics

#### Tasks

1. Define cache key inputs and excluded internal fields.
2. Add a configurable key serializer.
3. Add cache hit/miss events.
4. Prevent cache stampedes with an in-flight promise map.
5. Define behavior for cached errors and rejected promises.
6. Add stale-while-revalidate as an optional policy.
7. Clarify whether cached outputs execute lifecycle hooks.
8. Make adapter cache errors configurable as strict or best effort.

#### Acceptance Criteria

- Equivalent inputs produce stable keys.
- Tenant and workflow namespaces cannot cross-contaminate.
- Concurrent identical calls do not invoke the action more than once when stampede protection is enabled.
- Cache behavior is documented for retries, hooks, and failures.

### 6. Checkpoint and Storage Reliability

#### Tasks

1. Add checkpoint schema version and serializer metadata.
2. Define atomic save behavior.
3. Add optimistic concurrency using a checkpoint revision.
4. Add storage adapter health/error modes:
   - `strict`
   - `warn`
   - `best-effort`
5. Stop silently swallowing adapter errors in strict mode.
6. Add checkpoint expiration and cleanup hooks.
7. Ensure restored checkpoints validate tenant and workflow identity.
8. Define what can and cannot be serialized.

#### Acceptance Criteria

- A stale checkpoint cannot silently overwrite a newer checkpoint.
- Invalid checkpoint versions fail with an actionable error.
- Storage adapter failures are observable and configurable.
- Sensitive values can be excluded or redacted before persistence.

### 7. Test Strategy

Add test groups for:

- Concurrent flow executions
- Concurrent tenants
- Frozen input objects
- Nested flows
- Retry plus timeout interactions
- Cancellation during action and backoff
- Cache hits, misses, expiration, and stampedes
- Adapter failures
- Checkpoint corruption and version mismatch
- Process-style restart and restore simulation

Use fake timers and controllable promises for timing-sensitive tests.

## Suggested Deliverables

- `../docs/execution-semantics.md`
- `../docs/error-model.md`
- `../docs/storage-contract.md`
- Typed error metadata
- Stable package exports
- Expanded integration test suite
- Updated README and migration guide

## Dependencies

This phase should precede parallel branches, durable waits, and external queue adapters. Those features depend on stable failure and persistence semantics.

