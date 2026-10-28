# @rivulet/postgres Adapter Guide

`@rivulet/postgres` provides an enterprise ACID-compliant persistence adapter for `Rivulet` workflows using PostgreSQL. It offers durable execution checkpointing, immutable context mutation audit event logging, automated table initialization, schema indexing, retention policy cleanup, and distributed atomic idempotency claim locking.

---

## 1. Overview & Architecture

When workflows coordinate mission-critical financial, compliance, or enterprise transactions, state persistence must survive node failures and network partitions:

```
                          ┌───────────────────────────┐
                          │    Rivulet Engine      │
                          └─────────────┬─────────────┘
                                        │
             ┌──────────────────────────┴──────────────────────────┐
             │                                                     │
             ▼                                                     ▼
┌─────────────────────────┐                               ┌─────────────────────────┐
│ PostgresStorageAdapter  │                               │ PostgresIdempotencyStore│
│ • saveCheckpoint()      │                               │ • claim()               │
│ • getCheckpoint()       │                               │ • complete()            │
│ • onContextChange()     │                               │ • fail()                │
│ • cleanupOldCheckpoints │                               │ • cleanupExpired()      │
└────────────┬────────────┘                               └────────────┬────────────┘
             │                                                         │
             ▼                                                         ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                               PostgreSQL Database                                 │
│                                                                                   │
│  rivulet_checkpoints          rivulet_context_events        rivulet_idempotency         │
│  ┌──────────────────────┐   ┌───────────────────────┐   ┌───────────────────────┐ │
│  │ stack_id (PK)        │   │ id (BIGSERIAL PK)     │   │ key (VARCHAR(512) PK) │ │
│  │ namespace            │   │ stack_id              │   │ status                │ │
│  │ state (JSONB)        │   │ step_id               │   │ result (JSONB)        │ │
│  │ created_at / updated │   │ field, value (JSONB)  │   │ expires_at, created_at│ │
│  └──────────────────────┘   └───────────────────────┘   └───────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Installation & Requirements

Install `@rivulet/postgres` and `pg`:

```bash
npm install Rivulet @rivulet/postgres pg
npm install --save-dev @types/pg
```

Peer dependency matrix:
- `Rivulet`: `*` (v1.0.0+)
- `pg`: `^8.0.0`

---

## 3. Database Schema

Both `PostgresStorageAdapter` and `PostgresIdempotencyStore` support automated table creation via `ensureTables()` / `ensureTable()`.

### DDL Definitions:

```sql
-- 1. Checkpoint Storage Table
CREATE TABLE IF NOT EXISTS rivulet_checkpoints (
    stack_id VARCHAR(255) PRIMARY KEY,
    namespace VARCHAR(255),
    state JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rivulet_checkpoints_namespace ON rivulet_checkpoints(namespace);

-- 2. Context Mutation Audit Log
CREATE TABLE IF NOT EXISTS rivulet_context_events (
    id BIGSERIAL PRIMARY KEY,
    stack_id VARCHAR(255) NOT NULL,
    step_id VARCHAR(255) NOT NULL,
    namespace VARCHAR(255),
    field VARCHAR(255) NOT NULL,
    value JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rivulet_context_events_stack ON rivulet_context_events(stack_id);

-- 3. Distributed Idempotency Table
CREATE TABLE IF NOT EXISTS rivulet_idempotency (
    key VARCHAR(512) PRIMARY KEY,
    status VARCHAR(50) NOT NULL,
    result JSONB,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rivulet_idempotency_expires ON rivulet_idempotency(expires_at);
```

---

## 4. `PostgresStorageAdapter` API Reference

Implements the standard `StorageAdapter` interface.

```typescript
import { PostgresStorageAdapter } from '@rivulet/postgres';
```

### Constructor Options (`PostgresStorageAdapterOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `client` | `PostgresClientInterface \| Pool` | *Required* | Active PostgreSQL `Pool` or `Client` instance. |
| `checkpointsTable` | `string` | `'rivulet_checkpoints'` | Name of checkpoints table. |
| `eventsTable` | `string` | `'rivulet_context_events'` | Name of context change audit table. |
| `recordContextChanges` | `boolean` | `true` | If `true`, writes all step context mutations into `eventsTable`. |

### Methods

#### `ensureTables(): Promise<void>`
Executes DDL statements to create tables and indexes if they do not already exist.

#### `saveCheckpoint(checkpoint: SerializedExecutionStack): Promise<void>`
Upserts a serialized execution stack by `stackId`, updating the `state` JSONB and `updated_at` timestamp.

#### `getCheckpoint(stackId: string): Promise<SerializedExecutionStack | undefined>`
Fetches the checkpoint by `stackId`. Returns `undefined` if no checkpoint is found.

#### `onContextChange(entry): Promise<void>`
Streams a field modification into `rivulet_context_events` with step ID, field name, JSONB value, and high-resolution timestamp.

#### `cleanupOldCheckpoints(retentionDays?: number): Promise<number>`
Deletes checkpoints older than `retentionDays` (default `30` days). Returns the count of deleted rows.

#### `cleanupOldEvents(retentionDays?: number): Promise<number>`
Deletes audit records older than `retentionDays` (default `30` days). Returns the count of deleted rows.

---

## 5. `PostgresIdempotencyStore` API Reference

Implements the standard `IdempotencyStore` interface.

```typescript
import { PostgresIdempotencyStore } from '@rivulet/postgres';
```

### Constructor Options (`PostgresIdempotencyOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `client` | `PostgresClientInterface \| Pool` | *Required* | Active PostgreSQL `Pool` or `Client` instance. |
| `tableName` | `string` | `'rivulet_idempotency'` | Name of idempotency table. |
| `defaultTtlMs` | `number` | `86400000` (24h) | Fallback expiration TTL in milliseconds. |

### Methods

#### `ensureTable(): Promise<void>`
Initializes the idempotency schema and expiration index.

#### `claim(key: string, ttlMs?: number): Promise<'claimed' | 'completed' | 'in-progress'>`
Atomically attempts to insert an `'in-progress'` record. If the key exists:
- If expired, reclaims the lock and returns `'claimed'`.
- If completed, returns `'completed'`.
- If currently running, returns `'in-progress'`.

#### `complete(key: string, result: unknown, ttlMs?: number): Promise<void>`
Transitions key status to `'completed'`, serializes the result into JSONB, and sets expiration.

#### `fail(key: string, error: unknown): Promise<void>`
Deletes in-progress claims so subsequent retries can proceed.

#### `getResult(key: string): Promise<unknown | undefined>`
Retrieves the stored JSONB result for completed keys.

#### `cleanupExpired(): Promise<number>`
Prunes expired idempotency records (`WHERE expires_at < NOW()`).

---

## 6. Complete Production Example

```typescript
import { Pool } from 'pg';
import { Step, flow } from 'rivulet';
import { PostgresStorageAdapter, PostgresIdempotencyStore } from '@rivulet/postgres';

// 1. Initialize PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/orders_db',
    max: 20,
    idleTimeoutMillis: 30000,
});

// 2. Initialize and Register Storage Adapter
const storageAdapter = new PostgresStorageAdapter({
    client: pool,
    recordContextChanges: true,
});
await storageAdapter.ensureTables();
Step.useStorage(storageAdapter);

// 3. Initialize Idempotency Store
const idempotencyStore = new PostgresIdempotencyStore({
    client: pool,
    defaultTtlMs: 86400000, // 24 hours
});
await idempotencyStore.ensureTable();

// 4. Define Payment Settlement Workflow
interface SettlementInput {
    settlementId: string;
    accountId: string;
    amount: number;
}

const debitSender = Step.create('debitSender', async (param: SettlementInput) => {
    // Perform database debit operation within pool
    return { debitReference: `dr_${param.settlementId}`, debited: true };
}).modern();

const creditReceiver = Step.create('creditReceiver', async (param: any) => {
    // Perform receiver credit
    return { creditReference: `cr_${param.settlementId}`, credited: true };
}).modern();

const settlementFlow = flow(debitSender, creditReceiver);

// 5. Execute with Distributed Idempotency Guard
async function runIdempotentSettlement(input: SettlementInput) {
    const idempKey = `settle:${input.settlementId}`;
    const claimStatus = await idempotencyStore.claim(idempKey, 30000); // 30s claim lock

    if (claimStatus === 'completed') {
        console.log('Settlement already processed. Returning cached result.');
        return await idempotencyStore.getResult(idempKey);
    }

    if (claimStatus === 'in-progress') {
        throw new Error(`Settlement ${input.settlementId} is already running concurrently.`);
    }

    try {
        const result = await settlementFlow.run(input, {
            namespace: 'finance-prod',
        });
        const clean = {
            settlementId: input.settlementId,
            debitReference: result.debitReference(),
            creditReference: result.creditReference(),
        };
        await idempotencyStore.complete(idempKey, clean);
        return clean;
    } catch (err) {
        await idempotencyStore.fail(idempKey, err);
        throw err;
    }
}

// 6. Maintenance Routine: Automated Data Retention
async function runRetentionCleanup() {
    const prunedCheckpoints = await storageAdapter.cleanupOldCheckpoints(14); // Retain 14 days
    const prunedEvents = await storageAdapter.cleanupOldEvents(30);           // Retain 30 days
    const prunedIdemp = await idempotencyStore.cleanupExpired();
    console.log(`Pruned: ${prunedCheckpoints} checkpoints, ${prunedEvents} events, ${prunedIdemp} idemp keys`);
}
```
