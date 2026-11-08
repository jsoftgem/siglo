---
title: 'Error Model & Exception Hierarchy'
description: 'Comprehensive exception hierarchy rooted at SigloError: timeout, cancellation, spec validation, optimistic concurrency, durable events, sagas, network egress, and error normalization.'
---

Siglo v1.0.0 introduces a structured, predictable error hierarchy rooted at `SigloError`. Every exception attaches execution metadata—including lifecycle phase, step name, execution stack UUID, tenant namespace, retryability flag, and original cause.

---

## 1. Exception Hierarchy

```
Error
 └── SigloError (base class with metadata and serialization)
      ├── Timeout & Cancellation
      │    ├── StepTimeoutException
      │    ├── FlowTimeoutException
      │    └── CancellationException
      ├── Validation & Spec
      │    ├── ValidationException
      │    └── GraphValidationException
      ├── Storage & Optimistic Concurrency
      │    ├── StorageAdapterException
      │    ├── CheckpointConflictException
      │    ├── OptimisticLockException
      │    ├── NamespaceMismatchException
      │    └── CheckpointVersionException
      ├── Idempotency & Concurrency
      │    ├── IdempotencyConflictException
      │    └── FieldCollisionException
      ├── Durable & Event Lifecycle
      │    ├── WorkflowSuspendedException
      │    ├── WorkflowAlreadyResumedException
      │    ├── DuplicateEventException
      │    ├── ExpiredWaitException
      │    └── WorkflowVersionMismatchException
      ├── Sagas & Compensations
      │    ├── CompensationException
      │    └── UnresolvableCompensationException
      └── Security & Network Guardrails
           └── NetworkPolicyViolationException
```

All errors inherit standard `Error` properties (`name`, `message`, `stack`) while attaching point-of-failure execution context.

---

## 2. Common Metadata Fields (`ExecutionErrorMetadata`)

Every `SigloError` includes the following metadata fields:

| Field           | Type                                                                         | Description                                                 |
| --------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `phase`         | `'validation' \| 'before' \| 'action' \| 'after' \| 'checkpoint' \| 'retry'` | The exact lifecycle phase where the failure occurred.       |
| `stepName`      | `string` (optional)                                                          | The human-readable name of the step that failed.            |
| `stepId`        | `string` (optional)                                                          | The unique internal UUID of the failing step instance.      |
| `stackId`       | `string` (optional)                                                          | The unique UUID of the execution stack.                     |
| `namespace`     | `string` (optional)                                                          | The namespace identifier for multi-tenant executions.       |
| `workflowId`    | `string` (optional)                                                          | The workflow identifier if designated in execution options. |
| `retryable`     | `boolean`                                                                    | Whether this error is eligible for automated retry.         |
| `stateSnapshot` | `Record<string, any>` (optional)                                             | Sanitized snapshot of the context when the error occurred.  |
| `cause`         | `unknown` (optional)                                                         | The original caught exception or rejection reason.          |

---

## 3. Specialized Exception Types

### Timeout & Cancellation

#### `StepTimeoutException`

Thrown when an individual step execution exceeds its specified `step.timeout(ms)`.

- **Properties**: `stepName: string`, `timeoutMs: number`, `elapsedMs?: number`
- **Default `phase`**: `'action'`, **Default `retryable`**: `true`

#### `FlowTimeoutException`

Thrown when the entire flow execution exceeds its configured `flow.timeout(ms)` or `options.timeout`.

- **Properties**: `stackId: string`, `timeoutMs: number`, `completedSteps: number`
- **Default `phase`**: `'action'`, **Default `retryable`**: `false`

#### `CancellationException`

Thrown when an execution is aborted via an `AbortSignal`.

- **Properties**: `reason?: any`
- **Default `phase`**: `'action'`, **Default `retryable`**: `false`

---

### Validation & Graph Specification

#### `ValidationException`

Thrown when a step's input specification or schema validator rejects (`Step.spec` or validator callback).

- **Properties**: `field?: string`, `schemaErrors?: any`
- **Default `phase`**: `'validation'`, **Default `retryable`**: `false`

#### `GraphValidationException`

Thrown when static graph validation fails during `assertValidGraph()`.

- **Properties**: `errors: string[]`
- **Default `phase`**: `'validation'`, **Default `retryable`**: `false`

---

### Storage & Optimistic Concurrency

#### `StorageAdapterException`

Thrown when a configured `StorageAdapter` throws an error and storage error mode is `'strict'`.

- **Properties**: `operation: string`, `adapterName?: string`, `originalError?: unknown`
- **Default `phase`**: `'checkpoint'`, **Default `retryable`**: `false`

#### `CheckpointConflictException`

Thrown when optimistic revision check fails in storage (`options.expectedRevision !== currentRevision`).

- **Properties**: `stackId: string`, `currentRevision: number`, `attemptedRevision?: number`, `expectedRevision?: number`
- **Default `phase`**: `'checkpoint'`, **Default `retryable`**: `true`

#### `OptimisticLockException`

Thrown when concurrent workers experience a CAS version conflict when claiming wait records or updating stack state.

- **Properties**: `stackId: string`, `currentVersion?: number`, `expectedVersion?: number`
- **Default `phase`**: `'checkpoint'`, **Default `retryable`**: `true`

#### `NamespaceMismatchException`

Thrown when restoring a checkpoint created for a different namespace than the caller's expected namespace.

- **Properties**: `expectedNamespace: string`, `actualNamespace: string`
- **Default `phase`**: `'checkpoint'`, **Default `retryable`**: `false`

#### `CheckpointVersionException`

Thrown when restoring a checkpoint produced by an incompatible future schema version (`version > 2`).

- **Properties**: `version: number`
- **Default `phase`**: `'checkpoint'`, **Default `retryable`**: `false`

---

### Idempotency & State Concurrency

#### `IdempotencyConflictException`

Thrown when another worker or request is concurrently executing with the same claimed idempotency key.

- **Properties**: `key: string`, `inProgressStackId?: string`
- **Default `phase`**: `'action'`, **Default `retryable`**: `false`

#### `FieldCollisionException`

Thrown when step execution attempts to overwrite reserved engine metadata fields (e.g. `$steps`, `$history`).

- **Properties**: `key: string`
- **Default `phase`**: `'action'`, **Default `retryable`**: `false`

---

### Durable Waits & Resumption

#### `WorkflowSuspendedException`

Thrown when a workflow without `{ durable: true }` encounters a durable wait combinator (`waitForEvent` or `wait`).

- **Properties**: `waitingRecord: WaitingWorkflowRecord`
- **Default `phase`**: `'action'`, **Default `retryable`**: `false`

#### `WorkflowAlreadyResumedException`

Thrown when an external trigger attempts to resume a wait record that has already been claimed or completed in storage.

- **Properties**: `correlationKey: string`
- **Default `phase`**: `'action'`, **Default `retryable`**: `false`

#### `DuplicateEventException`

Thrown when an event is dispatched to an in-memory wait record that is not in `'waiting'` status.

- **Properties**: `correlationKey: string`, `eventName?: string`
- **Default `phase`**: `'action'`, **Default `retryable`**: `false`

#### `ExpiredWaitException`

Thrown when an event or action token arrives after the wait timeout deadline has elapsed.

- **Properties**: `correlationKey: string`, `expiredAt: number`, `eventName?: string`
- **Default `phase`**: `'action'`, **Default `retryable`**: `false`

#### `WorkflowVersionMismatchException`

Thrown when resuming a suspended workflow with mismatched version code and no migration function is supplied.

- **Properties**: `expectedVersion: any`, `actualVersion: any`
- **Default `phase`**: `'checkpoint'`, **Default `retryable`**: `false`

---

### Sagas & Compensations

#### `CompensationException`

Thrown when one or more compensation rollback handlers fail during forward execution failure recovery.

- **Properties**: `originalError: Error`, `compensationErrors: any[]`, `completedCompensations: string[]`
- **Default `phase`**: `'action'`, **Default `retryable`**: `false`

#### `UnresolvableCompensationException`

Thrown when a step references a named compensation handler that was not registered via `registerCompensationHandler()`.

- **Properties**: `handlerName: string`, `stepName: string`
- **Default `phase`**: `'action'`, **Default `retryable`**: `false`

---

### Network Guardrails

#### `NetworkPolicyViolationException`

Thrown when an outbound HTTP, HTTPS, `fetch`, or raw TCP socket connection is blocked by the active ASL network egress perimeter.

- **Properties**: `requestedUrl: string`, `requestedHost: string`, `allowedHosts: (string | RegExp)[]`
- **Default `phase`**: `'action'`, **Default `retryable`**: `false`

---

## 4. Normalization & Cause Preservation

Any non-`SigloError` (e.g. built-in `TypeError`, third-party network error, or string literal rejection) is normalized via `normalizeError(err, metadata)`:

- If `err` is already a `SigloError`, the point-of-failure metadata is enriched without overwriting existing fields.
- If `err` is a standard `Error`, it is wrapped into a `SigloError`, setting `err.cause = originalError`.
- If `err` is a string or primitive, the string is used as the message.
- For backward compatibility with v1.x, `err.stackId` and `err.error` reference the error cause.

---

## 5. JSON Serialization (`toJSON()`)

Every `SigloError` instance implements `toJSON()` for structured logging, telemetry emission, and network transmission:

```ts
try {
    await flow(myStep).run();
} catch (err) {
    if (err instanceof SigloError) {
        console.error(JSON.stringify(err.toJSON(), null, 2));
    }
}
```

Produces:

```json
{
    "name": "SigloError",
    "message": "Payment gateway timeout",
    "phase": "action",
    "stepName": "processPayment",
    "stepId": "d1c5a7...",
    "stackId": "7e34b1...",
    "namespace": "org-42",
    "retryable": true,
    "cause": {
        "name": "FetchError",
        "message": "ETIMEDOUT"
    },
    "stack": "..."
}
```
