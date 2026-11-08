---
title: 'Storage & Checkpoint Contract'
description: 'Persistence model, checkpoint schema v2.0.0, optimistic concurrency control (OCC), field redaction, and StorageAdapter interface in Siglo.'
---

This document outlines the persistence model, checkpoint schema, optimistic concurrency guarantees, and adapter error modes in `Siglo` v1.0.0.

---

## 1. Checkpoint Schema v2.0.0

A checkpoint represents a serialized snapshot of an execution stack at a point in time:

```ts
export interface SerializedExecutionStack {
    version: 2;
    schemaVersion: '2.0.0';
    stackId: string;
    workflowId?: string;
    namespace?: string;
    type: 'execution' | string;
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting';
    revision: number;
    chains: string[];
    contexts: Record<string, Record<string, any>>;
    timestamp: number;
    expiresAt?: number;
    metadata?: Record<string, any>;
}
```

### Key Schema Guarantees:

- **`version: 2` & `schemaVersion: '2.0.0'`**: Explicit storage schema version tracking. Attempting to restore a checkpoint from an unsupported future storage engine version (`version > 2`) throws `CheckpointVersionException`. _(Note: This storage schema version is distinct from workflow code semantic versioning, which throws `WorkflowVersionMismatchException` if workflow steps differ without a migration)._
- **`revision: number`**: Monotonically incremented on each checkpoint save, state transition, or migration.
- **`expiresAt?: number`**: Optional Unix epoch expiration timestamp (calculated from `ttlMs`). Expired checkpoints can be cleaned via `cleanExpiredCheckpoints()`.
- **`status`**: Indicates execution lifecycle status: `'running'`, `'completed'`, `'failed'`, `'cancelled'`, or `'waiting'`.

---

## 2. Optimistic Concurrency Control (OCC)

To prevent lost updates in distributed or concurrent environments, checkpoints support optimistic concurrency:

```ts
// Specifying expectedRevision ensures no other writer has modified the stack
const cp = defaultStorageManager.checkpoint(stackId, {
    expectedRevision: 3,
});
```

- If the current revision does not match `expectedRevision`, `CheckpointConflictException` is thrown:
    ```ts
    throw new CheckpointConflictException(stackId, currentRevision, expectedRevision);
    ```
- On conflict, callers can reload the latest checkpoint, reconcile state, and retry.

---

## 3. Namespace Scoping & Partitioning

Checkpoints recorded with a `namespace` partition data across tenants:

- Restoring a checkpoint with `restoreCheckpoint(cp, { expectedNamespace: 'ns-A' })` throws `NamespaceMismatchException` when both `expectedNamespace` and `cp.namespace` are present and differ.
- Storage adapter operations pass `namespace` for key prefixing and partitioning.
- Note: Namespace scoping is logical key partitioning, not an enforced authenticated tenant boundary. Application-level authorization and explicit validation are still required.

---

## 4. Field Redaction (`redactFields`)

Sensitive context fields (tokens, passwords, API keys) can be redacted from checkpoints:

```ts
const snapshot = defaultStorageManager.checkpoint(stackId, {
    redactFields: ['apiKey', 'password', 'token'],
});
```

- Redaction applies recursively to both top-level context fields and nested sub-objects.
- Matched keys are replaced with `"[REDACTED]"`.

---

## 5. Storage Error Modes (`StorageErrorMode`)

Configured via `defaultStorageManager.setErrorMode(mode)`:

| Mode                      | Behavior                                                                                                                                                                       | Use Case                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `'best-effort'` (default) | Adapter failures are caught and swallowed silently without interrupting execution.                                                                                             | Standard in-memory runs where storage is non-critical.     |
| `'warn'`                  | Adapter failures log a `console.warn` message and continue execution.                                                                                                          | Development / staging diagnostics.                         |
| `'strict'`                | Rejects unhandled storage promises and throws `StorageAdapterException` when `saveCheckpoint` is awaited. (Note: synchronous snapshot capture attaches background rejections). | Mission-critical workflows requiring verified persistence. |

---

## 6. Storage Adapter Interface

Custom adapters implement the `StorageAdapter` interface:

```ts
export interface StorageAdapter {
    name: string;

    // 1. Context & Event Streaming
    onContextChange?(entry: ContextChangeEvent): Promise<void> | void;

    // 2. Checkpointing & Durability
    saveCheckpoint?(checkpoint: SerializedExecutionStack): Promise<void>;
    getCheckpoint?(stackId: string): Promise<SerializedExecutionStack | undefined>;
    cleanExpiredCheckpoints?(): Promise<number> | number | void;

    // 3. Durable Wait Persistence
    saveWaitRecord?(record: any): Promise<void> | void;
    getWaitRecord?(correlationKeyOrStackId: string): Promise<any | undefined>;
    claimWaitRecord?(
        correlationKey: string,
        claimantId?: string,
        options?: { allowExpired?: boolean; eventPayload?: any },
    ): Promise<any>;
    completeWaitRecord?(correlationKey: string, claimantId: string): Promise<void>;
    withWorkflowLock?<T>(stackId: string, action: () => Promise<T>): Promise<T>;
    cancelWaitRecord?(correlationKey: string): Promise<void>;
    cancelWorkflow?(stackId: string): Promise<void>;

    // 4. Distributed Caching
    getCachedStep?(key: string): Promise<any | undefined>;
    setCachedStep?(key: string, value: any, ttlMs: number): Promise<void>;

    // 5. Cache & Telemetry Events
    onCacheEvent?(event: CacheEvent): Promise<void> | void;
}
```

Registered globally via:

```ts
import { useStorage } from '@siglo/core';

useStorage(myCustomAdapter);
```
