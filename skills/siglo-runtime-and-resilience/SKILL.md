---
name: siglo-runtime-and-resilience
description: 'Manage runtime execution controls, cooperative cancellation, dependency injection, and structured error handling across Siglo workflows. Use when configuring `ExecutionOptions` (`signal: AbortSignal`, `services`, `timeout`, `namespace`, `pojo`), aborting workflows cleanly with cooperative cancellation (`CancellationException`), injecting dependencies (`withDependencies`, `requireDependency`), navigating the strongly-typed `SigloError` hierarchy, normalizing errors (`normalizeError`), managing Saga Dead-Letter escalations (`UnresolvableCompensationException`), configuring dynamic retry predicates (`retryIf`), and validating workflow AST graphs (`validateGraph`).'
---

# Siglo Runtime and Resilience

Workflows running in mission-critical environments require strict deadline controls, cooperative cancellation, dependency injection, structured error taxonomy, and resilient Saga recovery.

**Siglo** provides fine-grained runtime execution control through `ExecutionOptions` and a strongly-typed exception model rooted at `SigloError`.

---

## 1. Runtime Mental Model & Execution Options

Runtime execution is governed by `flow.run(input, options)` or `step.run(input, options)` (for both `Step.create` and `Step.compute`).

```typescript
export interface ExecutionOptions<TContext = any> {
    /** Cooperative cancellation signal aborting async steps and retry delays */
    signal?: AbortSignal;

    /** Overall workflow SLA deadline as milliseconds or duration string (e.g. '10s', '5m') */
    timeout?: DurationInput;
    timeoutMs?: DurationInput;

    /** Workflow-level idempotency key or synchronous context resolver */
    idempotencyKey?: DynamicOption<string, TContext>;
    idempotencyTtlMs?: DurationInput;

    /** Dependency injection container accessible inside steps */
    services?: Record<string, any>;

    /** Multi-tenant domain partitioning for logs, checkpoints, and DevTools */
    namespace?: string;

    /** Strip reactive proxy wrappers into clean plain JavaScript objects (default: true) */
    pojo?: boolean;

    /** Enable durable checkpoint persistence on wait/suspend */
    durable?: boolean;

    /** Network egress perimeter enclosing nested combinators, sub-flows, and compensations */
    networkPolicy?: NetworkPolicyConfig;

    /** Global step lifecycle interception hook */
    stepExecutionHook?: StepExecutionHook;
}
```

```mermaid
flowchart TD
    Run["flow.run(input, options)"] --> Context["Initialize Runtime Context"]
    Context --> Signal["AbortSignal Listener"]
    Context --> Services["Services Dependency Container"]
    Context --> Deadline["SLA Timeout Timer"]

    Signal -.->|abort()| Cancel["Abort In-Flight Steps & Retry Delays<br/>Throw CancellationException"]
    Deadline -.->|exceeded| Timeout["Abort Workflow<br/>Throw FlowTimeoutException"]

    Context --> Steps["Execute Steps"]
    Steps --> Hook["stepExecutionHook(before / after)"]
    Steps --> ErrCheck{"Error Thrown?"}
    ErrCheck -->|Yes| Norm["normalizeError(err, metadata)"]
    Norm --> RetryCheck{"retryIf(err, attempt)? (sync)"}
    RetryCheck -->|Yes| Backoff["Exponential Backoff Sleep<br/>(Respects AbortSignal)"]
    RetryCheck -->|No| Compensate["LIFO Saga Rollback<br/>(Under Captured ASL NetworkPolicy)"]
    Compensate --> DLQ{"Compensation Throws?"}
    DLQ -->|Yes| Unres["UnresolvableCompensationException (DLQ)"]
```

---

## 2. Cooperative Cancellation (`signal: AbortSignal`)

When workflows run long operations (e.g. streaming batches, retry loops, durable timer sleeps), user cancellations or HTTP disconnections should cleanly abort downstream tasks without leaking resources.

Pass standard `AbortController.signal` into `flow.run()`:

```typescript
import { CancellationException } from '@siglo/core';
import { orderFlow } from './order.flow';

const controller = new AbortController();

// Cancel execution on client disconnect or shutdown signal
setTimeout(() => {
    controller.abort(new Error('User cancelled the checkout process.'));
}, 5000);

try {
    const result = await orderFlow.run(input, {
        signal: controller.signal,
    });
} catch (err) {
    if (err instanceof CancellationException) {
        console.warn(`Workflow was cancelled at step: ${err.metadata.stepName}`);
        console.warn(`Reason: ${err.cause?.message}`);
        // In-flight retry sleeps and steps were cleanly aborted
    }
}
```

### Cancellation Guarantees

1. **Pre-Flight Check on Synchronous Compute Batches**: Every `Step.compute` step checks `options.signal?.aborted` prior to execution and throws `CancellationException` immediately if aborted.
2. **Delays Abort Immediately**: If a step is waiting in an exponential backoff retry sleep or `wait()` timer, `signal.abort()` wakes up the timer instantly rather than waiting for the timeout to elapse.
3. **Fetch Aborts Automatically**: If steps use `fetch` or HTTP clients with standard signals, the underlying network connection terminates immediately.
4. **Compensations Run Safely**: Active compensations for already-completed steps execute under their captured ASL `networkPolicy` perimeter and unwind predictably.

---

## 3. Dependency Injection in Steps

Inject services, database connections, and third-party API clients into workflows at runtime without hardcoding imports:

### Option A: Via `ExecutionOptions.services`

```typescript
const result = await orderFlow.run(input, {
    services: {
        db: dbConnectionPool,
        stripe: stripeClient,
        metrics: datadogClient,
    },
});
```

Access injected services inside steps via `step.requireDependency(key)` or `param.$services`:

```typescript
import { Step } from '@siglo/core';

export const saveOrderStep = Step.create('saveOrder', async (param, current, index) => {
    // 1. Using requireDependency (throws descriptive error if missing)
    const db = saveOrderStep.requireDependency<DatabasePool>('db');
    await db.query('INSERT INTO orders ...');

    return { saved: true };
});
```

### Option B: Attached Directly via `step.withDependencies()`

Attach mock or fixed services directly to an individual step instance:

```typescript
export const callPaymentStep = Step.create('callPayment', async () => {
    const gateway = callPaymentStep.requireDependency<PaymentGateway>('gateway');
    return await gateway.charge();
}).withDependencies({
    gateway: productionPaymentGateway,
});
```

---

## 4. The Strongly-Typed `SigloError` Taxonomy

All framework exceptions inherit from `SigloError` and carry structured metadata:

```typescript
export class SigloError extends Error {
    readonly metadata: {
        stepName?: string;
        phase?: 'validation' | 'before' | 'action' | 'after' | 'compensation';
        retryable: boolean;
        stackId?: string;
        namespace?: string;
    };
    readonly cause?: any;
}
```

### Categorized Exception Hierarchy

| Category                      | Exception Class                     | `retryable` | Description                                                                                             |
| :---------------------------- | :---------------------------------- | :---------- | :------------------------------------------------------------------------------------------------------ |
| **Deadlines & Cancellation**  | `StepTimeoutException`              | `true`      | Individual step exceeded `.timeout(ms)`.                                                                |
|                               | `FlowTimeoutException`              | `false`     | Entire workflow exceeded `options.timeout` (checked before each step, including `Step.compute` batches). |
|                               | `CancellationException`             | `false`     | Execution aborted via `AbortSignal`.                                                                    |
| **Validation & Schema**       | `ValidationException`               | `false`     | `.schema()` or `.spec()` rejected context, or an async `.spec()` callback/schema was passed to `Step.compute`. |
|                               | `SigloError` (`phase: 'action'`)    | `false`     | `Step.compute` action or `keySerializer` returned a Promise/thenable at runtime.                        |
|                               | `GraphValidationException`          | `false`     | Static workflow graph AST validation failed (e.g. cycle detected).                                      |
| **Sagas & Rollback**          | `CompensationException`             | `false`     | An error occurred during Saga compensation rollback.                                                    |
|                               | `UnresolvableCompensationException` | `false`     | A compensation handler threw an error that could not be resolved (Saga DLQ).                            |
| **Concurrency & Idempotency** | `IdempotencyConflictException`      | `false`     | Concurrent execution with identical key is already in progress.                                         |
|                               | `FieldCollisionException`           | `false`     | Parallel branches attempted to write conflicting keys to context.                                       |
| **Security & Guardrails**     | `NetworkPolicyViolationException`   | `false`     | Outbound network egress blocked by security perimeter policy or `Step.compute` always-deny boundary.    |
| **Durable & Storage**         | `WorkflowSuspendedException`        | `false`     | Normal suspension signal at `waitForEvent` or `wait`.                                                   |
|                               | `ExpiredWaitException`              | `false`     | Event wait deadline expired before resume payload arrived.                                              |
|                               | `CheckpointConflictException`       | `true`      | Optimistic Concurrency Control (OCC) version mismatch.                                                  |

---

## 5. Error Normalization (`normalizeError`)

Third-party libraries, network errors, or legacy code may throw non-`Error` types (strings, plain objects). Siglo exposes `normalizeError()` to safely transform any thrown value into a typed `SigloError`:

```typescript
import { normalizeError, SigloError } from '@siglo/core';

try {
    await externalService.call();
} catch (rawErr) {
    const sigloErr: SigloError = normalizeError(rawErr, {
        stepName: 'callService',
        phase: 'action',
        retryable: true,
    });

    console.error(sigloErr.message);
    console.error(sigloErr.metadata.stepName); // 'callService'
}
```

---

## 6. Saga Failure Escalation & Dead-Letter Handling

When a regular step or downstream `Step.compute` step fails, Siglo executes registered compensations from prior completed steps in reverse LIFO order. Each compensation record captures the effective ASL `networkPolicy` perimeter (intersected across step, flow, run options, and any enclosing `networkPolicyStorage`) and enforces it during both automatic rollbacks and checkpoint-hydrated `flow.compensate(stackId, options)` calls.

If a **compensation itself** fails, Siglo captures the failure as an `UnresolvableCompensationException` to prevent masking the root cause and registers a dead-letter compensation record:

```typescript
import { Step, flow, UnresolvableCompensationException } from '@siglo/core';

const riskyCompensation = Step.create('allocateResource', async () => ({ resId: 'res-1' })).compensate(
    async ({ resId }) => {
        // If external system is down, this throws
        await externalSystem.deallocate(resId);
    },
    { maxRetries: 3, delay: '500ms' }, // Delay accepts DurationInput (number | string); retryIf stays sync
);

try {
    await flow(riskyCompensation, failingStep).run({});
} catch (err) {
    if (err instanceof UnresolvableCompensationException) {
        console.error(`CRITICAL: Saga compensation failed for step ${err.metadata.stepName}`);
        console.error(`Original failure cause:`, err.originalError);
        console.error(`Compensation error:`, err.compensationError);
        // Forward to Ops alert or Dead-Letter Queue (DLQ)
    }
}
```

---

## 7. Global Step Execution Interception (`stepExecutionHook`)

Use `stepExecutionHook` (or `flow.hook(fn)`) to wrap every step execution with custom profiling, OpenTelemetry spans, or audit logging:

```typescript
const result = await orderFlow.run(input, {
    stepExecutionHook: async (stepContext, next) => {
        const start = performance.now();
        try {
            const output = await next();
            console.log(`[Metric] Step ${stepContext.stepName} completed in ${performance.now() - start}ms`);
            return output;
        } catch (err) {
            console.error(`[Alert] Step ${stepContext.stepName} failed on attempt ${stepContext.attempt}`);
            throw err;
        }
    },
});
```

---

## 8. Pre-Flight Graph Validation (`validateGraph`, `assertValidGraph`)

Before deploying or booting a service, validate workflow AST structures to catch cycles, orphaned branches, or duplicate step IDs at startup:

```typescript
import { validateGraph, assertValidGraph, GraphValidationException } from '@siglo/core';

// 1. Non-throwing inspection
const report = validateGraph(orderFlow.toGraph());
if (!report.valid) {
    console.error('Graph validation issues:', report.errors);
}

// 2. Strict startup assertion (throws GraphValidationException if invalid)
assertValidGraph(orderFlow.toGraph());
```
