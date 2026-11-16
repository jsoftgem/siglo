# Siglo Storage Adapters Reference

Architecture, schema specifications, and configuration parameters for `@siglo/postgres` and `@siglo/redis`.

---

## 1. PostgreSQL Adapter (`@siglo/postgres`)

### SQL Schema Overview

The adapter manages the following tables:

1. **`siglo_checkpoints`**:
    - `stack_id` (VARCHAR(128) PRIMARY KEY)
    - `namespace` (VARCHAR(64) NOT NULL)
    - `workflow_name` (VARCHAR(128))
    - `workflow_version` (VARCHAR(32))
    - `version` (INTEGER NOT NULL) -- OCC version counter
    - `status` (VARCHAR(32) NOT NULL) -- 'RUNNING' | 'COMPLETED' | 'FAILED' | 'WAITING'
    - `context_state` (JSONB NOT NULL)
    - `created_at` (TIMESTAMPTZ NOT NULL)
    - `updated_at` (TIMESTAMPTZ NOT NULL)
    - `expires_at` (TIMESTAMPTZ)

2. **`siglo_waits`**:
    - `event_name` (VARCHAR(128) NOT NULL)
    - `correlation_key` (VARCHAR(256) NOT NULL)
    - `stack_id` (VARCHAR(128) REFERENCES siglo_checkpoints)
    - `timeout_at` (TIMESTAMPTZ NOT NULL)
    - PRIMARY KEY (`event_name`, `correlation_key`)

3. **`siglo_events`**:
    - Immutable audit trail of state transitions and step outputs.

### Configuration Parameters

```typescript
interface PostgresStorageAdapterOptions {
    client: PostgresClientInterface | pg.Pool; // pg Pool or Client instance
    checkpointsTable?: string; // Checkpoints table name (default: 'siglo_checkpoints')
    eventsTable?: string; // Audit log table name (default: 'siglo_events')
    waitRecordsTable?: string; // Suspended waits table name (default: 'siglo_waits')
    recordContextChanges?: boolean; // Whether to write audit events (default: true)
}

interface PostgresIdempotencyOptions {
    client: PostgresClientInterface | pg.Pool; // pg Pool or Client instance
    tableName?: string; // Deduplication table (default: 'siglo_idempotency')
    defaultTtlMs?: number; // Default TTL in ms
}
```

---

## 2. Redis Adapter (`@siglo/redis`)

### Key Design & Data Structures

Redis uses standard key prefixes with TTL:

- `siglo:checkpoint:<stackId>`: Hash containing execution state, OCC version, and serialized context.
- `siglo:wait:<eventName>:<correlationKey>`: String mapping correlation key to `stackId`.
- `siglo:lock:workflow:<stackId>`: Distributed mutex key acquired with `SET NX PX`.
- `siglo:idemp:<key>`: Atomic claim status and cached return value.

### Configuration Parameters

```typescript
interface RedisStorageAdapterOptions {
    client: Redis; // ioredis client or cluster instance
    keyPrefix?: string; // Prefix for all keys (default: 'siglo:')
    defaultTtlSeconds?: number; // Default TTL for completed workflows (default: 30 days)
    lockTimeoutMs?: number; // Lock expiration in ms (default: 10000)
}
```
