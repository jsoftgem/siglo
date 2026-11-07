# Production Operations

This runbook covers operational best practices, capacity planning, distributed coordination, and disaster recovery when running `Siglo` workflows in mission-critical production environments.

> [!TIP]
> For a comprehensive, step-by-step production hardening guide covering PostgreSQL OCC, `@siglo/scheduler` polling, zero-trust network policies, named compensation DLQs, and DevTools security, see the dedicated [Production Best Practices & Operational Runbook](./production-best-practices.md).

---

## 1. Zero-Daemon Architecture vs Worker Clusters

`Siglo` does not mandate external central orchestration servers or daemons (like Temporal or Camunda). It operates as an embedded in-process execution engine that runs within your existing:
- Node.js API servers (Express, Fastify, Hono, NestJS)
- Background queue workers (BullMQ, AWS SQS)
- Stream consumers (Apache Kafka, RabbitMQ)
- Serverless / Edge functions (AWS Lambda, Google Cloud Run, Cloudflare Workers with Node.js compatibility enabled)

### When to Run In-Process vs Dedicated Workers
- **Synchronous Low-Latency APIs (< 5s)**: Execute workflows directly inside your HTTP route handlers using `@siglo/fastify` or `@siglo/express`.
- **Long-Running & Background Workflows (> 5s)**: Ingest requests into a queue (BullMQ or SQS) and execute workflows within dedicated worker container pools.

---

## 2. Production Checklist

1. [ ] **Storage Adapter Configured**: Production `StorageAdapter` (`@siglo/postgres` or `@siglo/redis`) registered via `useStorage()`.
2. [ ] **Idempotency Stores Enabled**: Critical payment, billing, or notification steps configured with `.idempotent()`.
3. [ ] **Telemetry & Tracing**: Distributed tracing activated via `@siglo/opentelemetry`.
4. [ ] **Deadlines Set**: Step and workflow level `.timeout(ms)` configured to prevent hung worker threads.
5. [ ] **Compensations Tested**: Sagas and compensating rollbacks tested with fault injection in staging.
6. [ ] **Retention Cleanup Cron**: Periodic maintenance job calling `cleanExpiredCheckpoints()` scheduled.

---

## 3. High-Throughput Idempotency & Distributed Locking

To prevent duplicate processing when workers run concurrently across multiple Kubernetes pods:

```typescript
import { Step, flow } from '@siglo/core';
import { PostgresIdempotencyStore } from '@siglo/postgres';

const pgStore = new PostgresIdempotencyStore({ client: pgPool });

export const idempotentBillingStep = Step.create('billCustomer', async (param: { invoiceId: string }) => {
    return await stripe.invoices.pay(param.invoiceId);
})
.idempotent((ctx) => ctx.invoiceId, {
    store: pgStore,
    ttlMs: 86400000 // 24 hours
});
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
import { defaultStorageManager } from '@siglo/core';

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
import { Step, flow, useStorage } from '@siglo/core';
import { PostgresStorageAdapter } from '@siglo/postgres';
import { createFastifyWorkflowHandler } from '@siglo/fastify';

const app = fastify();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const storage = new PostgresStorageAdapter(pool);
useStorage(storage);

const myStep = Step.create('hello', async () => ({ status: 'HEALTHY' }));
const healthFlow = flow(myStep);

app.get('/health', createFastifyWorkflowHandler(healthFlow));

app.listen({ port: 3000 });
```

---

## Failure Example: Handling Distributed Lock Timeouts

```typescript
import { RedisLock } from '@siglo/redis';

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
import { createWorkflowHarness, InMemoryStorageFake } from '@siglo/testing';
import { Step, flow } from '@siglo/core';

const auditWorkflow = flow(
    Step.create('audit', () => ({ ok: true }))
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

1. **Avoid Unbounded In-Memory Checkpoints**: In-memory checkpoints default to storing state in RAM. In production, always use `@siglo/postgres` or `@siglo/redis` to persist checkpoints across container restarts.
2. **Graceful Worker Shutdown**: Listen for `SIGTERM` and `SIGINT` in container workloads, aborting active `AbortController` signals to allow active steps to clean up cleanly.

---

## API Reference Links

- [Production Best Practices & Operational Runbook](./production-best-practices.md)
- [Getting Started](./01-getting-started.md)
- [Storage and Adapters](./07-storage-and-adapters.md)
- [Observability Guide](./08-observability.md)
- [Testing & Replay Reference](./09-testing-and-replay.md)
