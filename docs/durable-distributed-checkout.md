---
title: 'Suspend Checkout for Approval and Resume Across Servers'
description: 'Suspend a distributed Siglo checkout workflow for human approval, persist execution state to PostgreSQL, and resume across server restarts.'
---

In [Run Checkout Across Two Servers with PostgreSQL and Redis](/distributed-rest-and-live-monitoring), both API instances executed orders synchronously from start to finish within a single HTTP request.

In real e-commerce and B2B systems, workflows often cannot finish in a few hundred milliseconds:

- **Asynchronous payment gateways**: 3D Secure verification, bank transfers, or payment redirects require waiting for an asynchronous webhook notification hours or days later.
- **Human-in-the-loop approvals**: High-value orders, risk exceptions, or manager sign-offs require an operator to inspect and approve the transaction.
- **Cooling-off windows**: Customers may have a 15-minute grace period to edit or cancel an order before the warehouse packs it (`wait('15m')`).

Holding open an HTTP connection or running an in-memory `setTimeout` is fatal in distributed environments: client connections time out, server processes crash or restart during deployments, and in-memory state is lost.

This continuation extends the distributed checkout stack with **durable workflows**: an execution can suspend cleanly at `waitForEvent` or `wait`, persist its complete state and continuation point to PostgreSQL, release all process resources, survive server restarts, and resume safely on **any** API replica when an external webhook or human approval arrives.

---

## Run the Ready-Made Example

You need a repository checkout, a running Docker daemon, and Docker Compose with `up --wait`. From the repository root, build and start the complete example without copying any tutorial snippets:

```bash
docker compose -f examples/durable-distributed-checkout/docker-compose.yml up --build -d --wait
```

This uses the separate **`siglo-durable-checkout`** Compose project, image, database volume, Redis channel, and host ports. The [previous tutorial](/distributed-rest-and-live-monitoring) and its `examples/distributed-checkout` stack can keep running unchanged.

| Service      | Local address                                  |
| ------------ | ---------------------------------------------- |
| API A        | http://127.0.0.1:3100                          |
| API B        | http://127.0.0.1:3101                          |
| Live Monitor | http://127.0.0.1:4100                          |
| PostgreSQL   | postgres://siglo:siglo@127.0.0.1:5434/checkout |
| Redis        | redis://127.0.0.1:6381                         |

Submit an order to API A. Expect **202 Accepted** with `status: "waiting"`:

```bash
curl -i http://127.0.0.1:3100/api/checkouts \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"quickstart-5001","sku":"espresso-machine","quantity":1,"amountCents":120000}'
```

Open **http://127.0.0.1:4100** to inspect the suspended run, then restart API A and approve the order on API B:

```bash
docker compose -f examples/durable-distributed-checkout/docker-compose.yml restart api-a
curl -i http://127.0.0.1:3101/api/webhooks/orders/quickstart-5001/approval \
  -H 'Content-Type: application/json' \
  -d '{"approved":true,"approverId":"reader@shop.com"}'
```

Expect **200 OK** with `result.status: "confirmed"`. Repeating approval returns **409 Conflict**. Every order in this demo requires approval. Reused submission IDs are rejected for 24 hours, so use a new order ID when repeating the walkthrough.

Run the automated smoke check, which restarts **both API replicas** between submission and resumption and also tests dashboard resumption:

```bash
sh examples/durable-distributed-checkout/smoke.sh
```

Stop only this example with:

```bash
docker compose -f examples/durable-distributed-checkout/docker-compose.yml down
```

Data survives `down`; add `--volumes` only when you want to reset this example's database. The previous tutorial's volume is separate.

### Example Files to Explore

| File                                                                                                          | Purpose                                                                     |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [checkout-durable.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/durable-distributed-checkout/checkout-durable.ts)                       | Reserve, charge with retry, wait for approval, and ship                     |
| [api-durable.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/durable-distributed-checkout/api-durable.ts)                                 | Express adapter submission, validation, deduplication, and approval webhook |
| [infrastructure.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/durable-distributed-checkout/infrastructure.ts)                           | PostgreSQL checkpoint/wait persistence, locking, and Redis clients          |
| [monitor.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/durable-distributed-checkout/monitor.ts)                                         | Central dashboard, Redis subscription, and interactive resumption           |
| [smoke.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/durable-distributed-checkout/smoke.ts)                                             | Assertions before and after API restarts                                    |
| [docker-compose.yml](https://github.com/jsoftgem/siglo/tree/main/examples/durable-distributed-checkout/docker-compose.yml)                             | Isolated two-replica stack                                                  |
| [Example README](https://github.com/jsoftgem/siglo/blob/main/examples/durable-distributed-checkout/README.md) | Commands, ports, and rebuilding after edits                                 |

The stock, payment, and shipping services are fake; no external provider credentials are needed. After trying the example, edit these files and rerun the build command above. The sections below explain how they fit together.

---

## 1. How Durable Distributed Execution Works

When a workflow runs with `{ durable: true }` and reaches a wait node (`waitForEvent` or `wait`), the runtime:

1. **Suspends Execution**: The step halts cleanly without blocking Node.js event loop threads.
2. **Persists Checkpoint**: The engine writes an OCC versioned checkpoint containing the accumulated context and step history to `siglo_checkpoints`.
3. **Registers Wait Record**: A durable wait descriptor is inserted into `siglo_wait_records` indexed by a business correlation key (e.g. `order:distributed-1001`).
4. **Returns Immediate Control**: The workflow returns `{ status: "waiting", correlationKey, stackId }`, enabling your API to respond immediately with `202 Accepted`.
5. **Releases the Request**: No HTTP connection or timer must stay open for the wait. The runtime may retain local state, but PostgreSQL holds the durable snapshot, so the API process can restart or deploy new code.
6. **Resumes Across Replicas**: When an external webhook arrives at **either API replica**, calling `resumeWorkflow` acquires a PostgreSQL advisory lock, claims the wait record atomically, restores the state snapshot, and executes the remaining steps to completion.

```mermaid
sequenceDiagram
    autonumber
    actor Customer
    participant API_A as Checkout API A (:3100)
    participant PG as PostgreSQL
    participant Redis as Redis Pub/Sub
    participant Monitor as Live Monitor (:4100)
    actor Approver
    participant API_B as Checkout API B (:3101)

    Customer->>API_A: POST /api/checkouts (Order $1,200)
    API_A->>API_A: reserveStock, chargePayment
    API_A->>PG: Save checkpoint (status: WAITING)
    API_A->>PG: Insert wait record (correlationKey: order:order-5001)
    API_A-->>Redis: Publish flow:suspended event
    Redis-->>Monitor: Highlight WAITING node with clock badge
    API_A-->>Customer: 202 Accepted (status: "waiting", stackId)

    Note over API_A, API_B: API A can restart or deploy. Zero CPU held.

    Approver->>API_B: POST /api/webhooks/orders/order-5001/approval
    API_B->>PG: claimWaitRecord(order:order-5001) + Advisory Lock
    API_B->>PG: Restore checkpoint context
    API_B->>API_B: arrangeShipping
    API_B->>PG: Save completed checkpoint & mark wait complete
    API_B-->>Redis: Publish flow:resumed and flow:complete
    Redis-->>Monitor: Transition DAG to COMPLETED
    API_B-->>Approver: 200 OK (status: "confirmed", trackingId)
```

---

## 2. Define the Durable Checkout Workflow

The runnable demo reserves stock and charges the customer, then pauses every order for manager sign-off before shipping. A real checkout could apply an amount or risk rule before choosing an approval workflow.

[checkout-durable.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/durable-distributed-checkout/checkout-durable.ts) uses the existing demo service interfaces:

```typescript
import { Step, flow, waitForEvent } from '@siglo/core';
import { TemporaryPaymentError, type CheckoutServices, type Order } from '../getting-started/checkout';

export class ApprovalRejectedError extends Error {}

export function createDurableCheckout(services: CheckoutServices) {
    const reserveStock = Step.create('reserveStock', async (order: Order) => ({
        reservationId: await services.reserve(order),
    })).compensate(async (output: { reservationId: string }) => services.release(output.reservationId));

    const chargePayment = Step.create('chargePayment', async (order: Order) => ({
        paymentId: await services.charge(order),
    }))
        .onFail({
            maxRetries: 2,
            delay: 10,
            backoff: 'exponential',
            retryIf: error => error instanceof TemporaryPaymentError,
        })
        .compensate(async (output: { paymentId: string }) => services.refund(output.paymentId));

    const awaitApproval = waitForEvent('order.approved', {
        correlationKey: (order: Order) => `order:${order.orderId}`,
        timeout: '24h',
    });

    const arrangeShipping = Step.create(
        'arrangeShipping',
        async (
            order: Order & { reservationId: string; paymentId: string; approved?: boolean; approverId?: string },
        ) => {
            if (order.approved !== true) {
                // Continuations do not reconstruct compensation handlers from earlier
                // processes. Reconcile the persisted provider IDs explicitly here.
                await services.refund(order.paymentId);
                await services.release(order.reservationId);
                throw new ApprovalRejectedError('Order rejected by reviewer');
            }
            return {
                status: 'confirmed',
                trackingId: await services.ship(order),
                approvedBy: order.approverId,
            };
        },
    );

    return flow(reserveStock, chargePayment, awaitApproval, arrangeShipping).version('1.0.0');
}
```

> [!NOTE]
> `waitForEvent` accepts a string or a correlation key extractor `(context) => string`. Always correlate waits on immutable business identifiers (such as `order:${order.orderId}` or `payment:${paymentIntentId}`) rather than random request tokens to ensure idempotency.

---

## 3. Wire PostgreSQL Wait Records in Storage

In [Distributed Checkout with PostgreSQL and Redis](/distributed-rest-and-live-monitoring#3-connect-both-adapters), our storage adapter only forwarded checkpoints and cache operations.

For durable workflows, the storage adapter must expose wait record persistence and distributed locking. [infrastructure.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/durable-distributed-checkout/infrastructure.ts) serializes checkpoint and wait writes and exposes `flush()`. The submission wrapper drains these writes before acknowledging `202`; the resume path drains them while holding the workflow lock. Compose runs schema initialization once before starting the API replicas and monitor:

```typescript
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Step, StorageAdapter, defaultStorageManager } from '@siglo/core';
import { PostgresStorageAdapter, PostgresIdempotencyStore } from '@siglo/postgres';
import { RedisStorageAdapter, RedisClientInterface } from '@siglo/redis';

export const namespace = 'durable-checkout';
export const channel = 'tutorial:durable-checkout:events';
export const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6381';

// Adapt ioredis overloads to the adapters' small client interfaces.
export function pubsubClient(redis: Redis) {
    return {
        publish: (topic: string, message: string) => redis.publish(topic, message),
        subscribe: (topic: string) => redis.subscribe(topic),
        on: (event: 'message', listener: (topic: string, message: string) => void) => redis.on(event, listener),
    };
}

export async function connectInfrastructure() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL || 'postgres://siglo:siglo@127.0.0.1:5434/checkout',
        connectionTimeoutMillis: 5000,
    });
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    redis.on('error', error => console.error('Redis:', error.message));
    const postgres = new PostgresStorageAdapter({ client: pool, recordContextChanges: false });
    const idempotency = new PostgresIdempotencyStore({ client: pool });
    const cacheClient: RedisClientInterface = {
        get: key => redis.get(key),
        set: (key, value, ...args) => redis.set(key, value, 'PX', Number(args[1])),
        del: key => redis.del(...(Array.isArray(key) ? key : [key])),
        hset: (key, field, value) =>
            typeof field === 'string' ? redis.hset(key, field, value!) : redis.hset(key, field),
    };
    const cache = new RedisStorageAdapter({ client: cacheClient, keyPrefix: 'tutorial:', recordContextChanges: false });

    // The engine may dispatch checkpoint writes without awaiting them. Serialize
    // those writes and drain them before acknowledging a successful HTTP request.
    // A failed write poisons this chain: restart the process after fixing storage.
    let writes: Promise<void> = Promise.resolve();
    const storage: StorageAdapter = {
        name: 'durable-checkout-postgres-with-redis-cache',
        saveCheckpoint(checkpoint) {
            writes = writes.then(() => postgres.saveCheckpoint(checkpoint));
            return writes;
        },
        getCheckpoint: id => postgres.getCheckpoint(id),
        saveWaitRecord(record) {
            writes = writes.then(() => postgres.saveWaitRecord(record));
            return writes;
        },
        getWaitRecord: key => postgres.getWaitRecord(key),
        claimWaitRecord: (key, claimant, options) => postgres.claimWaitRecord(key, claimant, options),
        async completeWaitRecord(key, claimant) {
            await writes;
            await postgres.completeWaitRecord(key, claimant);
        },
        async withWorkflowLock(stackId, action) {
            await writes;
            return postgres.withWorkflowLock(stackId, async () => {
                // Recreate the engine's local stack on a fresh replica so its
                // terminal checkpoint can be saved after the continuation runs.
                if (!defaultStorageManager.getStack(stackId)) {
                    const checkpoint = await postgres.getCheckpoint(stackId);
                    if (checkpoint)
                        defaultStorageManager.restoreCheckpoint(checkpoint, { expectedNamespace: namespace });
                }
                try {
                    return await action();
                } finally {
                    await writes;
                }
            });
        },
        getCachedStep: key => cache.getCachedStep(key),
        setCachedStep: (key, value, ttl) => cache.setCachedStep(key, value, ttl),
    };
    try {
        await redis.connect();
        // Initialize once before replicas start (Compose's init service).
        // Host mode may initialize here when only one process starts at a time.
        await pool.query('SELECT 1');
        Step.useStorage(storage);
        return {
            pool,
            redis,
            postgres,
            idempotency,
            flush: () => writes,
            async close() {
                await writes.catch(console.error);
                redis.disconnect();
                await pool.end();
            },
        };
    } catch (error) {
        redis.disconnect();
        await pool.end();
        throw error;
    }
}

if (require.main === module) {
    connectInfrastructure()
        .then(async infra => {
            try {
                await infra.postgres.ensureTables();
                await infra.idempotency.ensureTable();
            } finally {
                await infra.close();
            }
        })
        .catch(error => {
            console.error(error);
            process.exitCode = 1;
        });
}
```

### PostgreSQL Wait Records Schema

The `PostgresStorageAdapter` automatically manages the `siglo_wait_records` table:

| Column                    | Type                       | Purpose                                                                 |
| ------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `correlation_key`         | `VARCHAR(255) PRIMARY KEY` | Business lookup key (e.g. `order:order-5001`)                           |
| `stack_id`                | `VARCHAR(255) NOT NULL`    | Execution UUID of the waiting workflow                                  |
| `status`                  | `VARCHAR(50) NOT NULL`     | State of wait: `'WAITING'`, `'RESUMING'`, `'RESUMED'`, or `'CANCELLED'` |
| `continuation_step_index` | `INT NOT NULL`             | Index of the step to run upon resumption                                |
| `expires_at`              | `TIMESTAMPTZ`              | Expiry deadline calculated from declared timeout                        |
| `resume_payload`          | `JSONB`                    | Saved payload supplied during resumption                                |
| `locked_by`               | `TEXT`                     | Replica identifier holding the active resume lock                       |

---

## 4. Implement the API and Webhook Endpoints

[api-durable.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/durable-distributed-checkout/api-durable.ts) provides submission and approval endpoints, plus health and checkpoint status routes:

1. `POST /api/checkouts`: uses `@siglo/express` with `{ durable: true }` and returns `202 Accepted` when suspended or `200 OK` when completed.
2. `POST /api/webhooks/orders/:orderId/approval`: accepts approval webhooks and calls `resumeWorkflow`.

The submission adapter starts the workflow, unwraps its result, and automatically returns `202` for a waiting result or `200` on completion. No custom `output` callback is needed. The approval webhook calls `resumeWorkflow` directly because it continues an existing execution rather than starting a new one.

```typescript
import express from 'express';
import { once } from 'node:events';
import {
    DuplicateEventException,
    ExpiredWaitException,
    WorkflowEventEmitter,
    WorkflowAlreadyResumedException,
    resumeWorkflow,
} from '@siglo/core';
import { sigloExpressMiddleware } from '@siglo/express';
import { RedisMonitoringAdapter } from '@siglo/monitor';
import { createDemoServices } from '../getting-started/checkout-demo';
import type { Order } from '../getting-started/checkout';
import { ApprovalRejectedError, createDurableCheckout } from './checkout-durable';
import { channel, connectInfrastructure, namespace, pubsubClient } from './infrastructure';

function isOrder(value: unknown): value is Order {
    if (!value || typeof value !== 'object') return false;
    const order = value as Partial<Order>;
    return (
        typeof order.orderId === 'string' &&
        /^[a-zA-Z0-9_-]{1,80}$/.test(order.orderId) &&
        typeof order.sku === 'string' &&
        order.sku.length > 0 &&
        order.sku.length <= 80 &&
        Number.isSafeInteger(order.quantity) &&
        order.quantity! > 0 &&
        Number.isSafeInteger(order.amountCents) &&
        order.amountCents! > 0
    );
}

export async function startApi(port = Number(process.env.PORT || 3100)) {
    const infra = await connectInfrastructure();
    const instance = process.env.INSTANCE_ID || `api-${port}`;
    const emitter = new WorkflowEventEmitter();
    new RedisMonitoringAdapter({ publisher: pubsubClient(infra.redis), channel }).attachToEmitter(emitter);
    const { services } = createDemoServices();
    const checkout = createDurableCheckout(services).monitor(emitter);
    // The engine dispatches some writes asynchronously. Drain them before the
    // adapter sends its built-in 202 response; no custom output callback is used.
    const run = checkout.run;
    checkout.run = async (...args) => {
        try {
            return await run(...args);
        } finally {
            await infra.flush();
        }
    };
    const app = express();
    app.use(express.json({ limit: '16kb' }));
    app.use((_req, res, next) => {
        res.setHeader('X-Instance-Id', instance);
        next();
    });
    app.get('/health', (_req, res) => {
        res.json({ instance });
    });

    app.post(
        '/api/checkouts',
        async (req, res, next) => {
            if (!isOrder(req.body)) {
                res.status(400).json({ error: 'Provide orderId, sku, positive integer quantity and amountCents' });
                return;
            }
            try {
                // A submission is accepted once per order ID within this demo window.
                const claim = await infra.idempotency.claim(`${namespace}:${req.body.orderId}`, 86_400_000);
                if (claim !== 'claimed') {
                    res.status(409).json({ error: 'Order ID already submitted; use the approval webhook to resume' });
                    return;
                }
                next();
            } catch (error) {
                next(error);
            }
        },
        sigloExpressMiddleware(checkout, {
            durable: true,
            namespace,
            // Only domain fields enter the workflow; HTTP flags are not persisted.
            input: req => {
                const { orderId, sku, quantity, amountCents } = req.body;
                return { orderId, sku, quantity, amountCents };
            },
        }),
    );

    app.get('/api/checkouts/:stackId', async (req, res, next) => {
        try {
            const checkpoint = await infra.postgres.getCheckpoint(req.params.stackId);
            if (!checkpoint || checkpoint.namespace !== namespace) {
                res.status(404).json({ error: 'Checkout not found' });
                return;
            }
            res.json({ stackId: checkpoint.stackId, status: checkpoint.status });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/webhooks/orders/:orderId/approval', async (req, res, next) => {
        const { orderId } = req.params;
        const { approved, approverId } = req.body || {};
        if (
            !/^[a-zA-Z0-9_-]{1,80}$/.test(orderId) ||
            typeof approved !== 'boolean' ||
            typeof approverId !== 'string' ||
            !approverId.trim() ||
            approverId.length > 200
        ) {
            res.status(400).json({ error: 'Provide boolean approved and a nonempty approverId' });
            return;
        }
        const correlationKey = `order:${orderId}`;
        try {
            const finalResult = await resumeWorkflow(
                checkout,
                correlationKey,
                { approved, approverId },
                { durable: true, pojo: true },
            );
            await infra.flush();
            res.json({ success: true, orderId, result: finalResult });
        } catch (error) {
            if (error instanceof DuplicateEventException || error instanceof WorkflowAlreadyResumedException) {
                res.status(409).json({ error: 'Workflow is not waiting or has already been resumed', correlationKey });
            } else if (error instanceof ExpiredWaitException) {
                res.status(410).json({ error: 'Approval window expired', correlationKey });
            } else if (
                error instanceof ApprovalRejectedError ||
                (error as any)?.cause instanceof ApprovalRejectedError
            ) {
                res.status(422).json({ error: 'Order rejected; payment refunded and stock released', correlationKey });
            } else {
                next(error);
            }
        }
    });

    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        console.error(error);
        res.status(503).json({ error: 'Checkout infrastructure unavailable' });
    });
    const server = app.listen(port, '0.0.0.0');
    try {
        await once(server, 'listening');
    } catch (error) {
        await infra.close();
        throw error;
    }
    console.log(`${instance}: durable checkout listening on ${port}`);
    return {
        server,
        async close() {
            await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
            await infra.close();
        },
    };
}

if (require.main === module) {
    startApi()
        .then(({ close }) => {
            process.once('SIGINT', () => {
                void close();
            });
            process.once('SIGTERM', () => {
                void close();
            });
        })
        .catch(error => {
            console.error(error);
            process.exitCode = 1;
        });
}
```

---

## 5. Walkthrough: Suspend on A, Resume on B

Let's test durable suspension across server restarts and replicas.

### Step 1: Submit an Order to API A

Send a checkout request to API A on port **3100**:

```bash
curl -i http://127.0.0.1:3100/api/checkouts \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"order-5001","sku":"espresso-machine","quantity":1,"amountCents":120000}'
```

API A returns `202 Accepted`:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json; charset=utf-8

{
  "status": "waiting",
  "stackId": "b18f8e02-8610-48e0-bb43-41a46b9a89c1",
  "stepId": "<awaitApproval step ID>",
  "correlationKey": "order:order-5001",
  "eventName": "order.approved",
  "expiresAt": 1794050400000,
  "continuationStepIndex": 3
}
```

At this moment:

- Inventory has been reserved.
- Payment has been authorized.
- The workflow has suspended at `awaitApproval`.
- No HTTP request or in-process timer needs to remain open for this order; the durable state is in PostgreSQL.

The live monitor makes that pause visible: `reserveStock` and `chargePayment` are complete, the approval wait is amber, and `arrangeShipping` has not run. Selecting the wait opens its **waiting** state and UTC deadline in the right-hand details panel.

These screenshots were captured from separate local API and monitor processes using this example's real PostgreSQL and Redis services. Execution IDs, deadlines, and timings will differ in your run.

![Durable checkout live monitor showing the suspended approval wait in amber, completed reservation and payment steps, unexecuted shipping, and the wait state and UTC deadline in the right-hand panel](assets/durable-distributed-checkout/waiting-for-approval.png)

### Step 2: Inspect PostgreSQL State

Verify the wait record directly in PostgreSQL:

```bash
docker compose -f examples/durable-distributed-checkout/docker-compose.yml exec postgres \
  psql -U siglo -d checkout \
  -c "SELECT correlation_key, status, continuation_step_index, expires_at FROM siglo_wait_records;"
```

Output:

```
  correlation_key   | status  | continuation_step_index |          expires_at
--------------------+---------+-------------------------+-------------------------------
 order:order-5001   | WAITING |                       3 | 2026-11-07 14:00:00.000000+00
```

### Step 3: Simulate Process Crash & Restart

Restart API A to demonstrate complete crash survival:

```bash
docker compose -f examples/durable-distributed-checkout/docker-compose.yml restart api-a
```

Even if the originating process dies or rolls out a new deployment, the state snapshot is safe in PostgreSQL.

### Step 4: Resume on API B

Deliver the approval webhook to **API B** on port **3101**:

```bash
curl -i http://127.0.0.1:3101/api/webhooks/orders/order-5001/approval \
  -H 'Content-Type: application/json' \
  -d '{"approved":true,"approverId":"risk-manager@shop.com"}'
```

API B claims the wait record, restores the context snapshot, runs `arrangeShipping`, and returns `200 OK`:

```json
{
    "success": true,
    "orderId": "order-5001",
    "result": {
        "status": "confirmed",
        "trackingId": "tracking-order-5001",
        "approvedBy": "risk-manager@shop.com",
        "reservationId": "reservation-order-5001",
        "paymentId": "payment-order-5001"
    }
}
```

Check the wait records table again:

```bash
docker compose -f examples/durable-distributed-checkout/docker-compose.yml exec postgres \
  psql -U siglo -d checkout \
  -c "SELECT correlation_key, status, resumed_by FROM siglo_wait_records;"
```

The wait record now has `status: RESUMED` with the claimant ID recorded. The checkpoint has `status: completed`.

The same execution now displays **COMPLETED** in the shared monitor. In this capture, both API processes were restarted before API B received approval. The latency view retains the earlier reservation and payment steps, marks the wait complete, and shows the subsequent `arrangeShipping` execution under the original stack ID. Its step timings do not represent the time spent awaiting human approval.

![Shared durable checkout monitor showing the original execution completed after approval on API B, with reservation, payment, approval wait, and shipping all completed in the latency waterfall](assets/durable-distributed-checkout/resumed-on-api-b.png)

### Step 5: Test Duplicate Delivery Protection

Send the exact same approval webhook again to API B:

```bash
curl -i http://127.0.0.1:3101/api/webhooks/orders/order-5001/approval \
  -H 'Content-Type: application/json' \
  -d '{"approved":true,"approverId":"risk-manager@shop.com"}'
```

The server rejects the duplicate resumption with `409 Conflict`:

```http
HTTP/1.1 409 Conflict
Content-Type: application/json; charset=utf-8

{
  "error": "Workflow is not waiting or has already been resumed",
  "correlationKey": "order:order-5001"
}
```

> [!IMPORTANT]
> Siglo uses PostgreSQL advisory locks and atomic conditional updates (`WHERE status = 'WAITING'`) inside `claimWaitRecord`. If two identical webhooks arrive concurrently at API A and API B, exactly one replica acquires the claim; the other is rejected with `DuplicateEventException`, preventing duplicate shipping dispatches.

---

## 6. Live Monitoring and Interactive Resumption

As in [Serve a REST Endpoint and Watch It Run Live](/rest-and-live-monitoring), a separate dashboard observes checkout execution. This example uses port **4100** to avoid the previous tutorial's monitor port.

The monitor registers the checkout workflow and connects to the same PostgreSQL storage as both API replicas. Unlike the previous tutorial's observation-only monitor, this local dashboard enables **interactive resumption**:

1. Open **http://127.0.0.1:4100** in your browser.
2. Select the execution by its `stackId`.
3. The DAG highlights `reserveStock` and `chargePayment` in green (`COMPLETED`).
4. The run displays an amber **SUSPENDED** badge and the waiting event name `order.approved`.
5. Click **Resume** and use the waiting run's stack ID as the key.
6. Enter the JSON event payload:
    ```json
    {
        "approved": true,
        "approverId": "dashboard-operator@shop.com"
    }
    ```
7. Click **Dispatch Signal**. The dashboard dispatches `POST /api/workflows/:stackId/resume`, and the live DAG immediately transitions: `arrangeShipping` executes on screen and the workflow completes.

### Approve Directly from the Dashboard

Use a fresh submitted order to try this route after the webhook walkthrough. The Resume dialog pre-fills the selected stack ID and `order.approved` signal. Replace the default JSON with the approval payload above before dispatching it.

![Live monitor Resume Suspended Flow dialog with a waiting stack ID, the order.approved event signal, an approved true JSON payload, and the Dispatch Signal button](assets/durable-distributed-checkout/dashboard-resume-dialog.png)

After dispatch, open **Live Events**, filter to `step:complete`, and expand `arrangeShipping`. The captured completion event contains `status: "confirmed"`, the tracking ID, and `approvedBy: "dashboard-operator@shop.com"`. The run is **COMPLETED**, and the original webhook-resumed checkout remains visible alongside it.

![Durable checkout live monitor showing a completed dashboard-resumed execution and its expanded arrangeShipping completion event with confirmed status, tracking ID, and dashboard operator approval](assets/durable-distributed-checkout/dashboard-approved-event.png)

---

## 7. Rejections, Timeouts, and Saga Rollbacks

What happens if the reviewer rejects the order, or the 24-hour approval window expires?

### Scenario A: Order Rejected by Reviewer

First submit another order with `orderId: "order-5002"` using the checkout endpoint. Then send an approval payload with `approved: false`:

```bash
curl -i http://127.0.0.1:3101/api/webhooks/orders/order-5002/approval \
  -H 'Content-Type: application/json' \
  -d '{"approved":false,"approverId":"fraud-detection@shop.com"}'
```

1. The workflow resumes at `arrangeShipping`.
2. `arrangeShipping` sees `order.approved !== true` and explicitly refunds and releases the persisted provider IDs before throwing `ApprovalRejectedError`.
3. This cleanup runs in reverse business-operation order:
    - `refund(paymentId)` is called.
    - `release(reservationId)` is called.
4. The fake services have refunded the payment and released stock. The API returns `422` for rejection. Because a fresh process does not reconstruct earlier compensation handlers, the example performs this post-resume cleanup explicitly. Production provider operations must be idempotent for recovery attempts.

The monitor distinguishes delivery of the reviewer's decision from business approval: the wait completes because a signal arrived, but `arrangeShipping` fails because that signal rejected the order. The run turns red while earlier completed operations remain visible. Refund and stock release are explicit service calls inside the continuation, not separate nodes in this view.

![Durable checkout monitor showing a reviewer-rejected execution marked failed, a completed approval wait, and a failed arrangeShipping row beside the earlier successful executions](assets/durable-distributed-checkout/reviewer-rejected.png)

### Scenario B: SLA Expiration

If no approval webhook is received before `timeout: '24h'` elapses:

1. Any late resume attempt triggers `ExpiredWaitException`.
2. The runnable example returns `410 Gone` for a late approval.
3. The demo does not run an expiration sweeper. Production systems need a scheduled reconciliation job to expire abandoned orders and refund or release their persisted provider IDs; declaring a timeout alone does not perform that cleanup.

---

## 8. Workflow Versioning and In-Flight Migrations

Long-running workflows that wait days or weeks for external signals often outlive software deployments. What happens if your team refactors the checkout workflow while 200 orders are suspended in PostgreSQL?

Siglo provides declarative version migrations via `.version()` and `migrations`:

```typescript
import { Step, flow, waitForEvent, resumeWorkflow } from '@siglo/core';

// Version 1.0.0 (original workflow)
export const checkoutV1 = flow(
    reserveStock,
    chargePayment,
    waitForEvent('order.approved', { correlationKey: o => `order:${o.orderId}` }),
    arrangeShipping,
).version('1.0.0');

// Version 2.0.0 (new workflow with risk assessment step)
export const checkoutV2 = flow(
    reserveStock,
    chargePayment,
    waitForEvent('order.approved', { correlationKey: o => `order:${o.orderId}` }),
    enrichCustomerProfile, // Newly added step
    arrangeShipping,
).version('2.0.0');

// Resuming an execution created under v1.0.0 with v2.0.0 logic:
app.post('/api/webhooks/orders/:orderId/approval', async (req, res) => {
    const finalResult = await resumeWorkflow(checkoutV2, `order:${req.params.orderId}`, req.body, {
        targetVersion: '2.0.0',
        migrations: {
            '1.0.0->2.0.0': (fromVersion, toVersion, oldState) => ({
                ...oldState,
                schemaVersion: 2,
                customerTier: oldState.customerTier || 'STANDARD',
            }),
        },
    });

    res.json(finalResult);
});
```

---

## 9. Deterministic Testing with `@siglo/testing`

Durable workflows should be tested deterministically without waiting 24 hours or starting real database containers.

Use `@siglo/testing` with `createWorkflowHarness` to test approval without waiting for the timeout:

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resumeWorkflow, DuplicateEventException } from '@siglo/core';
import { createWorkflowHarness } from '@siglo/testing';
import { createDurableCheckout } from './checkout-durable';
import { createDemoServices, sampleOrder } from '../getting-started/checkout-demo';

test('durable checkout suspends, waits for approval, and finishes shipping', async () => {
    const { services, events } = createDemoServices();
    const workflow = createDurableCheckout(services);
    const harness = createWorkflowHarness(workflow);

    // 1. Initial run suspends at waitForEvent
    const suspended = await harness.run(sampleOrder, { durable: true, pojo: true });

    assert.equal(suspended.status, 'waiting');
    assert.equal(suspended.correlationKey, `order:${sampleOrder.orderId}`);
    assert.deepEqual(events, ['reserve stock', 'charge attempt 1', 'charge attempt 2']);

    // 2. Resume with approval payload
    const finalResult = await resumeWorkflow(
        workflow,
        `order:${sampleOrder.orderId}`,
        { approved: true, approverId: 'test-qa@shop.com' },
        { pojo: true },
    );

    assert.equal(finalResult.status, 'confirmed');
    assert.equal(finalResult.approvedBy, 'test-qa@shop.com');
    assert.ok(events.includes('arrange shipping'));
});

test('duplicate resumption throws DuplicateEventException', async () => {
    const { services } = createDemoServices();
    const workflow = createDurableCheckout(services);
    const harness = createWorkflowHarness(workflow);

    await harness.run(sampleOrder, { durable: true, pojo: true });

    // First resume succeeds
    await resumeWorkflow(workflow, `order:${sampleOrder.orderId}`, { approved: true });

    // Second resume fails immediately
    await assert.rejects(
        resumeWorkflow(workflow, `order:${sampleOrder.orderId}`, { approved: true }),
        DuplicateEventException,
    );
});
```

---

## 10. Operational Best Practices

When operating durable workflows in production:

1. **Correlation Key Uniqueness & Scoping**: Prefix correlation keys with domain namespaces (e.g., `checkout:v1:${orderId}`). Never correlate on mutable user attributes.
2. **PostgreSQL Connection Sizing**: Each `resumeWorkflow` invocation briefly uses a PostgreSQL connection for advisory locking and OCC verification. Maintain a dedicated pool for durable state distinct from transactional business logic.
3. **Sweeping Expired Waits**: `waitForEvent({ timeout })` sets `expires_at` in the database. Schedule a periodic job (`SELECT * FROM siglo_wait_records WHERE status = 'WAITING' AND expires_at < NOW()`) via `@siglo/scheduler` or cron to reconcile abandoned orders.
4. **Interactive Dashboard Security**: Remote resumption via the DevTools UI (`allowRemoteResume`) is intended for local staging and debug environments. Restrict access using `auth.adminKey` and network policies in production.

---

## Summary & Next Steps

| Topic                                                    | Document                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| Continue with Kafka integration and conditional routing  | [Kafka Order Routing with `branch` and `when`](/kafka-order-routing) |
| Core durable concepts and wait combinators               | [06. Durable Workflows](/06-durable-workflows)                       |
| PostgreSQL checkpoint and wait table contracts           | [Storage and Persistence Contract](/storage-contract)                |
| Distributed storage adapters and multi-tenant namespaces | [Storage and Adapters](/07-storage-and-adapters)                     |
| Production runbooks and background daemons               | [Production Best Practices](/production-best-practices)              |
| Interactive DevTools and SSE telemetry                   | [Live Monitoring](/live-monitoring)                                  |
| Reverse-order rollbacks and saga recovery                | [Compensation and Sagas](/compensation-and-sagas)                    |
