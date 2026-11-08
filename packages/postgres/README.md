# @siglo/postgres Adapter Guide

`@siglo/postgres` provides an enterprise ACID-compliant persistence, event auditing, distributed locking, and idempotency coordination layer for `Siglo` workflows using PostgreSQL. It is engineered for mission-critical transactional workflows requiring zero state loss across crashes, network partitions, and multi-node worker clusters.

---

## 1. Overview & Architecture

When workflows coordinate financial, compliance, or enterprise operations, persistence must survive node failures and process crashes. `@siglo/postgres` implements two primary classes:

1. **`PostgresStorageAdapter`**: Implements the Siglo `StorageAdapter` interface for durable execution checkpoints with Optimistic Concurrency Control (OCC), immutable context mutation audit logging, durable asynchronous wait/continuation records, and distributed session-level advisory workflow locking.
2. **`PostgresIdempotencyStore`**: Implements the Siglo `IdempotencyStore` interface for atomic, distributed single-flight execution claims, cached result retrieval, and automated lock re-claiming upon TTL expiration.

```mermaid
flowchart TD
    Engine["Siglo Workflow Engine"]

    subgraph Adapters["@siglo/postgres Adapter Suite"]
        direction TB
        SA["PostgresStorageAdapter<br/>• saveCheckpoint() (OCC Versioned)<br/>• getCheckpoint()<br/>• onContextChange()<br/>• withWorkflowLock() (Advisory Lock)<br/>• saveWaitRecord() / claimWaitRecord()<br/>• completeWaitRecord() / cancelWorkflow()<br/>• cleanExpiredCheckpoints()<br/>• cleanupOldCheckpoints() / Events / Waits"]
        IS["PostgresIdempotencyStore<br/>• claim() (Atomic Insert/Reclaim)<br/>• complete() / fail()<br/>• getResult() / get() / getRecord()<br/>• cleanupExpired()"]
    end

    subgraph DB["PostgreSQL Database"]
        direction TB
        T1[("siglo_checkpoints<br/>• stack_id (PK)<br/>• namespace<br/>• state (JSONB)<br/>• version (BIGINT OCC)<br/>• created_at / updated_at")]
        T2[("siglo_context_events<br/>• id (BIGSERIAL PK)<br/>• stack_id, step_id<br/>• namespace, field<br/>• value (JSONB), created_at")]
        T3[("siglo_wait_records<br/>• correlation_key (PK)<br/>• stack_id, status<br/>• data, resume_payload<br/>• locked_by, locked_at<br/>• expires_at, created_at")]
        T4[("siglo_idempotency<br/>• key (VARCHAR(512) PK)<br/>• status, result (JSONB)<br/>• expires_at, created_at")]
        AL["PostgreSQL Advisory Locks<br/>pg_try_advisory_lock(hashtextextended('siglo:workflow:' || stackId, 0))"]
    end

    Engine --> SA
    Engine --> IS
    SA --> T1
    SA --> T2
    SA --> T3
    SA -.-> AL
    IS --> T4
```

---

## 2. Installation & Requirements

Install `@siglo/postgres` alongside `@siglo/core` and the `pg` driver:

```bash
npm install @siglo/core @siglo/postgres pg
npm install --save-dev @types/pg
```

### Peer Dependency Matrix

| Package           | Version  | Requirement                                                            |
| :---------------- | :------- | :--------------------------------------------------------------------- |
| `@siglo/core`     | `^1.0.0` | Core workflow engine & interfaces                                      |
| `pg`              | `^8.0.0` | PostgreSQL client driver (supports both `Pool` and `Client`)           |
| PostgreSQL Server | `12+`    | Requires JSONB, Advisory Locks (`hashtextextended`), and `TIMESTAMPTZ` |

---

## 3. Database Schema & Automated DDL

Both `PostgresStorageAdapter` and `PostgresIdempotencyStore` provide automated schema synchronization via `ensureTables()` and `ensureTable()`. These methods execute idempotent DDL statements (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

### DDL Definitions

```sql
-- 1. Checkpoint Storage Table (with OCC version tracking)
CREATE TABLE IF NOT EXISTS siglo_checkpoints (
    stack_id VARCHAR(255) PRIMARY KEY,
    namespace VARCHAR(255),
    state JSONB NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE siglo_checkpoints ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_siglo_checkpoints_namespace ON siglo_checkpoints(namespace);

-- 2. Step Context Mutation Audit Event Log
CREATE TABLE IF NOT EXISTS siglo_context_events (
    id BIGSERIAL PRIMARY KEY,
    stack_id VARCHAR(255) NOT NULL,
    step_id VARCHAR(255) NOT NULL,
    namespace VARCHAR(255),
    field VARCHAR(255) NOT NULL,
    value JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_siglo_context_events_stack ON siglo_context_events(stack_id);

-- 3. Durable Wait and Continuation Records Table
CREATE TABLE IF NOT EXISTS siglo_wait_records (
    correlation_key VARCHAR(255) PRIMARY KEY,
    stack_id VARCHAR(255) NOT NULL,
    namespace VARCHAR(255),
    event_name VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'WAITING',
    continuation_step_index INT NOT NULL DEFAULT 0,
    version VARCHAR(50),
    data JSONB,
    resumed_by VARCHAR(255),
    resumed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE siglo_wait_records ADD COLUMN IF NOT EXISTS resume_payload JSONB;
ALTER TABLE siglo_wait_records ADD COLUMN IF NOT EXISTS locked_by TEXT;
ALTER TABLE siglo_wait_records ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_siglo_wait_records_stack ON siglo_wait_records(stack_id);
CREATE INDEX IF NOT EXISTS idx_siglo_wait_records_status ON siglo_wait_records(status);

-- 4. Distributed Idempotency Table
CREATE TABLE IF NOT EXISTS siglo_idempotency (
    key VARCHAR(512) PRIMARY KEY,
    status VARCHAR(50) NOT NULL,
    result JSONB,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_siglo_idempotency_expires ON siglo_idempotency(expires_at);
```

### SQL Injection Protection

Custom table names passed to `PostgresStorageAdapter` or `PostgresIdempotencyStore` are validated against strict SQL identifier constraints:

- Must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/`.
- Must not exceed 63 characters (PostgreSQL standard identifier length limit).
- Throws an descriptive `Error` if invalid characters or injection attempts are detected.

---

## 4. `PostgresStorageAdapter` API Reference

Implements the Siglo `StorageAdapter` interface (`name = 'postgres'`).

```typescript
import { PostgresStorageAdapter } from '@siglo/postgres';
```

### Constructor Options (`PostgresStorageAdapterOptions`)

| Option                 | Type                                        | Default                  | Description                                                                                                                                                          |
| :--------------------- | :------------------------------------------ | :----------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client`               | `PostgresClientInterface \| Pool \| Client` | _Required_               | Active PostgreSQL `Pool`, `Client`, or compatible wrapper with a `.query(text, values)` method.                                                                      |
| `checkpointsTable`     | `string`                                    | `'siglo_checkpoints'`    | Table name for execution checkpoints.                                                                                                                                |
| `eventsTable`          | `string`                                    | `'siglo_context_events'` | Table name for context mutation audit logs.                                                                                                                          |
| `waitRecordsTable`     | `string`                                    | `'siglo_wait_records'`   | Table name for durable wait and continuation records.                                                                                                                |
| `recordContextChanges` | `boolean`                                   | `true`                   | When `true`, automatically streams step context mutations into `eventsTable`. Set `false` for low-latency pipelines that do not require fine-grained field auditing. |

### Checkpointing & Optimistic Concurrency Control (OCC)

#### `ensureTables(): Promise<void>`

Initializes `checkpointsTable`, `eventsTable`, and `waitRecordsTable` along with indexes and columns if they do not exist.

#### `saveCheckpoint(checkpoint: SerializedExecutionStack, expectedVersion?: number): Promise<void>`

Persists or updates an execution stack.

- **OCC Enforcement**: If `expectedVersion` is specified (or exists on `checkpoint.occVersion`), executes an atomic version-guarded update:
    ```sql
    UPDATE siglo_checkpoints
    SET state = CASE WHEN state->>'status' = 'cancelled' THEN jsonb_set($1::jsonb, '{status}', '"cancelled"') ELSE $1::jsonb END,
        namespace = $2,
        version = version + 1,
        updated_at = NOW()
    WHERE stack_id = $3 AND version = $4
    RETURNING version
    ```
- **Conflict Handling**: If `rowCount === 0`, it fetches the current database version and throws an `OptimisticLockException(stackId, currentVersion, expectedVersion)`.
- **Cancellation Preservation**: If a workflow was previously cancelled, updating the checkpoint preserves the `'cancelled'` status atomically.
- **Version Tracking**: On success, assigns the new incremented version to `checkpoint.occVersion` and `checkpoint.revision`.
- **Write Tracking**: Automatically serialized under `withWorkflowLock` scopes to drain all pending writes before lock release.

#### `getCheckpoint(stackId: string): Promise<SerializedExecutionStack | undefined>`

Retrieves the serialized execution stack by `stackId`.

- Automatically assigns `occVersion` and `revision` from the database `version` column.
- Returns `undefined` if `stackId` is empty or not found.

#### `cleanExpiredCheckpoints(): Promise<number>`

Deletes checkpoints where `(state->>'expiresAt')::bigint <= (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint`. Returns the count of deleted rows.

---

### Context Mutation Audit Logging

#### `onContextChange(entry): Promise<void>`

Records step mutation audit events into `eventsTable`.

- Parameter `entry`:
    ```typescript
    {
        namespace?: string;
        stackId: string;
        stepId: string;
        field: string;
        value: any;
        timestamp: number;
    }
    ```
- Converts `timestamp` (in milliseconds) using `to_timestamp(timestamp / 1000.0)`.
- Operates as a non-blocking stream: internal errors are caught to avoid disrupting primary workflow execution.

---

### Distributed Workflow Locking

#### `withWorkflowLock<T>(stackId: string, action: () => Promise<T>): Promise<T>`

Executes `action` inside a PostgreSQL session-level advisory lock using `pg_try_advisory_lock`:

```sql
SELECT pg_try_advisory_lock(hashtextextended('siglo:workflow:' || stackId, 0)) AS locked
```

- **Distributed Mutex**: Serializes step continuations, event resumptions, and compensations across multi-instance worker fleets.
- **Auto-Release on Process Failure**: Because PostgreSQL advisory locks are bound to the database session/connection, if a worker node crashes or disconnects, PostgreSQL automatically releases the lock immediately.
- **Re-entrancy**: Safely allows nested invocations for the same `stackId` within the same execution context.
- **Pool Awareness**: Detects pooled clients (`'totalCount' in pool`) and calls `pool.connect()`, ensuring a dedicated connection is held for the lock duration and released back to the pool in a `finally` block.
- **Non-Pooled / Direct Client Guard**: Guards direct `Client` instances against concurrent re-use via `directClientBusy`.
- **Write Queue Draining**: Uses `AsyncLocalStorage` and internal write tracking (`tail` promise) to ensure all pending checkpoint and wait record writes are completely flushed to PostgreSQL before the advisory lock is unlocked.
- **Throws**: `DuplicateEventException(stackId)` if the lock cannot be acquired or if the direct client is busy.

---

### Durable Wait Records & Resumption

#### `saveWaitRecord(record: any): Promise<void>`

Persists or updates a durable wait record in `waitRecordsTable` and embeds the record into the checkpoint metadata (`checkpoint.metadata.waitRecord`).

- Key properties on `record`: `correlationKey`, `stackId`, `namespace`, `eventName`, `status`, `continuationStepIndex`, `version`, `data`, `expiresAt`.

#### `getWaitRecord(correlationKeyOrStackId: string): Promise<any | undefined>`

Retrieves a wait record from `waitRecordsTable` matching either `correlation_key` or `stack_id`. Falls back to querying `siglo_checkpoints.state->'metadata'->'waitRecord'` if not found in the wait records table.

#### `claimWaitRecord(correlationKey: string, claimantId?: string, options?: { allowExpired?: boolean; eventPayload?: any }): Promise<any>`

Atomically claims a wait record for resumption via a single Compare-And-Swap (CAS) update:

```sql
UPDATE siglo_wait_records
SET status = 'RESUMING', locked_at = NOW(), locked_by = $1,
    resume_payload = COALESCE(resume_payload, $3::jsonb), updated_at = NOW()
WHERE correlation_key = $2
  AND (status = 'WAITING' OR (status = 'RESUMING' AND $5))
  AND (resume_payload IS NOT NULL OR $4 OR expires_at IS NULL OR expires_at > NOW())
RETURNING *
```

- **Expiration Safety**: If the record has expired and `allowExpired` is not set, throws `ExpiredWaitException(correlationKey, expiresAt, eventName)`.
- **Duplicate Safety**: If the record is already claimed or resumed, throws `DuplicateEventException(correlationKey)`.
- **Returns**: The claimed wait record with `status: 'RESUMING'`, `lockedBy`, and parsed JSON `resumePayload`.

#### `completeWaitRecord(correlationKey: string, claimantId: string): Promise<void>`

Marks the claimed wait record as `'RESUMED'`, setting `resumed_by` and `resumed_at = NOW()`. Drains pending async writes before completing.

#### `cancelWaitRecord(correlationKey: string): Promise<void>`

Transitions a wait record status to `'CANCELLED'`.

#### `cancelWorkflow(stackId: string): Promise<void>`

Atomically cancels both active wait records and the execution checkpoint for `stackId`:

- Cancels all wait records: `UPDATE siglo_wait_records SET status = 'CANCELLED' WHERE stack_id = $1`.
- Updates the checkpoint state: `UPDATE siglo_checkpoints SET state = jsonb_set(state, '{status}', '"cancelled"'), version = version + 1 WHERE stack_id = $1`.

---

### Retention & Cleanup

| Method                    | Parameters               | Default  | Description                                                                    |
| :------------------------ | :----------------------- | :------- | :----------------------------------------------------------------------------- |
| `cleanupOldCheckpoints`   | `retentionDays?: number` | `30`     | Deletes checkpoints where `updated_at < NOW() - make_interval(days => $1)`.    |
| `cleanupOldEvents`        | `retentionDays?: number` | `30`     | Deletes audit events where `created_at < NOW() - make_interval(days => $1)`.   |
| `cleanupOldWaitRecords`   | `retentionDays?: number` | `30`     | Deletes wait records where `updated_at < NOW() - make_interval(days => $1)`.   |
| `cleanExpiredCheckpoints` | _(none)_                 | _(none)_ | Deletes checkpoints whose embedded `state->>'expiresAt'` timestamp has passed. |

---

## 5. `PostgresIdempotencyStore` API Reference

Implements the Siglo `IdempotencyStore` interface.

```typescript
import { PostgresIdempotencyStore } from '@siglo/postgres';
```

### Constructor Options (`PostgresIdempotencyOptions`)

| Option         | Type                                        | Default               | Description                                                         |
| :------------- | :------------------------------------------ | :-------------------- | :------------------------------------------------------------------ |
| `client`       | `PostgresClientInterface \| Pool \| Client` | _Required_            | Active PostgreSQL client or connection pool.                        |
| `tableName`    | `string`                                    | `'siglo_idempotency'` | Name of idempotency table. Must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/`. |
| `defaultTtlMs` | `number`                                    | `86400000` (24 hours) | Default lock and result expiration TTL in milliseconds.             |

### Methods

#### `ensureTable(): Promise<void>`

Creates `tableName` and the index on `expires_at` if they do not exist.

#### `claim(key: string, ttlMs?: number): Promise<'claimed' | 'completed' | 'in-progress'>`

Atomically attempts to claim the key:

1. **Initial Insert**: Executes `INSERT ... VALUES ($1, 'in-progress', $2, NOW()) ON CONFLICT (key) DO NOTHING`. Returns `'claimed'` if row inserted.
2. **Expired Lock Reclamation**: If the key exists but `expires_at <= NOW()`, updates status back to `'in-progress'`, updates `expires_at`, clears `result`, and returns `'claimed'`.
3. **Completed Result**: If `status === 'completed'`, returns `'completed'`.
4. **Active Claim**: If actively running and unexpired, returns `'in-progress'`.

#### `complete(key: string, result: unknown, ttlMs?: number): Promise<void>`

Transitions key status to `'completed'`, serializes `result` into `result JSONB`, and sets `expires_at = NOW() + ttlMs`.

#### `fail(key: string, _error?: unknown): Promise<void>`

Deletes in-progress claims (`WHERE key = $1 AND status = 'in-progress'`) so subsequent retries can proceed immediately.

#### `getResult(key: string): Promise<unknown | undefined>`

Retrieves and deserializes the stored `result` JSONB for completed keys. Returns `undefined` if key is not completed or missing.

#### `get(key: string): Promise<unknown | undefined>`

Convenience alias for `getResult(key)`.

#### `getRecord(key: string): Promise<any | undefined>`

Inspects the full raw idempotency record:

```typescript
{
    status: string;           // 'in-progress' | 'completed'
    result?: any;             // Parsed JSON result
    expiresAt?: number;       // Expiry timestamp (ms)
    claimedAt: number;        // Created timestamp (ms)
}
```

#### `cleanupExpired(): Promise<number>`

Deletes expired idempotency records (`DELETE FROM siglo_idempotency WHERE expires_at < NOW()`). Returns the count of deleted rows.

---

## 6. Concurrency & Locking Architecture

Siglo workflows employ a defense-in-depth concurrency model combining PostgreSQL advisory session locks with table-level Optimistic Concurrency Control (OCC):

```mermaid
sequenceDiagram
    autonumber
    participant W1 as Worker Pod A
    participant PG as PostgreSQL
    participant W2 as Worker Pod B

    Note over W1,PG: 1. Advisory Workflow Locking (Distributed Mutex)
    W1->>PG: SELECT pg_try_advisory_lock(hashtextextended('siglo:workflow:stack-42', 0))
    PG-->>W1: locked = true

    W2->>PG: SELECT pg_try_advisory_lock(hashtextextended('siglo:workflow:stack-42', 0))
    PG-->>W2: locked = false (Throws DuplicateEventException)

    Note over W1,PG: 2. Execution & OCC Checkpoint Persistence
    W1->>PG: UPDATE siglo_checkpoints SET state = $1, version = version + 1 WHERE stack_id = 'stack-42' AND version = 1 RETURNING version
    PG-->>W1: version = 2

    Note over W1,PG: 3. Automatic Write Queue Flush & Session Unlock
    W1->>W1: Await pending writes (scope.tail)
    W1->>PG: SELECT pg_advisory_unlock(hashtextextended('siglo:workflow:stack-42', 0))
    PG-->>W1: unlocked = true
```

### Advisory Locks vs. Optimistic Concurrency Control (OCC)

- **`withWorkflowLock` (PostgreSQL Advisory Locks)**: Used around step executions, timer/event resumptions, and compensations. Guarantees that only **one worker** executes steps for a given `stackId` at any time. If the worker crashes, the PostgreSQL session lock automatically drops.
- **OCC (`version` column)**: Used by `saveCheckpoint`. Guards against stale writes or late-arriving updates across worker partitions. If a write conflicts with an unexpected version, an `OptimisticLockException` is thrown.

---

## 7. Core Exception Types

All exceptions extend `SigloError` and can be imported from `@siglo/core`:

```typescript
import { OptimisticLockException, DuplicateEventException, ExpiredWaitException } from '@siglo/core';
```

### 1. `OptimisticLockException`

Thrown by `saveCheckpoint` when an update fails because the version in the database differs from `expectedVersion`:

- `err.stackId`: The workflow execution stack ID.
- `err.currentVersion`: The version currently in PostgreSQL.
- `err.expectedVersion`: The version expected by the writer.

### 2. `DuplicateEventException`

Thrown by `withWorkflowLock` when another worker currently holds the workflow lock, or by `claimWaitRecord` when a wait record is already claimed or resumed:

- `err.correlationKey` / `err.stackId`: The resource key that could not be locked.

### 3. `ExpiredWaitException`

Thrown by `claimWaitRecord` when attempting to claim a wait record whose `expires_at` timestamp has passed and `allowExpired` is not set:

- `err.correlationKey`: The wait record correlation key.
- `err.expiresAt`: Expiration timestamp in milliseconds.
- `err.eventName`: Name of the expected event.

---

## 8. Complete Production Example

Below is a complete, production-ready example demonstrating connection pool configuration, automatic schema initialization, workflow definition, idempotency guards, OCC error handling, and scheduled retention cleanup.

```typescript
import { Pool } from 'pg';
import { Step, flow, OptimisticLockException, DuplicateEventException } from '@siglo/core';
import { PostgresStorageAdapter, PostgresIdempotencyStore } from '@siglo/postgres';

// 1. Initialize PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/orders_db',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on('error', err => {
    console.error('Unexpected idle PostgreSQL client error:', err);
});

// 2. Initialize and Register Storage Adapter
const storageAdapter = new PostgresStorageAdapter({
    client: pool,
    checkpointsTable: 'siglo_checkpoints',
    eventsTable: 'siglo_context_events',
    waitRecordsTable: 'siglo_wait_records',
    recordContextChanges: true,
});

// 3. Initialize Idempotency Store
const idempotencyStore = new PostgresIdempotencyStore({
    client: pool,
    tableName: 'siglo_idempotency',
    defaultTtlMs: 86400000, // 24 hours
});

// 4. Schema Initialization on Application Startup
export async function initializeDatabase() {
    await storageAdapter.ensureTables();
    await idempotencyStore.ensureTable();
    console.log('PostgreSQL workflow schemas initialized successfully.');
}

// Register global storage adapter
Step.useStorage(storageAdapter);

// 5. Define Production Workflow Steps
interface OrderInput {
    orderId: string;
    accountId: string;
    amountCents: number;
}

const debitAccount = Step.create('debitAccount', async (param: OrderInput) => {
    // Execute debit operation
    return {
        debitReference: `dr_${param.orderId}`,
        debitedAmount: param.amountCents,
    };
});

const emitReceipt = Step.create('emitReceipt', async (param: any) => {
    return {
        receiptNumber: `rcpt_${param.orderId}`,
        completedAt: new Date().toISOString(),
    };
});

const paymentWorkflow = flow(debitAccount, emitReceipt);

// 6. Execute Workflow with Distributed Idempotency and Workflow Lock
export async function processOrder(input: OrderInput) {
    const idempKey = `order:payment:${input.orderId}`;

    // Attempt 60-second atomic claim lock
    const claimStatus = await idempotencyStore.claim(idempKey, 60000);

    if (claimStatus === 'completed') {
        console.log(`Order ${input.orderId} already completed. Returning cached result.`);
        return await idempotencyStore.getResult(idempKey);
    }

    if (claimStatus === 'in-progress') {
        throw new Error(`Order ${input.orderId} is currently being processed by another worker.`);
    }

    try {
        // Execute inside distributed advisory workflow lock
        const stackId = `stack_${input.orderId}`;
        const output = await storageAdapter.withWorkflowLock(stackId, async () => {
            return await paymentWorkflow.run(input, {
                namespace: 'ecommerce-prod',
            });
        });

        const finalResult = {
            orderId: input.orderId,
            debitReference: output.debitReference,
            receiptNumber: output.receiptNumber,
            completedAt: output.completedAt,
        };

        // Complete idempotency record with final payload
        await idempotencyStore.complete(idempKey, finalResult);
        return finalResult;
    } catch (err) {
        // Clear in-flight idempotency claim so retries are permitted
        await idempotencyStore.fail(idempKey, err);

        if (err instanceof OptimisticLockException) {
            console.error(
                `OCC Conflict on stack ${err.stackId}: expected v${err.expectedVersion}, got v${err.currentVersion}`,
            );
        } else if (err instanceof DuplicateEventException) {
            console.warn(`Concurrent execution conflict on lock ${err.correlationKey}`);
        }

        throw err;
    }
}

// 7. Scheduled Maintenance & Retention Cleanup
export async function runNightlyRetentionCleanup() {
    console.log('Starting automated PostgreSQL workflow data retention cleanup...');

    const prunedCheckpoints = await storageAdapter.cleanupOldCheckpoints(14); // 14-day checkpoint retention
    const prunedEvents = await storageAdapter.cleanupOldEvents(30); // 30-day audit log retention
    const prunedWaits = await storageAdapter.cleanupOldWaitRecords(14); // 14-day wait record retention
    const prunedExpiredCheckpoints = await storageAdapter.cleanExpiredCheckpoints();
    const prunedIdemp = await idempotencyStore.cleanupExpired();

    console.log(`Maintenance Summary:
      - Deleted Checkpoints: ${prunedCheckpoints}
      - Expired Checkpoints: ${prunedExpiredCheckpoints}
      - Deleted Context Events: ${prunedEvents}
      - Deleted Wait Records: ${prunedWaits}
      - Expired Idempotency Keys: ${prunedIdemp}`);
}

// 8. Graceful Shutdown
export async function shutdown() {
    await pool.end();
    console.log('PostgreSQL connection pool closed.');
}
```
