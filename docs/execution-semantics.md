# Execution Semantics Contract

This document provides a formal, binding contract for the runtime execution semantics of `Rivulet` v1.0.0.

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
- In addition, `$steps` and `$history` accessors provide indexed and named snapshots of the output of preceding steps (e.g. `param.$steps('stepName')` or `param.$steps[0]`).
- If step $N$ writes a key `foo` and step $N+1$ writes a key `bar`, step $N+2$ receives both `foo` and `bar`. If step $N+1$ writes `foo`, it overwrites the value of `foo` for downstream steps.

---

### 3. How do multiple steps with the same name behave?

- Every step instance is assigned an internal, immutable UUID (`$chainId` / `$stepId`).
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

Step execution progresses through 4 explicit lifecycle phases:
1. **`validation` / `spec`**: Schema validation or specification checks. If a spec validation fails, a `ValidationException` is created with `phase: 'validation'`.
2. **`before` (`onBefore` / plugin `before`)**: Lifecycle hooks that execute prior to the step action. Failures in `onBefore` are caught with `phase: 'before'`.
3. **`action` (`onStart` / step action)**: The primary business logic of the step.
4. **`after` (`onAfter` / plugin `after`)**: Lifecycle hooks that execute after action completion. Failures in `onAfter` are caught with `phase: 'after'`.

Any hook failure bypasses the remaining step logic and routes the error into `onFail`. If `onFail` does not recover, the flow terminates and rejects.

---

### 6. Are hook failures retryable?

- By default, failures occurring in `phase: 'action'` are considered retryable (`retryable: true`).
- Failures occurring in `phase: 'validation'`, `phase: 'before'`, or `phase: 'after'` are non-retryable by default unless explicitly configured via custom `retryIf` predicate in `onFail({ retryIf: ... })`.
- If a custom `retryIf(err, attempt)` predicate returns `true`, retry occurs regardless of default phase classification.

---

### 7. When is a flow execution considered started, completed, failed, or cancelled?

- **`started`**: When `flow(...).execute()` (or `Step.start(...)`) allocates a stack UUID, initializes the execution state, registers the active timeout/cancellation listeners, and invokes the first step.
- **`completed`**: When the final step in the sequence resolves successfully (including its `onAfter` hooks) and state is deleted from memory or checkpointed with `status: 'completed'`.
- **`failed`**: When a step or hook error is not recovered by `onFail`, or when a flow deadline expires (`FlowTimeoutException`). The flow status is set to `'failed'`.
- **`cancelled`**: When an `AbortSignal` passed via `options.signal` emits an abort event. The flow halts immediately with `CancellationException` and status `'cancelled'`.

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
