# Production Best Practices & Operational Runbook

> Master engineering guide for deploying **Siglo** workflows in mission-critical, distributed, high-throughput enterprise production environments.

---

## Architecture Overview

```
                                 ┌─────────────────────────────────────────────────────────┐
                                 │                 Client & Ingress Layer                  │
                                 │           (API Gateway / Load Balancer)                 │
                                 └────────────────────────────┬────────────────────────────┘
                                                              │
                                    ┌─────────────────────────┴─────────────────────────┐
                                    ▼                                                   ▼
┌────────────────────────────────────────────────────────┐     ┌────────────────────────────────────────────────────────┐
│                   Worker Pod A                         │     │                   Worker Pod B                         │
│  - Siglo Runtime (Deterministic Concurrency)           │     │  - Siglo Runtime (Deterministic Concurrency)           │
│  - Zero-Trust Network Perimeter (DNS IP Pinning)       │     │  - Zero-Trust Network Perimeter (DNS IP Pinning)       │
│  - Named Compensation Registry                         │     │  - Named Compensation Registry                         │
│  - PostgresWaitPoller (Advisory Selection & Locks)     │     │  - PostgresWaitPoller (Advisory Selection & Locks)     │
└───────────────────────────┬────────────────────────────┘     └───────────────────────────┬────────────────────────────┘
                            │                                                              │
                            └─────────────────────────────┬────────────────────────────────┘
                                                          │
                                                          ▼
                                ┌──────────────────────────────────────────────────┐
                                │          PostgreSQL 14+ / Redis Cluster          │
                                │  - siglo_checkpoints (CAS OCC Versioning)        │
                                │  - siglo_wait_records (Atomic Resumption Claims) │
                                │  - siglo_idempotency_records (Wait-and-Settle)   │
                                └──────────────────────────────────────────────────┘
```

---

## 1. Distributed Storage & Checkpoint OCC

### A. PostgreSQL Schema Setup
When running multi-pod Kubernetes or ECS workloads, you must enable **Optimistic Concurrency Control (OCC)** to prevent Last-Write-Wins (LWW) state clobbering across concurrent worker nodes.

Run the following DDL migration (or use `adapter.ensureTables()`):

```sql
-- Checkpoints with Optimistic Concurrency Control
CREATE TABLE IF NOT EXISTS siglo_checkpoints (
    stack_id VARCHAR(255) PRIMARY KEY,
    namespace VARCHAR(255),
    state JSONB NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_siglo_checkpoints_ns ON siglo_checkpoints(namespace);

-- Durable wait records with row-level locking indexes
CREATE TABLE IF NOT EXISTS siglo_wait_records (
    correlation_key VARCHAR(255) PRIMARY KEY,
    stack_id VARCHAR(255) NOT NULL,
    namespace VARCHAR(255),
    event_name VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'WAITING',
    continuation_step_index INT NOT NULL DEFAULT 0,
    version VARCHAR(50),
    data JSONB,
    locked_by VARCHAR(255),
    locked_at TIMESTAMPTZ,
    resume_payload JSONB,
    resumed_by VARCHAR(255),
    resumed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_siglo_wait_records_due ON siglo_wait_records(status, expires_at);

-- Idempotency store with settlement status
CREATE TABLE IF NOT EXISTS siglo_idempotency_records (
    key VARCHAR(255) PRIMARY KEY,
    status VARCHAR(50) NOT NULL,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_siglo_idempotency_expires ON siglo_idempotency_records(expires_at);
```

### B. Handling `OptimisticLockException`
If two worker nodes execute concurrent step completions or resumptions for the same `stackId`, the second update raises `OptimisticLockException`. Wrap workflow execution in an exponential backoff retry loop:

```typescript
import { flow, OptimisticLockException } from '@siglo/core';

async function runWithOCCRetry<T>(workflow: any, input: any, maxAttempts = 3): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await workflow.run(input, { durable: true });
        } catch (error) {
            if (error instanceof OptimisticLockException && attempt < maxAttempts) {
                const backoffMs = Math.floor(Math.random() * 50 * Math.pow(2, attempt));
                await new Promise(res => setTimeout(res, backoffMs));
                continue;
            }
            throw error;
        }
    }
    throw new Error('OCC retry exhausted');
}
```

---

## 2. Durable Timers & Worker Schedulers (`@siglo/scheduler`)

### A. Deploying the Background Poller Daemon
To resume sleeping workflows (`wait('24h')` or `waitForEvent('APPROVAL', { timeout: '7d' })`) even after container restarts:

```typescript
import { PostgresWaitPoller } from '@siglo/scheduler';
import { dbPool } from './db';
import { workflowRegistry } from './workflows';

const poller = new PostgresWaitPoller({
    client: dbPool,
    pollIntervalMs: 1000,
    batchSize: 50,
    // lockTimeoutMs must be >= 3x the max expected duration of steps after wait
    lockTimeoutMs: 60000,
    flowLookup: (version, stackId) => workflowRegistry.get(stackId),
    onResumed: (rec) => console.info(`Workflow ${rec.stackId} resumed successfully`),
    onFailed: (rec, err) => console.error(`Resumption failed for ${rec.stackId}:`, err)
});

// Start poller loop
poller.start();

// Graceful container shutdown (Kubernetes SIGTERM)
process.on('SIGTERM', async () => {
    console.info('Stopping scheduler poller...');
    await poller.stop();
    await dbPool.end();
    process.exit(0);
});
```

### B. Serverless & Cloud-Native Webhook Dispatchers
For serverless architectures (AWS Lambda, Google Cloud Run) where persistent background polling is prohibited, use `createSchedulerWebhookHandler` connected to AWS EventBridge Scheduler or Google Cloud Tasks:

```typescript
import http from 'http';
import { createSchedulerWebhookHandler } from '@siglo/scheduler';
import { workflowRegistry } from './workflows';

const webhookHandler = createSchedulerWebhookHandler({
    secretToken: process.env.SCHEDULER_SECRET_TOKEN,
    flowLookup: (workflowId, stackId) => workflowRegistry.get(stackId)
});

const server = http.createServer(webhookHandler);
server.listen(8080);
```

When scheduling a durable timer in Cloud Tasks:
- Target URL: `https://api.yourdomain.com/scheduler/resume`
- Headers: `Authorization: Bearer <SCHEDULER_SECRET_TOKEN>`
- Body: `{"stackId": "stack-12345", "payload": {"event": {"type": "timer:expired"}}}`

---

## 3. Idempotency & Thundering Herd Defense

### A. Wait-and-Settle Configuration
In high-volume webhook endpoints (e.g., Stripe, Shopify) or distributed messaging consumers (Kafka, SQS), concurrent duplicates can hit workers within milliseconds.

Instead of rejecting duplicates immediately with 409 Conflict, enable **Wait-and-Settle**:

```typescript
import { Step } from '@siglo/core';
import { PostgresIdempotencyStore } from '@siglo/postgres';

const idempotencyStore = new PostgresIdempotencyStore({ client: dbPool });

export const chargeCardStep = Step.create('chargeCard', async (ctx: any) => {
    return await paymentGateway.charge({ amount: ctx.amount, customerId: ctx.customerId });
})
.idempotent((ctx) => `charge:${ctx.orderId}`, {
    store: idempotencyStore,
    ttlMs: 86400000,          // 24-hour claim retention
    settleTimeoutMs: 3000,    // Spin-wait up to 3000ms for in-flight request to settle
    pollIntervalMs: 50        // Check state every 50ms
});
```

### B. Two-Tier Error Classification
When handling errors in idempotent steps, differentiate between **permanent business declines** and **transient infrastructure faults**:
- **Permanent Business Errors** (e.g. `CardDeclined`, `AccountNotFound`): Call `idempotencyStore.complete(key, { error: 'CardDeclined' })` so retried requests return the cached decline without charging the card again.
- **Transient Infrastructure Errors** (e.g. `ETIMEDOUT`, `503 Service Unavailable`): Let Siglo call `idempotencyStore.fail(key)`, releasing the claim so subsequent retry attempts re-execute against the gateway.

---

## 4. Zero-Trust Network Perimeter & SSRF Hardening

### A. Pre-Flight DNS Resolution & IP Pinning
Siglo enforces declarative network egress boundaries when using `.networkPolicy()` on flows or `.allowNetwork()` on steps.

```typescript
import { flow, Step } from '@siglo/core';

const partnerStep = Step.create('callPartnerWebhook', async (ctx: any) => {
    const res = await fetch(ctx.webhookUrl, { method: 'POST', body: JSON.stringify(ctx.payload) });
    return await res.json();
}).allowNetwork(['api.partner.com', 'hooks.slack.com']);

export const secureWebhookFlow = flow(partnerStep)
.networkPolicy({
    defaultPolicy: 'deny',
    allowedHosts: ['api.partner.com', 'hooks.slack.com'],
    allowLocalhost: false
});
```

### B. Unix Domain Socket Hardening
By default when network policy is active, Unix domain sockets are disallowed unless explicitly listed in `allowUnixSockets`:

```typescript
flowInstance.networkPolicy({
    allowUnixSockets: ['/var/run/custom-app.sock']
});
```

---

## 5. Sagas, Named Compensations & Dead-Letter Queues (DLQ)

### A. Named Compensation Registry
Never rely on in-memory closures for long-running workflows across service deployments. Register named compensation handlers:

```typescript
import { Step, registerCompensationHandler } from '@siglo/core';

// 1. Register named compensations once at application startup
registerCompensationHandler('billing:refundCharge', async (output, input, ctx) => {
    await stripe.refunds.create({ charge: ctx.chargeId });
});

registerCompensationHandler('inventory:releaseHold', async (output, input, ctx) => {
    await inventoryService.release(ctx.reservationId);
});

// 2. Reference named compensations in your steps
export const reserveInventoryStep = Step.create('reserveInventory', async (ctx: any) => {
    const res = await inventoryService.reserve(ctx.itemId, ctx.quantity);
    return { reservationId: res.id };
})
.compensate('inventory:releaseHold');
```

### B. Best-Effort Compensations & Persistent DLQ Sink
Provide a `deadLetterQueue` sink with a `send` method through `CompensationRunOptions` to capture compensation failures:

```typescript
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({ region: 'us-east-1' });

const deadLetterQueue = {
    send: async (entry: any) => {
        await sqs.send(new SendMessageCommand({
            QueueUrl: process.env.COMPENSATION_DLQ_URL,
            MessageBody: JSON.stringify(entry)
        }));
    }
};

// Execute best-effort saga rollback with DLQ sink:
await orderFlow.compensate('stack-id-to-rollback', {
    mode: 'best-effort',
    deadLetterQueue
});
```

### C. Stale Stack Reconciliation Sweep
Deploy a scheduled Kubernetes CronJob running the reconciler every 10 minutes to recover from unhandled pod crashes or OOM events:

```bash
npm exec --package=@siglo/cli -- siglo reconcile --stale-threshold=10m --action=compensate
```

---

## 6. DevTools & Control Plane Hardening (`@siglo/monitor`)

### A. Production Monitor Configuration
Never expose the DevTools monitor without authentication and telemetry redaction:

```typescript
import { createMonitorServer } from '@siglo/monitor';
import { z } from 'zod';
import { orderFlow } from './workflows';

// Enforce strict schema on workflow resume payloads
orderFlow.resumeSchema = z.object({
    approved: z.boolean(),
    approverId: z.string().uuid(),
    comments: z.string().max(500).optional()
}).strict(); // .strict() rejects unknown keys with validation errors

const monitorServer = await createMonitorServer({
    port: 4000,
    workflows: {
        orderFlow
    },
    // Disable remote resumptions in production (read-only monitoring)
    allowRemoteResume: process.env.NODE_ENV !== 'production',
    auth: {
        apiKey: process.env.MONITOR_API_KEY,
        adminKey: process.env.MONITOR_ADMIN_KEY
    },
    security: {
        // Redact PII and secrets in SSE, WebSockets, and GET endpoints
        redactedKeys: [
            'password', 'secret', 'token', 'apiKey', 
            'creditCard', 'ssn', 'authorization'
        ]
    },
    cors: {
        origin: ['https://internal-devtools.yourdomain.com']
    }
});
```

---

## 7. Concurrency & Resource Tuning

| Parameter | Recommended Production Value | Justification |
|---|---|---|
| **PostgreSQL Pool `max`** | `(workerConcurrency * 2) + 10` | Accommodates step execution, OCC checkpoints, and wait claims without connection starvation. |
| **Node.js Memory Flag** | `--max-old-space-size=2048` | Prevents V8 heap exhaustion when buffering large payloads or batch pipelines. |
| **Scheduler `pollIntervalMs`** | `1000` (1s) | Balances timely pickup of due timers with database polling query overhead. |
| **Idempotency `settleTimeoutMs`** | `3000` (3s) | Matches typical p95 API latency to cleanly resolve concurrent webhook duplicate races. |
| **Batch `map` Concurrency** | `{ concurrency: 10 }` | Prevents runaway event loop lag and downstream HTTP socket exhaustion. |

---

## Production Readiness Checklist

Before tagging your service for production release, verify the following:

- [ ] **OCC Versioning Active**: `siglo_checkpoints` table includes `version BIGINT DEFAULT 1`.
- [ ] **Row-Level Poller Running**: `@siglo/scheduler` instance started with graceful `SIGTERM` handler.
- [ ] **Wait-and-Settle Configured**: Critical financial / billing steps configure bounded `settleTimeoutMs`.
- [ ] **Named Compensations Registered**: All durable sagas use `registerNamedCompensation` rather than local closures.
- [ ] **Compensation DLQ Connected**: `defaultCompensationDLQ.onEntry` forwards failed rollbacks to SQS or Kafka.
- [ ] **Cron Reconciler Scheduled**: `npm exec --package=@siglo/cli -- siglo reconcile` scheduled to sweep stale stacks past heartbeat windows.
- [ ] **Network Policies Enforced**: Zero-trust egress rules block RFC 1918 private IPs and container Unix sockets.
- [ ] **Monitor Security Hardened**: DevTools server configured with authentication tokens, field redaction, and `allowRemoteResume: false`.
- [ ] **OpenTelemetry Active**: Traceparent headers injected via `@siglo/opentelemetry` for distributed tracing.
