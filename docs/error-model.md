# Error Model & Exception Hierarchy

Rivulet v1.0.0 introduces a structured, predictable error hierarchy rooted at `RivuletError`.

---

## 1. Exception Hierarchy

```
Error
 └── RivuletError (base class with metadata and serialization)
      ├── StepTimeoutException
      ├── FlowTimeoutException
      ├── CancellationException
      ├── ValidationException
      ├── StorageAdapterException
      ├── CheckpointConflictException
      ├── NamespaceMismatchException
      └── CheckpointVersionException
```

All errors inherit standard `Error` properties (`name`, `message`, `stack`) while attaching point-of-failure execution context.

---

## 2. Common Metadata Fields (`ExecutionErrorMetadata`)

Every `RivuletError` includes the following metadata fields:

| Field | Type | Description |
|---|---|---|
| `phase` | `'validation' \| 'before' \| 'action' \| 'after'` | The exact lifecycle phase where the failure occurred. |
| `stepName` | `string` | The human-readable name of the step that failed. |
| `stepId` | `string` | The unique internal UUID of the failing step instance. |
| `stackId` | `string` | The unique UUID of the execution stack. |
| `namespace` | `string` (optional) | The namespace identifier for multi-tenant executions. |
| `workflowId` | `string` (optional) | The workflow identifier if designated in execution options. |
| `retryable` | `boolean` | Whether this error is eligible for retry. |
| `stateSnapshot` | `Record<string, any>` (optional) | Sanitized snapshot of the context when the error occurred. |
| `cause` | `unknown` | The original caught exception or rejection reason. |

---

## 3. Specialized Exception Types

### `StepTimeoutException`
Thrown when an individual step execution exceeds its specified `timeout(ms)`.
- **Properties**: `stepName: string`, `timeoutMs: number`, `elapsedMs?: number`
- **Default `retryable`**: `true`

### `FlowTimeoutException`
Thrown when the entire flow execution exceeds its configured `timeout(ms)`.
- **Properties**: `stackId: string`, `timeoutMs: number`, `completedSteps: number`
- **Default `retryable`**: `false`

### `CancellationException`
Thrown when an execution is aborted via `AbortSignal`.
- **Properties**: `reason?: any`
- **Default `retryable`**: `false`

### `ValidationException`
Thrown when a step's input specification or schema validator rejects.
- **Properties**: `field?: string`, `schemaErrors?: any`
- **Default `retryable`**: `false`

### `StorageAdapterException`
Thrown when a configured `StorageAdapter` throws an error and storage error mode is `'strict'`.
- **Properties**: `operation: string`, `adapterName?: string`, `originalError?: unknown`

### `CheckpointConflictException`
Thrown when optimistic concurrency check fails (`options.expectedRevision !== currentRevision`).
- **Properties**: `stackId: string`, `currentRevision: number`, `attemptedRevision?: number`, `expectedRevision?: number`

### `NamespaceMismatchException`
Thrown when restoring a checkpoint created for a different namespace than the expected namespace.
- **Properties**: `expectedNamespace: string`, `actualNamespace: string`

### `CheckpointVersionException`
Thrown when restoring a checkpoint produced by an incompatible future schema version.
- **Properties**: `version: number`

---

## 4. Normalization & Cause Preservation

Any non-`RivuletError` (e.g. built-in `TypeError`, third-party network error, or string literal rejection) is normalized via `normalizeError(err, metadata)`:
- If `err` is already a `RivuletError`, the point-of-failure metadata is enriched without overwriting.
- If `err` is a standard `Error`, it is wrapped into a `RivuletError`, setting `err.cause = originalError`.
- If `err` is a string or primitive, the string is used as the message.
- For backward compatibility with v1.x, `err.stackId` and `err.error` reference the error cause.

---

## 5. JSON Serialization (`toJSON()`)

Every `RivuletError` instance implements `toJSON()` for safe logging and transmission across networks:

```ts
try {
  await flow(myStep).execute();
} catch (err) {
  if (err instanceof RivuletError) {
    console.error(JSON.stringify(err.toJSON(), null, 2));
  }
}
```

Produces:
```json
{
  "name": "RivuletError",
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
