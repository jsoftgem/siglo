# API Reference: Storage & Persistence Utilities

The Storage & Persistence API in **Siglo** provides durable checkpointing, execution stack snapshots, optimistic concurrency control (OCC), multi-tenant namespace isolation, and pluggable storage adapters for distributed backends (e.g. PostgreSQL, Redis).

---

## Table of Contents

- [The `StorageAdapter` Interface](#the-storageadapter-interface)
- [Adapter Management](#adapter-management)
  - [`useStorage(adapter)`](#usestorageadapter)
  - [`getStorageAdapter()`](#getstorageadapter)
  - [`setErrorMode(mode)`](#seterrormodemode)
  - [`getErrorMode()`](#geterrormode)
- [Checkpointing & Resumption](#checkpointing--resumption)
  - [`checkpoint(stackId, options?)`](#checkpointstackid-options)
  - [`getCheckpoint(stackId)`](#getcheckpointstackid)
  - [`restoreCheckpoint(data, options?)`](#restorecheckpointdata-options)
  - [`cleanExpiredCheckpoints()`](#cleanexpiredcheckpoints)
- [Serialization & Hydration](#serialization--hydration)
  - [`serializeState(stackId?)`](#serializestatestackid)
  - [`hydrateState(serialized, options?)`](#hydratestateserialized-options)
- [Checkpoint Schema v2.0.0](#checkpoint-schema-v200)
- [Optimistic Concurrency Control (OCC)](#optimistic-concurrency-control-occ)
- [Namespace Isolation](#namespace-isolation)

---

## The `StorageAdapter` Interface

Custom persistence adapters (such as `@siglo/postgres` and `@siglo/redis`) implement the `StorageAdapter` interface:

```typescript
export interface StorageAdapter {
    /** Unique adapter identifier (e.g. 'postgres', 'redis', 'in-memory'). */
    readonly name: string;

    /** Hook called whenever step context changes during execution. */
    onContextChange?: (event: ContextChangeEvent) => Promise<void> | void;

    /** Persists a full serialized execution checkpoint snapshot. */
    saveCheckpoint?: (checkpoint: SerializedExecutionStack) => Promise<void>;

    /** Retrieves a persisted execution checkpoint by stack ID. */
    getCheckpoint?: (stackId: string) => Promise<SerializedExecutionStack | undefined>;

    /** Deletes an execution checkpoint upon completion or cleanup. */
    deleteCheckpoint?: (stackId: string) => Promise<void>;

    /** Lists checkpoints matching optional status or namespace filters. */
    listCheckpoints?: (filter?: {
        namespace?: string;
        status?: string;
        limit?: number;
    }) => Promise<SerializedExecutionStack[]>;

    /** Retrieves cached step output by partition key. */
    getCachedStep?: (key: string) => Promise<any>;

    /** Stores cached step output with TTL. */
    setCachedStep?: (key: string, val: any, ttlMs?: number) => Promise<void>;

    /** Prunes expired checkpoints from persistent storage. */
    cleanExpiredCheckpoints?: () => Promise<number> | number;
}
```

---

## Adapter Management

### `useStorage(adapter)`

Registers the global storage adapter for the Siglo runtime. Once registered, all workflow checkpoints, context updates, and distributed caching route through this adapter.

#### Signature

```typescript
export function useStorage(adapter: StorageAdapter): void;
```

#### Example

```typescript
import { useStorage } from '@siglo/core';
import { PostgresStorageAdapter } from '@siglo/postgres';

const postgresAdapter = new PostgresStorageAdapter({
    connectionString: process.env.DATABASE_URL,
    schema: 'siglo_workflows'
});

useStorage(postgresAdapter);
```

---

### `getStorageAdapter()`

Returns the currently registered `StorageAdapter`, or `undefined` if Siglo is operating on the default in-memory storage manager.

#### Signature

```typescript
export function getStorageAdapter(): StorageAdapter | undefined;
```

---

### `setErrorMode(mode)` and `getErrorMode()`

Configures how Siglo responds when storage adapter operations fail (e.g. database disconnect during checkpoint save).

#### Signatures

```typescript
export type StorageErrorMode = 'best-effort' | 'warn' | 'strict';

export function setErrorMode(mode: StorageErrorMode): void;
export function getErrorMode(): StorageErrorMode;
```

#### Modes

1. `'best-effort'` *(default)*: Catches storage errors silently; execution continues without interrupting the running workflow.
2. `'warn'`: Logs warnings to `console.warn` when a storage operation fails, but allows workflow execution to continue.
3. `'strict'`: Immediately throws `StorageAdapterException`, aborting the workflow to prevent running without verified persistence.

#### Example

```typescript
import { setErrorMode } from '@siglo/core';

// Enforce strict persistence in production environments
if (process.env.NODE_ENV === 'production') {
    setErrorMode('strict');
}
```

---

## Checkpointing & Resumption

### `checkpoint(stackId, options?)`

Captures an instantaneous, immutable checkpoint snapshot of the execution stack, serializing all step contexts, revision counter, and status.

#### Signature

```typescript
export interface CheckpointOptions {
    ttlMs?: number;
    status?: 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting';
    workflowId?: string;
    redactFields?: string[];
    metadata?: Record<string, any>;
    expectedRevision?: number; // For OCC validation
}

export function checkpoint(
    stackId: string,
    options?: CheckpointOptions
): SerializedExecutionStack;
```

#### Throws

- `CheckpointConflictException`: If `options.expectedRevision` does not match the stack's current revision.
- `StorageAdapterException`: In `strict` error mode if the adapter fails to persist.

---

### `getCheckpoint(stackId)`

Retrieves the serialized checkpoint snapshot for a given execution stack ID from the active adapter or in-memory manager.

#### Signature

```typescript
export function getCheckpoint(
    stackId: string
): Promise<SerializedExecutionStack | undefined>;
```

#### Example

```typescript
import { getCheckpoint } from '@siglo/core';

const cp = await getCheckpoint('stack_abc123');
if (cp) {
    console.log(`Workflow ${cp.workflowId} is in status: ${cp.status}`);
}
```

---

### `restoreCheckpoint(data, options?)`

Restores an execution stack and all step contexts into active memory from a serialized checkpoint snapshot.

#### Signature

```typescript
export function restoreCheckpoint(
    checkpointData: SerializedExecutionStack,
    options?: { expectedNamespace?: string; expectedWorkflowId?: string }
): string;
```

#### Throws

- `CheckpointVersionException`: If checkpoint schema version exceeds supported runtime version.
- `NamespaceMismatchException`: If `options.expectedNamespace` does not match `checkpointData.namespace`.

---

### `cleanExpiredCheckpoints()`

Scans all active checkpoints and deletes those whose `expiresAt` timestamp has elapsed.

#### Signature

```typescript
export function cleanExpiredCheckpoints(): number;
```

#### Example

```typescript
import { cleanExpiredCheckpoints } from '@siglo/core';

// Scheduled cron job running every hour
setInterval(() => {
    const pruned = cleanExpiredCheckpoints();
    console.log(`Pruned ${pruned} expired checkpoints.`);
}, 60 * 60 * 1000);
```

---

## Serialization & Hydration

### `serializeState(stackId?)`

Serializes workflow state into a portable JSON string.

- If `stackId` is provided, serializes only that specific execution stack.
- If omitted, serializes all stacks, step contexts, and configuration into a global state snapshot.

#### Signature

```typescript
export function serializeState(stackId?: string): string;
```

---

### `hydrateState(serialized, options?)`

Restores complete workflow storage state from a serialized JSON string.

#### Signature

```typescript
export function hydrateState(
    serialized: string | SerializedStorageState | SerializedExecutionStack,
    options?: { expectedNamespace?: string }
): string | undefined;
```

---

## Checkpoint Schema v2.0.0

Checkpoints are serialized using standard Schema v2.0.0:

```json
{
  "version": 2,
  "schemaVersion": "2.0.0",
  "stackId": "c8b417ee-5079-451e-8488-ea6bf2d556be",
  "workflowId": "order-fulfillment",
  "namespace": "tenant_enterprise_01",
  "type": "execution",
  "status": "waiting",
  "revision": 3,
  "chains": ["createOrder", "waitForEvent:paymentReceived", "shipItems"],
  "contexts": {
    "createOrder": {
      "orderId": "ord_999",
      "amount": 250
    }
  },
  "timestamp": 1729900000000,
  "expiresAt": 1730072800000,
  "metadata": {
    "initiator": "api_gateway"
  }
}
```

---

## Optimistic Concurrency Control (OCC)

Siglo uses optimistic concurrency control to prevent multiple distributed workers from overwriting checkpoints concurrently.

1. Every checkpoint increments an integer `revision` counter (`0, 1, 2, ...`).
2. When saving with `options.expectedRevision`, Siglo verifies that `expectedRevision === currentRevision`.
3. If another worker updated the checkpoint in the interim, `CheckpointConflictException` is thrown, allowing the caller to reload and retry.

---

## Namespace Isolation

All storage APIs enforce partition isolation:
- Steps running under `options.namespace = 'tenant_a'` cannot read or modify checkpoints or cached keys belonging to `'tenant_b'`.
- Attempting to restore a checkpoint with a conflicting expected namespace immediately throws `NamespaceMismatchException`.

---

## Related Topic Guides

- [06. Durable Workflows](../06-durable-workflows.md)
- [07. Storage and Adapters](../07-storage-and-adapters.md)
- [Storage & Checkpoint Contract](../storage-contract.md)
- [Ecosystem Adapters Overview](../ecosystem-adapters.md)
