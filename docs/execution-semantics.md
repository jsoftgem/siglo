---
title: 'Execution Semantics Contract'
description: 'Formal runtime execution semantics, lifecycle phases, context accumulation, error propagation, network boundaries, and saga compensation contracts in Siglo.'
---

# Execution Semantics Contract

This document provides a formal, binding contract for the runtime execution semantics of `Siglo` v1.0.0.

---

### 1. What does a step return to the next step when it returns an object, a primitive, undefined, or a promise?

- **Object (`Record<string, any>`)**: The returned keys are shallow-merged into the execution context as clean plain JavaScript objects (POJOs). Properties are directly accessible without wrappers or getter closures, allowing native object destructuring.
- **Primitive (`string`, `number`, `boolean`, `symbol`, `bigint`, etc.)**: Primitive values cannot be keyed directly into an execution context object. They are wrapped as context accessors or mapped through custom reducers (`step.reduce('field')`). When executed as a single primitive step, the direct primitive value is returned.
- **`undefined`**: If a step action returns `undefined` (or no return statement), the existing context passes through intact to the next step without modifying or removing existing properties.
- **`Promise`**: If a step returns a `Promise` (or is declared `async`), the orchestrator awaits the promise resolution. Rejections trigger the step's failure lifecycle (`onFail`), while resolutions are handled according to the object/primitive/undefined rules above.

---

### 2. Does context accumulate across steps, or does each step receive only the preceding step's output?

Context **accumulates** across sequential steps within the same execution flow:

- Each step receives an aggregated parameter containing all previously accumulated context values.
- In addition, `$steps` and `$history` accessors provide indexed and named snapshots of the output of preceding steps (e.g. `param.$steps('stepName')`, `param.$steps.stepName`, or `param.$steps[0]`).
- If step $N$ writes a key `foo` and step $N+1$ writes a key `bar`, step $N+2$ receives both `foo` and `bar`. If step $N+1$ writes `foo`, it overwrites the value of `foo` for downstream steps.

---

### 3. How do multiple steps with the same name behave?

- Every step instance is assigned an internal, immutable UUID (`$stepId`).
- Steps sharing the same descriptive name (e.g. two steps named `'processChunk'`) execute independently according to their sequence position.
- In `$steps` / `$history`, named lookups return the output of the most recent step with that name.
- Cache keys incorporate the step's unique identifier and hashed inputs, preventing name collisions unless explicitly shared via custom `cacheOptions.keySerializer`.

---

### 4. What happens when a step throws synchronously vs returning a rejected promise?

- Both synchronous exceptions (via `throw`) and asynchronous rejections (via `Promise.reject` or rejected async functions) are intercepted identically.
- Synchronous exceptions are caught immediately, tagged with `phase: 'action'` and the corresponding `stepName`, and routed to the `onFail` lifecycle hook.
- Promises that reject are intercepted via promise rejection handlers, tagged with `phase: 'action'` and `stepName`, and routed to the `onFail` lifecycle hook.
- In both cases, timeouts are immediately cleared to avoid orphaned timer callbacks.

---

### 5. What happens when a step hook throws?

Step execution progresses through 6 explicit lifecycle phases:

1. **`validation` / `spec`**: Schema validation or specification checks. If a spec validation fails, a `ValidationException` is created with `phase: 'validation'`.
2. **`before` (`onBefore` / plugin `before`)**: Lifecycle hooks that execute prior to the step action. Failures in `onBefore` are caught with `phase: 'before'`.
3. **`action` (`Step.create` action / step action)**: The primary business logic of the step.
4. **`after` (`onAfter` / plugin `after`)**: Lifecycle hooks that execute after action completion. Failures in `onAfter` are caught with `phase: 'after'`.
5. **`checkpoint`**: State serialization or storage persistence operations. Failures are caught with `phase: 'checkpoint'`.
6. **`retry`**: Inter-attempt delay calculation or backoff operations.

Any hook failure bypasses the remaining step logic and routes the error into `onFail`. If `onFail` does not recover, the flow terminates and rejects.

---

### 6. Are hook failures retryable?

- By default, failures occurring in `phase: 'action'` are considered retryable (`retryable: true`).
- Failures occurring in `phase: 'validation'`, `phase: 'before'`, or `phase: 'after'` are non-retryable by default unless explicitly configured via custom `retryIf` predicate in `onFail({ retryIf: ... })`.
- If a custom `retryIf(err, attempt)` predicate returns `true`, retry occurs regardless of default phase classification.

---

### 7. When is a flow execution considered started, completed, failed, cancelled, or waiting?

- **`started`**: When `flow(...).run()` (or `Step.start(...)`) allocates a stack UUID, initializes the execution state, registers the active timeout/cancellation listeners, and invokes the first step.
- **`completed`**: When the final step in the sequence resolves successfully (including its `onAfter` hooks) and state is deleted from memory or checkpointed with `status: 'completed'`.
- **`failed`**: When a step or hook error is not recovered by `onFail`, or when a flow deadline expires (`FlowTimeoutException`). The flow status is set to `'failed'`.
- **`cancelled`**: When an `AbortSignal` passed via `options.signal` emits an abort event. The flow halts immediately with `CancellationException` and status `'cancelled'`.
- **`waiting`**: When execution encounters a durable wait combinator (`waitForEvent` or `wait`) with `{ durable: true }`. Execution halts cleanly, records a wait record in storage, snapshots state, and yields status `'waiting'` without rejecting.

---

### 8. What is the lifecycle of state in memory when executions run concurrently?

- Each execution of a flow allocates a unique execution stack (`stackId`) in `StorageManager`.
- Contexts, stack metadata, step caches, and revision counters are isolated per `stackId`.
- Concurrent executions of identical or different flows never share or overwrite each other's execution stack or in-memory caches.
- When an execution concludes (`completed`, `failed`, or `cancelled`), `deleteStack(stackId)` purges the stack's in-memory contexts and temporary cache entries.
- Cross-execution persistence is achieved exclusively through configured `StorageAdapter` implementations.

---

### 9. Does a retry re-run only the failing step, the failed hook, or the entire flow from that step forward?

- A retry re-runs **only the failing step** (including its `onBefore`, `action`, and `onAfter` hooks).
- Upstream steps that have already succeeded are never re-executed.
- Downstream steps continue sequentially once the retried step successfully completes.
- Each retry attempt receives incremented `$attempt` and `$retryDelay` context metadata.

---

### 10. How does network egress policy enforcement behave across steps, concurrent branches, and asynchronous operations?

- **Policy Activation & Default Scope**: Unconfigured flows have no network policy enforcement (outbound traffic is unrestricted). When a network policy is declared on a flow (`flow.networkPolicy()`) or step (`step.allowNetwork()`, `step.networkPolicy()`), the policy activates and defaults to denying undeclared external network egress.
- **Propagation via `AsyncLocalStorage` (ASL)**: When a step action begins, its effective network policy is bound to Node's `AsyncLocalStorage` (`networkPolicyStorage.run(...)`). All nested async calls&mdash;promises, timeouts, microtasks, or third-party libraries (e.g. `axios`, `got`, `undici`, AWS SDK)&mdash;automatically inherit the enclosing step's policy store across asynchronous context transitions.
- **Concurrent Execution Isolation**: In concurrent execution constructs (`parallel`, `allSettled`, `map`), each parallel step executes within its own isolated ASL store on the single Node event loop. A network restriction or allowlist in one branch never leaks into or interferes with concurrent sibling branches. Operations running outside step execution (e.g. host server healthchecks, database connection pools, background log flushers) encounter no active policy store and proceed unrestricted.
- **Outer Perimeter Enforcement ("Flow Supersedes Step")**: The flow's network policy defines the outer permissible envelope. An individual step can only narrow permissions within what the flow permits (by specifying a subset of hosts or calling `.denyNetwork()`). Any attempt by a step to permit a host outside the flow's allowlist is rejected.
- **Localhost and Loopback Configuration**: When network policy is active, `allowLocalhost` defaults to `false`. When enabled (`allowLocalhost: true`), loopback hosts (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`) and local Unix domain socket IPC (`allowUnixSockets`) bypass network policy blocks, preserving local inter-process communication, local mock services, and container-local sidecars.
- **Multi-Layer Egress Interception**: Outbound traffic is governed across three runtime interception points:
    1. `globalThis.fetch`: Validates input URLs prior to request initiation.
    2. `node:http` and `node:https`: Patches `request` and `get` methods (covering legacy Node clients and libraries).
    3. `node:net.Socket.prototype.connect`: Enforces policy at the raw TCP/TLS socket layer.
- **Security Violation Classification**: When an unauthorized egress attempt is detected, execution aborts immediately with a `NetworkPolicyViolationException`. This error is tagged with `phase: 'action'` and `retryable: false`, ensuring security/policy violations fail fast without blind automated retries.

---

### 11. How do Saga compensations execute upon workflow failure?

- **LIFO Order**: Compensations execute in exact reverse order (Last-In, First-Out) of step completion. Only steps that completed successfully prior to the point of failure are compensated.
- **Execution Modes**:
    - `'strict'` _(default)_: Rollback aborts immediately upon the first failing compensation handler. Remaining compensations are halted.
    - `'best-effort'`: Siglo attempts every registered compensation even if one or more fail, aggregating all failures into `CompensationException`.
- **Payload & Input Preservation**: Handlers receive `(output, input, ctx)` snapshots captured at step completion time.
- **Named vs Inline Registrations**: For multi-process or durable workflows, handlers registered via `registerCompensationHandler(name, fn)` are resolved by name, surviving process restarts. Missing handlers throw `UnresolvableCompensationException`.

---

### 12. How does a resumed workflow continue without re-executing completed steps?

- When a workflow suspends at `waitForEvent` or `wait`, Siglo stores `continuationStepIndex` in the wait record.
- Upon `flow.resume(correlationKey, payload)` or `resumeWorkflow(...)`:
    1. State and `$steps` history snapshots are re-hydrated from the storage checkpoint.
    2. The external event payload is merged into the context.
    3. Execution resumes directly at `continuationStepIndex`. Preceding steps are never re-evaluated.
- Duplicate resumption calls throw `WorkflowAlreadyResumedException` (storage) or `DuplicateEventException` (in-memory).

---

### 13. What are the lifecycle semantics of idempotency claims?

- **Claim Phase**: An idempotency key is claimed before step execution begins (`store.claim(key, ttlMs)`).
    - If `'claimed'`: Step execution proceeds.
    - If `'completed'`: Cached output is returned immediately without executing step action or hooks.
    - If `'in-progress'`: Throws `IdempotencyConflictException` (or spin-waits if `settleTimeoutMs` is configured).
- **Atomic Commitment**: A step's claim transitions to `'completed'` atomically only after all `onAfter` hooks succeed.
- **Transient vs Permanent Failures**: If step action or hooks fail, the claim is released via `store.fail(key)` unless classified as a permanent business error via `isPermanentBusinessError(err)`.
