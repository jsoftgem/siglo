---
title: "Error Hierarchy & Exceptions"
description: "API reference for the SigloError exception model: timeouts, cancellations, schema validation, sagas, network policy violations, and error normalization."
---

# API Reference: Error Hierarchy & Exceptions (`SigloError`)

**Siglo** features a structured, strongly typed exception hierarchy rooted at `SigloError`. Every exception carries rich execution metadata—including the executing step name, lifecycle phase, retryability flag, execution stack ID, tenant namespace, state snapshots, and underlying error cause.

---

## Table of Contents

- [Exception Hierarchy Diagram](#exception-hierarchy-diagram)
- [Base Error: `SigloError`](#base-error-sigloerror)
- [Timeout and Cancellation Exceptions](#timeout-and-cancellation-exceptions)
  - [`StepTimeoutException`](#steptimeoutexception)
  - [`FlowTimeoutException`](#flowtimeoutexception)
  - [`CancellationException`](#cancellationexception)
- [Validation and Contract Exceptions](#validation-and-contract-exceptions)
  - [`ValidationException`](#validationexception)
  - [`GraphValidationException`](#graphvalidationexception)
- [Concurrency and Sagas Exceptions](#concurrency-and-sagas-exceptions)
  - [`CompensationException`](#compensationexception)
  - [`UnresolvableCompensationException`](#unresolvablecompensationexception)
  - [`FieldCollisionException`](#fieldcollisionexception)
  - [`IdempotencyConflictException`](#idempotencyconflictexception)
- [Network Guardrail Exceptions](#network-guardrail-exceptions)
  - [`NetworkPolicyViolationException`](#networkpolicyviolationexception)
- [Durable and Event Exceptions](#durable-and-event-exceptions)
  - [`WorkflowSuspendedException`](#workflowsuspendedexception)
  - [`WorkflowVersionMismatchException`](#workflowversionmismatchexception)
  - [`DuplicateEventException`](#duplicateeventexception)
  - [`ExpiredWaitException`](#expiredwaitexception)
  - [`WorkflowAlreadyResumedException`](#workflowalreadyresumedexception)
- [Storage Exceptions](#storage-exceptions)
  - [`StorageAdapterException`](#storageadapterexception)
  - [`CheckpointConflictException`](#checkpointconflictexception)
  - [`NamespaceMismatchException`](#namespacemismatchexception)
  - [`CheckpointVersionException`](#checkpointversionexception)
- [Error Normalization](#error-normalization)
  - [`normalizeError(error, metadata?)`](#normalizeerrorerror-metadata)
- [Handling Errors in Workflows](#handling-errors-in-workflows)

---

## Exception Hierarchy Diagram

```
Error
  └── SigloError
        ├── StepTimeoutException
        ├── FlowTimeoutException
        ├── CancellationException
        ├── ValidationException
        ├── GraphValidationException
        ├── CompensationException
        ├── UnresolvableCompensationException
        ├── IdempotencyConflictException
        ├── FieldCollisionException
        ├── NetworkPolicyViolationException
        ├── WorkflowSuspendedException
        ├── WorkflowVersionMismatchException
        ├── DuplicateEventException
        ├── ExpiredWaitException
        ├── WorkflowAlreadyResumedException
        ├── StorageAdapterException
        ├── CheckpointConflictException (OptimisticLockException)
        ├── NamespaceMismatchException
        └── CheckpointVersionException
```

---

## Base Error: `SigloError`

All runtime errors thrown by Siglo extend `SigloError`.

### Definition

```typescript
export interface ExecutionErrorMetadata {
    stepName?: string;
    phase?: 'validation' | 'before' | 'action' | 'after' | 'checkpoint' | 'retry' | 'compensation';
    retryable?: boolean;
    stackId?: string;
    namespace?: string;
    workflowId?: string;
    cause?: unknown;
    stateSnapshot?: Record<string, any>;
    [key: string]: any;
}

export class SigloError extends Error {
    readonly stepName?: string;
    readonly phase?: string;
    readonly retryable: boolean;
    readonly stackId?: string;
    readonly namespace?: string;
    readonly workflowId?: string;
    readonly stateSnapshot?: Record<string, any>;
    override readonly cause?: unknown;

    get isTimeout(): boolean;
    get isCancellation(): boolean;

    toJSON(): Record<string, any>;
}
```

### Properties

- `stepName`: Name of the step that was executing when the error occurred.
- `phase`: The lifecycle phase where failure occurred (`'validation'`, `'before'`, `'action'`, `'after'`, `'checkpoint'`, `'retry'`, or `'compensation'`).
- `retryable`: Boolean indicating whether the error is safe to retry under a retry policy.
- `stackId`: Execution stack UUID for correlating with logs and checkpoints.
- `namespace`: Multi-tenant partition namespace.
- `cause`: The underlying original error or exception.
- `stateSnapshot`: Context snapshot captured at the moment of failure.
- `isTimeout`: True if the error is a `StepTimeoutException` or `FlowTimeoutException`.
- `isCancellation`: True if the error was triggered by an `AbortSignal`.

---

## Timeout and Cancellation Exceptions

### `StepTimeoutException`

Thrown when a step exceeds its configured `step.timeout(ms)` SLA deadline.

```typescript
export class StepTimeoutException extends SigloError {
    readonly timeoutMs: number;
    readonly elapsedMs?: number;
}
```

- **Phase**: `'action'`
- **Retryable**: `true`

---

### `FlowTimeoutException`

Thrown when the total execution time of the workflow exceeds `flow.timeout(ms)` or `options.timeout`.

```typescript
export class FlowTimeoutException extends SigloError {
    readonly timeoutMs: number;
    readonly completedSteps: number;
    override readonly stackId: string;
}
```

- **Phase**: `'action'`
- **Retryable**: `false`

---

### `CancellationException`

Thrown when execution is aborted via an `AbortSignal`.

```typescript
export class CancellationException extends SigloError {
    constructor(message?: string, metadata?: ExecutionErrorMetadata);
}
```

- **Retryable**: `false`

---

## Validation and Contract Exceptions

### `ValidationException`

Thrown when incoming parameters fail `step.schema()` or `step.spec()` validation contracts. (Note: `step.strict()` filters out undeclared fields rather than throwing `ValidationException`).

```typescript
export interface ValidationErrorDetail {
    field: string;
    message?: string;
    error?: any;
    [key: string]: any;
}

export class ValidationException extends SigloError {
    readonly errors: ValidationErrorDetail[];
}
```

- **Phase**: `'validation'`
- **Retryable**: `false`

---

### `GraphValidationException`

Thrown by `assertValidGraph()` when a workflow AST contains cyclical dependencies, invalid branching configurations, or unreachable nodes.

```typescript
export class GraphValidationException extends SigloError {
    readonly errors: string[];
}
```

---

## Concurrency and Sagas Exceptions

### `CompensationException`

Thrown when a workflow step fails, triggering saga compensation rollbacks in reverse order, and either rollbacks complete or one or more compensations encounter errors.

```typescript
export interface CompensationErrorDetail {
    stepName: string;
    error: unknown;
}

export class CompensationException extends SigloError {
    readonly originalError: unknown;
    readonly compensationErrors: CompensationErrorDetail[];
    readonly completedCompensations: string[];
}
```

- `originalError`: The error that originally caused the workflow to fail.
- `completedCompensations`: List of step names whose compensations ran successfully.
- `compensationErrors`: Array of errors encountered during compensation rollbacks.

---

### `UnresolvableCompensationException`

Thrown during saga compensation execution if a step's registered compensation handler cannot be found in memory or the registry (e.g., after process restarts or workflow code drift).

```typescript
export class UnresolvableCompensationException extends SigloError {
    readonly handlerName?: string;
}
```

- **Phase**: `'compensation'`
- **Retryable**: `false`

---

### `FieldCollisionException`

Thrown by `parallel([...], { mergeStrategy: 'error' })` when two concurrent branches write conflicting values to the same context key.

```typescript
export interface CollisionDetail {
    field: string;
    values: any[];
    branchNames: string[];
}

export class FieldCollisionException extends SigloError {
    readonly collisions: CollisionDetail[];
}
```

---

### `IdempotencyConflictException`

Thrown when an execution attempts to claim an idempotency key that is already marked `IN_PROGRESS` by another concurrent execution.

```typescript
export class IdempotencyConflictException extends SigloError {
    readonly idempotencyKey: string;
}
```

---

## Network Guardrail Exceptions

### `NetworkPolicyViolationException`

Thrown when a step's pre-check, action, or post-check attempts an unauthorized network call violating the active `allowNetwork()` or `networkPolicy()` perimeter.

```typescript
export class NetworkPolicyViolationException extends SigloError {
    readonly requestedUrl: string;
    readonly requestedHost: string;
    readonly allowedHosts: (string | RegExp)[];
}
```

- **Phase**: `'before'`, `'action'`, or `'after'`
- **Retryable**: `false`

---

## Durable and Event Exceptions

### `WorkflowSuspendedException`

Thrown internally when a workflow encounters `waitForEvent()` or `wait()` in durable mode. Indicates that execution has been cleanly checkpointed to storage and execution should pause.

```typescript
export class WorkflowSuspendedException extends SigloError {
    readonly correlationKey?: string;
    readonly eventName?: string;
    readonly continuationNodeId?: string;
    readonly expiresAt?: number;
    readonly status: 'waiting';
}
```

---

### `WorkflowVersionMismatchException`

Thrown when `resumeWorkflow()` restores a checkpoint created under a code version different from the active workflow's declared version, and no transformation was provided in `options.migrations`.

```typescript
export class WorkflowVersionMismatchException extends SigloError {
    readonly expectedVersion: any;
    readonly actualVersion: any;
}
```

---

### `DuplicateEventException`

Thrown when an event is delivered to `resumeWorkflow()` for a workflow instance that is not currently waiting or has already been resumed.

```typescript
export class DuplicateEventException extends SigloError {
    readonly correlationKey: string;
    readonly eventName?: string;
}
```

---

### `ExpiredWaitException`

Thrown when attempting to resume a workflow whose `waitForEvent` timeout window or durable timer duration has already expired.

```typescript
export class ExpiredWaitException extends SigloError {
    readonly correlationKey: string;
    readonly eventName?: string;
    readonly expiredAt: number;
}
```

---

### `WorkflowAlreadyResumedException`

Thrown when attempting to claim or resume a wait record that has already transitioned to completed status.

```typescript
export class WorkflowAlreadyResumedException extends SigloError {
    readonly correlationKey: string;
}
```

---

## Storage Exceptions

### `StorageAdapterException`

Thrown under `setErrorMode('strict')` when a storage adapter operation fails (e.g. database connection dropped).

```typescript
export class StorageAdapterException extends SigloError {
    readonly operation: string;
    readonly adapterName?: string;
}
```

---

### `CheckpointConflictException`

Thrown when optimistic concurrency control detects a revision conflict during `saveCheckpoint()`. (Also exported as `OptimisticLockException`).

```typescript
export class CheckpointConflictException extends SigloError {
    readonly currentRevision: number;
    readonly attemptedRevision: number;
}

export { CheckpointConflictException as OptimisticLockException };
```

---

### `NamespaceMismatchException`

Thrown when restoring a checkpoint into a mismatched tenant namespace.

```typescript
export class NamespaceMismatchException extends SigloError {
    readonly expectedNamespace: string;
    readonly actualNamespace?: string;
}
```

---

### `CheckpointVersionException`

Thrown when attempting to restore a checkpoint with an unsupported major schema version.

```typescript
export class CheckpointVersionException extends SigloError {
    readonly version: any;
}
```

---

## Error Normalization

### `normalizeError(error, metadata?)`

Normalizes any thrown value (standard `Error`, string, object, or primitive) into a standard, typed `SigloError`.

#### Signature

```typescript
export function normalizeError(
    error: any,
    metadata?: ExecutionErrorMetadata
): SigloError;
```

#### Example

```typescript
import { normalizeError, SigloError } from '@siglo/core';

try {
    throw 'Connection reset';
} catch (rawErr) {
    const err: SigloError = normalizeError(rawErr, {
        stepName: 'fetchExternal',
        phase: 'action'
    });

    console.log(err.message);   // 'Connection reset'
    console.log(err.stepName);  // 'fetchExternal'
    console.log(err.retryable); // true
}
```

---

## Handling Errors in Workflows

```typescript
import {
    StepTimeoutException,
    ValidationException,
    CompensationException,
    NetworkPolicyViolationException,
    SigloError
} from '@siglo/core';

try {
    await orderWorkflow.run(orderInput);
} catch (err) {
    if (err instanceof ValidationException) {
        console.error('Validation errors:', err.errors);
    } else if (err instanceof StepTimeoutException) {
        console.error(`Step '${err.stepName}' timed out after ${err.timeoutMs}ms`);
    } else if (err instanceof NetworkPolicyViolationException) {
        console.error(`Unauthorized network egress to ${err.requestedHost} during ${err.phase}`);
    } else if (err instanceof CompensationException) {
        console.error('Workflow failed and rolled back:', err.completedCompensations);
    } else if (err instanceof SigloError) {
        console.error(`General workflow error at step '${err.stepName}' (${err.phase}):`, err.message);
    }
}
```

---

## Related Topic Guides

- [05. Retries, Timeouts, and Cancellation](/05-retries-timeouts-and-cancellation)
- [06. Durable Workflows](/06-durable-workflows)
- [Error Model and Hierarchy](/error-model)
- [Compensation and Sagas Contract](/compensation-and-sagas)
- [Network Egress Policy](/network-egress-policy)
