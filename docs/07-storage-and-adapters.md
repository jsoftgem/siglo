---
title: "Storage and Adapters"
description: "Pluggable persistence architecture for Siglo: PostgreSQL and Redis adapters, durable checkpoints, distributed locks, multi-tenant namespaces, and storage error modes."
---

# Storage and Adapters

`Siglo` features a decoupled storage architecture: the workflow runtime operates cleanly in memory, while state persistence, distributed caching, audit trails, and idempotency claims are delegated to pluggable `StorageAdapter` implementations.

---

## 1. The `StorageAdapter` Interface

```typescript
export interface StorageAdapter {
    name: string;

    // 1. Context & Event Streaming
    onContextChange?(entry: ContextChangeEvent): Promise<void> | void;

    // 2. Checkpointing & Durability
    saveCheckpoint?(checkpoint: SerializedExecutionStack): Promise<void>;
    getCheckpoint?(stackId: string): Promise<SerializedExecutionStack | undefined>;
    cleanExpiredCheckpoints?(): Promise<number> | number | void;

    // 3. Durable Wait Persistence & Workflow Locking
    saveWaitRecord?(record: any): Promise<void> | void;
    getWaitRecord?(correlationKeyOrStackId: string): Promise<any | undefined>;
    claimWaitRecord?(correlationKey: string, claimantId?: string, options?: { allowExpired?: boolean; eventPayload?: any }): Promise<any>;
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

Register an adapter globally using `useStorage(adapter)`:

```typescript
import { useStorage } from '@siglo/core';
import { PostgresStorageAdapter } from '@siglo/postgres';

const adapter = new PostgresStorageAdapter({ client: pgPool });
useStorage(adapter);
```

---

## 2. Production Ecosystem Adapters

### `@siglo/postgres`
ACID-compliant state persistence, durable checkpoint storage, audit event log tables, and transactional idempotency locking.

```typescript
import { Pool } from 'pg';
import { PostgresStorageAdapter, PostgresIdempotencyStore } from '@siglo/postgres';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const storage = new PostgresStorageAdapter({ client: pool });
await storage.ensureTables();
useStorage(storage);
```

### `@siglo/redis`
Low-latency state caching, distributed TTL step caching, atomic idempotency claim sets, and distributed redlock mutexes.

```typescript
import { Redis } from 'ioredis';
import { RedisStorageAdapter, RedisLock } from '@siglo/redis';

const redis = new Redis(process.env.REDIS_URL);
const storage = new RedisStorageAdapter({ client: redis, ttlMs: 86400000 });
useStorage(storage);
```

### Event & Transport Adapters
- `@siglo/express`: HTTP route handler adapter.
- `@siglo/fastify`: High-performance Fastify route handler adapter.
- `@siglo/hono`: Web Standards (`Request`/`Response`) adapter (requires Node runtime APIs such as `node:async_hooks` and `node:net` or polyfilled Node compatibility mode).
- `@siglo/kafka`: High-throughput Kafka consumer partition batch processor.
- `@siglo/bullmq`: Resilient Redis background queue job runner.
- `@siglo/sqs`: AWS SQS batch consumer with partial failure reporting.

See [Ecosystem Adapters Overview](/ecosystem-adapters) for full details on each adapter.

---

## 3. Multi-Tenancy & Namespaces

Every checkpoint, cache key, and event stream supports namespace scoping:

```typescript
await workflow.run(input, {
    namespace: 'tenant_acme_corp',
    checkpoint: true, // Persists intermediate step snapshots to storage adapter
    durable: true     // Enables wait record persistence and suspension
});
```

Adapters partition keys by namespace to prevent key collisions across tenants. Note that namespace scoping is logical key partitioning; application authorization and explicit validation are still required to ensure secure multi-tenant isolation.

---

## Minimal Example

```typescript
import { Step, flow, useStorage, StorageAdapter } from '@siglo/core';

const customAuditAdapter: StorageAdapter = {
    name: 'console-audit',
    onContextChange: (evt) => {
        console.log(`[AUDIT] Step ${evt.stepId} changed field ${evt.field}`);
    }
};

useStorage(customAuditAdapter);

const s1 = Step.create('init', () => ({ initialized: true }));
const wf = flow(s1);
await wf.run();
```

---

## Failure Example: Handling Storage Adapter Outages

Configure `setErrorMode()` (`'best-effort' | 'warn' | 'strict'`) to define behavior when storage adapters encounter errors:

```typescript
import { setErrorMode } from '@siglo/core';

// In mission-critical environments: 'strict' rejects unhandled storage failures on awaited persistence
setErrorMode('strict');

// In resilient latency-sensitive pipelines: 'warn' logs warnings and continues
setErrorMode('warn');
```

---

## Testing Example

Using `InMemoryStorageFake` from `@siglo/testing`:

```typescript
import { expect } from 'chai';
import { InMemoryStorageFake, createWorkflowHarness } from '@siglo/testing';
import { Step, flow } from '@siglo/core';

const wf = flow(Step.create('test', () => ({ ok: true })));

describe('Storage Adapter Testing', () => {
    it('captures context changes in memory fake', async () => {
        const fakeStorage = new InMemoryStorageFake();
        const harness = createWorkflowHarness(wf, { storage: fakeStorage });

        await harness.run();
        expect(fakeStorage.contextChanges.length).to.be.greaterThan(0);
    });
});
```

---

## Operational Caveats

1. **Table Schema Migration**: When deploying `@siglo/postgres`, execute `ensureTables()` during database migrations or deployment pipelines, not on individual application instance boot.
2. **TTL Cleanups**: Configure a cron job or background worker to call `cleanExpiredCheckpoints()` daily to maintain optimal database query speeds.
3. **Optimistic Locking**: Storage adapters implement optimistic concurrency control (OCC) to prevent conflicting concurrent executions on the same stack identifier.

---

## API Reference Links

- [Core Concepts Guide](/02-core-concepts)
- [Ecosystem Adapters Overview](/ecosystem-adapters)
- [PostgreSQL Adapter Reference](/adapters/postgres)
- [Redis Adapter Reference](/adapters/redis)
