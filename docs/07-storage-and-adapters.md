# 07. Storage and Adapters

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

    // 3. Distributed Caching
    getCachedStep?(key: string): Promise<any | undefined>;
    setCachedStep?(key: string, value: any, ttlMs: number): Promise<void>;

    // 4. Cache & Telemetry Events
    onCacheEvent?(event: CacheEvent): Promise<void> | void;
}
```

Register an adapter globally using `useStorage(adapter)`:

```typescript
import { useStorage } from '@siglo/core';
import { PostgresStorageAdapter } from '@siglo/postgres';

const adapter = new PostgresStorageAdapter(pgPool);
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
const storage = new PostgresStorageAdapter(pool);
await storage.ensureTables();
useStorage(storage);
```

### `@siglo/redis`
Low-latency state caching, distributed TTL step caching, atomic idempotency claim sets, and distributed redlock mutexes.

```typescript
import { Redis } from 'ioredis';
import { RedisStorageAdapter, RedisLock } from '@siglo/redis';

const redis = new Redis(process.env.REDIS_URL);
const storage = new RedisStorageAdapter(redis, { ttlMs: 86400000 });
useStorage(storage);
```

### Event & Transport Adapters
- `@siglo/express`: HTTP route handler adapter.
- `@siglo/fastify`: High-performance Fastify route handler adapter.
- `@siglo/hono`: Edge-ready Web Standards (Cloudflare Workers, Deno, Node) adapter.
- `@siglo/kafka`: High-throughput Kafka consumer partition batch processor.
- `@siglo/bullmq`: Resilient Redis background queue job runner.
- `@siglo/sqs`: AWS SQS batch consumer with partial failure reporting.

See [Ecosystem & Adapters Guide](./ecosystem-adapters.md) for full details on each adapter.

---

## 3. Multi-Tenancy & Namespaces

Every checkpoint, cache key, and event stream supports namespace scoping:

```typescript
await workflow.run(input, {
    namespace: 'tenant_acme_corp',
    checkpoint: true
});
```

Adapters partition data by namespace, preventing cross-tenant leakage.

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

Configure `setErrorMode()` to define behavior when storage adapters encounter network errors:

```typescript
import { setErrorMode, StorageErrorMode } from '@siglo/core';

// In mission-critical environments: FAIL_CLOSED aborts workflow if audit storage fails
setErrorMode(StorageErrorMode.FAIL_CLOSED);

// In resilient latency-sensitive pipelines: FAIL_OPEN logs warnings and continues
setErrorMode(StorageErrorMode.FAIL_OPEN);
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

1. **Table Schema Migration**: When deploying `@siglo/postgres`, execute `ensureTables()` during database migrations, not on individual application instance boot.
2. **TTL Cleanups**: Configure a cron job to call `cleanExpiredCheckpoints()` daily to maintain optimal database query speeds.

---

## API Reference Links

- [Ecosystem Adapters Overview](./ecosystem-adapters.md)
- [PostgreSQL Adapter Reference](./adapters/postgres.md)
- [Redis Adapter Reference](./adapters/redis.md)
