# 12. Production Operations

This runbook covers operational best practices, capacity planning, distributed coordination, and disaster recovery when running `fluid-func` workflows in mission-critical production environments.

---

## 1. Zero-Daemon Architecture vs Worker Clusters

`fluid-func` does not mandate external central orchestration servers or daemons (like Temporal or Camunda). It operates as an embedded in-process execution engine that runs within your existing:
- Node.js API servers (Express, Fastify, Hono, NestJS)
- Background queue workers (BullMQ, AWS SQS)
- Stream consumers (Apache Kafka, RabbitMQ)
- Serverless / Edge functions (AWS Lambda, Google Cloud Run, Cloudflare Workers)

### When to Run In-Process vs Dedicated Workers
- **Synchronous Low-Latency APIs (< 5s)**: Execute workflows directly inside your HTTP route handlers using `@fluid-func/fastify` or `@fluid-func/express`.
- **Long-Running & Background Workflows (> 5s)**: Ingest requests into a queue (BullMQ or SQS) and execute workflows within dedicated worker container pools.

---

## 2. Production Checklist

1. [ ] **Storage Adapter Configured**: Production `StorageAdapter` (`@fluid-func/postgres` or `@fluid-func/redis`) registered via `useStorage()`.
2. [ ] **Idempotency Stores Enabled**: Critical payment, billing, or notification steps configured with `.idempotent()`.
3. [ ] **Telemetry & Tracing**: Distributed tracing activated via `@fluid-func/opentelemetry`.
4. [ ] **Deadlines Set**: Step and workflow level `.timeout(ms)` configured to prevent hung worker threads.
5. [ ] **Compensations Tested**: Sagas and compensating rollbacks tested with fault injection in staging.
6. [ ] **Retention Cleanup Cron**: Periodic maintenance job calling `cleanExpiredCheckpoints()` scheduled.

---

## 3. High-Throughput Idempotency & Distributed Locking

To prevent duplicate processing when workers run concurrently across multiple Kubernetes pods:

```typescript
import { Step, flow } from 'fluid-func';
import { PostgresIdempotencyStore } from '@fluid-func/postgres';

const pgStore = new PostgresIdempotencyStore(pgPool);

export const idempotentBillingStep = Step.create('billCustomer', async (param: { invoiceId: string }) => {
    return await stripe.invoices.pay(param.invoiceId);
})
.idempotent((ctx) => ctx.invoiceId, {
    store: pgStore,
    ttlMs: 86400000 // 24 hours
})
.modern();
```

---

## 4. Connection Pooling and Resource Limits

When running workflows with parallel fan-out (`parallel([...])`) or batch mapping (`map(...)`):
- **Database Pools**: Set `max` pool connections to `(concurrency * workerInstances) + buffer`.
- **Bounded Concurrency**: Always specify `{ concurrency: N }` on `map()` steps to avoid exhausting memory or database sockets.
- **Node.js Memory**: Set `--max-old-space-size=2048` or higher if batching large datasets in memory.

---

## 5. Retention & State Cleanup

Checkpoints and audit event tables should be cleaned according to compliance retention policies:

```typescript
import { defaultStorageManager } from 'fluid-func';

// Daily maintenance job:
async function runDailyCleanup() {
    const expiredCount = await defaultStorageManager.cleanExpiredCheckpoints();
    console.log(`Cleaned ${expiredCount} expired checkpoints.`);
}
```

---

## Minimal Example: Production Fastify Service

```typescript
import fastify from 'fastify';
import { Pool } from 'pg';
import { Step, flow, useStorage } from 'fluid-func';
import { PostgresStorageAdapter } from '@fluid-func/postgres';
import { createFastifyWorkflowHandler } from '@fluid-func/fastify';

const app = fastify();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const storage = new PostgresStorageAdapter(pool);
useStorage(storage);

const myStep = Step.create('hello', async () => ({ status: 'HEALTHY' })).modern();
const healthFlow = flow(myStep);

app.get('/health', createFastifyWorkflowHandler(healthFlow));

app.listen({ port: 3000 });
```

---

## Failure Example: Handling Distributed Lock Timeouts

```typescript
import { RedisLock } from '@fluid-func/redis';

const lock = new RedisLock(redisClient);

try {
    await lock.withLock('lock:order:1001', async () => {
        // Critical section: single-flight execution
        await processOrder('1001');
    }, { ttlMs: 5000, maxRetries: 3 });
} catch (err: any) {
    console.error('Could not acquire distributed lock:', err.message);
}
```

---

## Testing Example

```typescript
import { expect } from 'chai';
import { createWorkflowHarness, InMemoryStorageFake } from '@fluid-func/testing';
import { Step, flow } from 'fluid-func';

const auditWorkflow = flow(
    Step.create('audit', () => ({ ok: true })).modern()
);

describe('Production Readiness Smoke Test', () => {
    it('executes cleanly with mock storage and returns status', async () => {
        const storageFake = new InMemoryStorageFake();
        const harness = createWorkflowHarness(auditWorkflow, { storage: storageFake });

        const result = await harness.run();
        expect(result.ok).to.be.true;
    });
});
```

---

## Operational Caveats

1. **Avoid Unbounded In-Memory Checkpoints**: In-memory checkpoints default to storing state in RAM. In production, always use `@fluid-func/postgres` or `@fluid-func/redis` to persist checkpoints across container restarts.
2. **Graceful Worker Shutdown**: Listen for `SIGTERM` and `SIGINT` in container workloads, aborting active `AbortController` signals to allow active steps to clean up cleanly.

---

## API Reference Links

- [Getting Started](./01-getting-started.md)
- [Storage and Adapters](./07-storage-and-adapters.md)
- [Observability Guide](./08-observability.md)
- [Testing & Replay Reference](./09-testing-and-replay.md)
