# Storage & Checkpoint Contract

This document outlines the persistence model, checkpoint schema, optimistic concurrency guarantees, and adapter error modes in `fluid-func` v2.0.0.

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
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  revision: number;
  chains: string[];
  contexts: Record<string, Record<string, any>>;
  timestamp: number;
  expiresAt?: number;
  metadata?: Record<string, any>;
}
```

### Key Schema Guarantees:
- **`version: 2` & `schemaVersion: '2.0.0'`**: Explicit version tracking. Attempting to restore a checkpoint from an unsupported future version (`version > 2`) throws `CheckpointVersionException`.
- **`revision: number`**: Monotonically incremented on each checkpoint save or state transition.
- **`expiresAt?: number`**: Optional Unix epoch expiration timestamp (calculated from `ttlMs`). Expired checkpoints can be cleaned via `cleanExpiredCheckpoints()`.
- **`status`**: Indicates execution lifecycle status: `'running'`, `'completed'`, `'failed'`, or `'cancelled'`.

---

## 2. Optimistic Concurrency Control (OCC)

To prevent lost updates in distributed or concurrent environments, checkpoints support optimistic concurrency:

```ts
// Specifying expectedRevision ensures no other writer has modified the stack
const cp = defaultStorageManager.checkpoint(stackId, {
  expectedRevision: 3
});
```

- If the current revision does not match `expectedRevision`, `CheckpointConflictException` is thrown:
  ```ts
  throw new CheckpointConflictException(stackId, currentRevision, expectedRevision);
  ```
- On conflict, callers can reload the latest checkpoint, reconcile state, and retry.

---

## 3. Namespace Isolation

Checkpoints recorded with a `namespace` are isolated:
- Restoring a checkpoint with `restoreCheckpoint(cp, { expectedNamespace: 'ns-A' })` throws `NamespaceMismatchException` if `cp.namespace === 'ns-B'`.
- Storage adapter operations pass `namespace` whenever available.

---

## 4. Field Redaction (`redactFields`)

Sensitive context fields (tokens, passwords, API keys) can be redacted from checkpoints:
```ts
const snapshot = defaultStorageManager.checkpoint(stackId, {
  redactFields: ['apiKey', 'password', 'token']
});
```
- Redaction applies recursively to both top-level context fields and nested sub-objects.
- Matched keys are replaced with `"[REDACTED]"`.

---

## 5. Storage Error Modes (`StorageErrorMode`)

Configured via `defaultStorageManager.setErrorMode(mode)`:

| Mode | Behavior | Use Case |
|---|---|---|
| `'best-effort'` (default) | Adapter failures are caught and swallowed silently without interrupting execution. | Standard in-memory runs where storage is non-critical. |
| `'warn'` | Adapter failures log a `console.warn` message and continue execution. | Development / staging diagnostics. |
| `'strict'` | Adapter failures throw `StorageAdapterException`, immediately halting the flow. | Mission-critical financial or audit workflows requiring guaranteed persistence. |

---

## 6. Storage Adapter Interface

Custom adapters implement the `StorageAdapter` interface:

```ts
export interface StorageAdapter {
  name?: string;
  saveCheckpoint?(checkpoint: SerializedExecutionStack): Promise<void> | void;
  getCheckpoint?(stackId: string): Promise<SerializedExecutionStack | undefined>;
  deleteCheckpoint?(stackId: string): Promise<void> | void;
  cleanExpiredCheckpoints?(): Promise<number> | number;
  getCachedStep?(key: string): Promise<any> | any;
  setCachedStep?(key: string, value: any, ttl?: number): Promise<void> | void;
  onCacheEvent?(event: CacheEvent): Promise<void> | void;
  onContextChange?(event: ContextChangeEvent): Promise<void> | void;
}
```

Registered globally via:
```ts
import { useStorage } from 'fluid-func';

useStorage(myCustomAdapter);
```
