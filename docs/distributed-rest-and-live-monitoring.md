---
title: 'Run Checkout Across Two Servers with PostgreSQL and Redis'
description: 'Scale a Siglo checkout workflow across multiple API servers using PostgreSQL idempotency and Redis pub/sub live monitoring.'
---

In [Serve a REST Endpoint and Watch It Run Live](/rest-and-live-monitoring), the API and dashboard shared one process. Now imagine running a second API instance: a request can arrive at either server, and an in-memory duplicate-request guard cannot see what the other server is doing.

This continuation runs two checkout APIs, a separate monitoring process, PostgreSQL, and Redis. We reuse the previous tutorial's checkout steps and fake services, including payment retry and shipping compensation. You can send an order to one API, replay it through the other, and inspect both servers in one dashboard.

The [complete runnable example](https://github.com/jsoftgem/siglo/tree/main/examples/src/distributed-checkout) includes a [Dockerfile and Compose file](https://github.com/jsoftgem/siglo/tree/main/examples/distributed-checkout). Run the commands below from the **repository root**.

## Prerequisites

Before starting, have the following ready:

- A checkout of this repository, including `package-lock.json`, `packages`, and `examples`. The Docker build uses the repository as its build context.
- Familiarity with [Serve a REST Endpoint and Watch It Run Live](/rest-and-live-monitoring). Its checkout implementation and fake services are already included in the repository; you can run this example without creating those files yourself.
- Docker with its daemon running and Docker Compose v2 supporting `up --wait`. Docker Desktop or a Docker Engine installation with the Compose plugin works.
- Internet access for the first build to download container images and npm dependencies.
- `curl`, a browser for the dashboard, and a Bash-compatible shell such as Bash or Zsh for the command examples. Windows users can run them in WSL.
- Available local ports **3000**, **3001**, **4000**, **5433**, and **6380**. Stop the previous tutorial's API and monitor before starting, or use the alternative HTTP ports described in section 2.

Check Docker and Compose before launching the stack:

```bash
docker info
docker compose version
docker compose up --help
```

`docker info` should connect to the daemon, and the Compose help should list `--wait`.

For the Docker-only route, Node.js, npm, PostgreSQL, and Redis run inside containers; no host installation is required. For the [optional host workflow](#7-run-node-processes-on-the-host-optional), also install **Node.js 24** with npm and verify them with `node --version` and `npm --version`. That route still uses Docker for PostgreSQL and Redis.

## 1. Split the Responsibilities

```mermaid
flowchart LR
    Client["curl"] --> A["Checkout API A :3000"]
    Client --> B["Checkout API B :3001"]
    A --> PG["PostgreSQL: checkpoints and idempotency"]
    B --> PG
    A --> Redis["Redis: catalog cache and live events"]
    B --> Redis
    Redis -.-> Monitor["Monitor process :4000"]
    Monitor --> Browser["Dashboard / SSE / metrics"]
```

Each API executes the whole checkout and waits before responding. The two processes share state through adapters; this example does not enqueue jobs or move individual steps between servers.

| Responsibility                                            | Implementation                                    |
| --------------------------------------------------------- | ------------------------------------------------- |
| Execution checkpoints and context audit                   | `PostgresStorageAdapter` from `@siglo/postgres`   |
| Cross-instance duplicate-request claim and saved response | `PostgresIdempotencyStore` from `@siglo/postgres` |
| Shared catalog lookup cache                               | `RedisStorageAdapter` from `@siglo/redis`         |
| Events from both APIs to the dashboard                    | `RedisMonitoringAdapter` from `@siglo/monitor`    |

PostgreSQL owns execution persistence. Redis holds disposable lookup data and transports telemetry. Registering two storage adapters with `Step.useStorage` would replace the first one, so we compose their methods explicitly.

## 2. Start the Local System

```bash
docker compose -f examples/distributed-checkout/docker-compose.yml up --build -d --wait
```

The first build installs the repository's locked dependencies and compiles the four packages used by the example. A one-shot `init-db` service creates the PostgreSQL tables before either API starts; this avoids concurrent schema initialization. The monitor subscribes before the APIs become available.

| Service    | Local address                                    |
| ---------- | ------------------------------------------------ |
| API A      | `http://127.0.0.1:3000`                          |
| API B      | `http://127.0.0.1:3001`                          |
| Dashboard  | `http://127.0.0.1:4000`                          |
| PostgreSQL | `postgres://siglo:siglo@127.0.0.1:5433/checkout` |
| Redis      | `redis://127.0.0.1:6380`                         |

These ports avoid the default database ports used by other repository examples. Stop the previous tutorial's API and monitor first if they still occupy ports 3000 or 4000. Alternatively, prefix the startup command with `API_A_PORT=3100 API_B_PORT=3101 MONITOR_HOST_PORT=4100` and adjust curl/browser URLs accordingly. The database credentials are local demo values, and all published ports bind to loopback.

Check startup and open the dashboard:

```bash
docker compose -f examples/distributed-checkout/docker-compose.yml ps
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3001/health
```

The responses identify `api-a` and `api-b`. API responses also include `X-Instance-Id`, so you can see which process handled each request.

## 3. Connect Both Adapters

See [`infrastructure.ts`](https://github.com/jsoftgem/siglo/tree/main/examples/src/distributed-checkout/infrastructure.ts) for client setup and cleanup. Its storage adapter delegates checkpoints and context changes to PostgreSQL and cache operations to Redis:

```typescript
const storage: StorageAdapter = {
    name: 'checkout-postgres-with-redis-cache',
    saveCheckpoint(checkpoint) {
        writes = writes.then(() => postgres.saveCheckpoint(checkpoint));
        return writes;
    },
    getCheckpoint: id => postgres.getCheckpoint(id),
    onContextChange: entry => postgres.onContextChange(entry),
    getCachedStep: key => cache.getCachedStep(key),
    setCachedStep: (key, value, ttl) => cache.setCachedStep(key, value, ttl),
};
Step.useStorage(storage);
```

`writes` starts as `Promise.resolve()`. The engine can dispatch checkpoint writes asynchronously, so this example serializes them and waits for the chain before acknowledging a successful checkout. If a checkpoint write fails, the chain remains rejected and subsequent successful workflows return an infrastructure error; fix storage and restart the API. Context auditing is best effort in the PostgreSQL adapter.

The example wraps the small Redis client interfaces to accommodate ioredis overloads. Only the Redis cache methods are used; workflow checkpoints never go to Redis. This composition intentionally does not expose durable-wait methods. For event-driven suspension and resumption, use the full PostgreSQL adapter and the [durable waits guide](/durable-waits).

Before the existing checkout steps, [`api.ts`](https://github.com/jsoftgem/siglo/tree/main/examples/src/distributed-checkout/api.ts) adds a read-only catalog lookup:

```typescript
const loadCatalog = Step.create('loadCatalog', async (order: Order) => {
    console.log(`${instance}: catalog lookup for ${order.sku}`);
    await delay(750);
    return { catalogLabel: `Demo product: ${order.sku}` };
}).cache({
    ttl: 300_000,
    keySerializer: (_stepId, order: Order, ns) => `${ns}:catalog:v1:${order.sku}`,
});

const checkout = flow(loadCatalog, ...createCheckout(services).steps).monitor(emitter);
```

The 750 ms pause makes concurrent requests observable. The key includes namespace, lookup version, and SKU; it excludes order-specific fields because the returned label depends only on SKU. The five-minute cache never covers payment, reservation, or shipment operations. Concurrent cache misses may compute the same lookup on different processes; caching is not a distributed lock.

## 4. Create on A, Replay on B

```bash
curl -i http://127.0.0.1:3000/api/checkouts \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"distributed-1001","sku":"coffee-kit","quantity":1,"amountCents":4500}'
```

API A returns `201 Created`, `X-Instance-Id: api-a`, and `X-Workflow-Stack-Id`. The body includes:

```json
{
    "orderId": "distributed-1001",
    "status": "confirmed",
    "trackingId": "tracking-distributed-1001",
    "stackId": "<execution UUID>"
}
```

Send the same input to API B:

```bash
curl -i http://127.0.0.1:3001/api/checkouts \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"distributed-1001","sku":"coffee-kit","quantity":1,"amountCents":4500}'
```

This returns `200 OK`, `X-Instance-Id: api-b`, and `X-Idempotent-Replay: true`. The body and workflow stack ID match the first response. No checkout steps run for the replay, so the monitor contains one execution for that order.

### One Execution, Even After Replay Through B

The screenshots in this tutorial were captured using the [optional host workflow](#7-run-node-processes-on-the-host-optional): separate API A, API B, and monitor processes sharing real PostgreSQL and Redis. Your execution IDs and timings will differ.

API A created this checkout, and API B returned its saved response with the same stack ID. The dashboard still contains just one execution. All five steps completed; selecting `chargePayment` shows **2 attempts** beside the graph. The retained gateway error records the first failed attempt, while **COMPLETED** confirms that its retry succeeded.

![Shared live monitor showing one completed five-step checkout after replay through the other API, with chargePayment selected and two attempts in the right-hand details panel](assets/distributed-rest-and-live-monitoring/checkout-and-replay.png)

The route explicitly calls `PostgresIdempotencyStore.claim` using `distributed-checkout:v1:<orderId>`:

- `claimed`: run the workflow, drain checkpoint writes, then save the public response with `complete`.
- `in-progress`: return `409` with `Retry-After: 1`; retry after the first request settles.
- `completed`: compare the input fingerprint and return the saved response. Reusing the order ID with different business fields returns `409`.

The fingerprint also includes the demo shipping-failure flag. Arbitrary request fields are excluded from both workflow input and fingerprint. Validation errors return `400` before claiming or executing anything. This route calls `checkout.run` directly so it can control claims, response replay, and persistence acknowledgment around the workflow.

### Race the Two Replicas

Use a fresh order ID and SKU so the catalog pause is not cached:

```bash
curl -s -w '\nA: %{http_code}\n' http://127.0.0.1:3000/api/checkouts \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"race-1001","sku":"race-coffee-1001","quantity":1,"amountCents":4500}' &
curl -s -w '\nB: %{http_code}\n' http://127.0.0.1:3001/api/checkouts \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"race-1001","sku":"race-coffee-1001","quantity":1,"amountCents":4500}' &
wait
```

One request should return `201`; the overlapping request returns `409`. If your requests arrive far enough apart, the second may instead return the completed replay (`200`). Either API can win. Change the IDs when repeating the experiment.

## 5. Observe Both Servers in One Dashboard

Each API publishes its workflow emitter over Redis:

```typescript
new RedisMonitoringAdapter({
    publisher: pubsubClient(infra.redis),
    channel,
}).attachToEmitter(emitter);
```

The [monitor process](https://github.com/jsoftgem/siglo/tree/main/examples/src/distributed-checkout/monitor.ts) has a dedicated subscriber connection and routes incoming events into `monitor.emitter`. The subscriber does not share a connection with cache commands: Redis subscription mode requires its own connection.

Open **http://127.0.0.1:4000** and select the execution using its stack ID. You will see `loadCatalog` followed by the previous tutorial's checkout steps, including the payment retry. To create a second execution on B, repeat the request with a new order ID and the same `coffee-kit` SKU. Its lookup should reuse Redis's cached label.

```bash
docker compose -f examples/distributed-checkout/docker-compose.yml logs api-a api-b
```

Only the first cold lookup logs `catalog lookup for coffee-kit`. Both workflows still execute reservation, payment, and shipping.

### Compare the Cold Lookup with the Shared Cache Hit

On the first request to API A, the latency waterfall makes the deliberately slow `loadCatalog` step stand out: its cold lookup takes roughly 750 ms. The payment row also shows two attempts.

![Shared monitor latency waterfall for API A's first checkout, showing the roughly 750 ms cold catalog lookup and two payment attempts](assets/distributed-rest-and-live-monitoring/catalog-cold.png)

A new order sent to API B with the same SKU reuses the label from Redis. Its catalog step takes only a few milliseconds in this capture. Both executions appear in the same sidebar, and the new checkout still runs validation, stock reservation, payment, and shipping. The saved response replay from section 4 never created an extra workflow.

![Shared monitor showing two completed executions and API B's latency waterfall, with a fast cached catalog lookup while all remaining checkout steps still execute](assets/distributed-rest-and-live-monitoring/catalog-cached.png)

The HTTP `X-Instance-Id` response header identifies which API handled each request; the monitor identifies executions by stack ID. The timing comparison shows a cache optimization, not a guarantee of identical timings on every machine.

Subscribe before sending another request to see new events from either API:

```bash
curl -N 'http://127.0.0.1:4000/events?namespace=distributed-checkout'
```

The existing dashboard, workflow detail API, and metrics endpoint continue to work:

```bash
curl 'http://127.0.0.1:4000/api/workflows?namespace=distributed-checkout'
curl http://127.0.0.1:4000/metrics
```

Redis Pub/Sub does not retain events. A disconnected monitor misses events; restarting it clears its in-memory history and counters. PostgreSQL checkpoints remain available, but the dashboard does not automatically rebuild its history from them.

## 6. Verify Persistence and Failure Behavior

Replace `STACK_ID` with the first response's execution UUID. Either API can read its persisted status:

```bash
curl http://127.0.0.1:3001/api/checkouts/STACK_ID
```

The response has `status: "completed"`. Restart API A and replay the original order through it:

```bash
docker compose -f examples/distributed-checkout/docker-compose.yml restart api-a
```

After `/health` responds again, the original POST still returns the saved response. PostgreSQL's named volume preserves checkpoints and idempotency records across container restarts and `down`/`up` cycles.

Inspect the tables directly:

```bash
docker compose -f examples/distributed-checkout/docker-compose.yml exec postgres \
  psql -U siglo -d checkout -c "SELECT stack_id, state->>'status' AS status FROM siglo_checkpoints;"
docker compose -f examples/distributed-checkout/docker-compose.yml exec redis \
  redis-cli --scan --pattern 'tutorial:cache:*'
```

Simulate the previous tutorial's shipping failure on B:

```bash
curl -i 'http://127.0.0.1:3001/api/checkouts?failShipping=true' \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"distributed-failed-1001","sku":"coffee-kit","quantity":1,"amountCents":4500}'
```

The response is `500` with a generic error. The central dashboard shows the failed run; B's logs show refund followed by stock release. Because the fake services compensate on failure, this demo releases the failed claim to allow a new attempt. Successful business execution followed by a persistence failure instead returns `503` and retains the claim for reconciliation.

### Inspect a Failure Without Leaving the Shared Monitor

The failed checkout from B appears alongside the successful runs. Selecting the red `arrangeShipping` step opens **No courier available** and its stack trace on the right, while the graph keeps the completed preceding steps visible. Refund and stock release are confirmed in B's service logs; they are not additional step nodes in this graph.

![Shared live monitor showing a failed checkout from API B alongside two successful executions, with arrangeShipping highlighted red and No courier available in its right-hand error details](assets/distributed-rest-and-live-monitoring/shipping-failure.png)

### Run the Smoke Checks

With Compose running, execute the included verification script inside API A:

```bash
docker compose -f examples/distributed-checkout/docker-compose.yml exec \
  -e API_A_URL=http://api-a:3000 \
  -e API_B_URL=http://api-b:3000 \
  -e MONITOR_URL=http://monitor:4000 \
  api-a node --import tsx examples/src/distributed-checkout/smoke.ts
```

It checks invalid input, concurrent duplicate claims, replay across replicas, changed-input rejection, checkpoints through both APIs, Redis cache presence and expiry, shipping failure, and remote monitoring with the payment retry. It uses unique order IDs on each run.

## 7. Run Node Processes on the Host (Optional)

To edit the TypeScript without rebuilding containers, first stop the stack, then start only its databases:

```bash
docker compose -f examples/distributed-checkout/docker-compose.yml down
docker compose -f examples/distributed-checkout/docker-compose.yml up -d --wait postgres redis
npm ci
npm run build --workspace=@siglo/core
npm run build --workspace=@siglo/postgres
npm run build --workspace=@siglo/redis
npm run build --workspace=@siglo/monitor
node --import tsx examples/src/distributed-checkout/infrastructure.ts
```

Start the monitor, then each API in separate terminals from the repository root:

```bash
node --import tsx examples/src/distributed-checkout/monitor.ts
```

```bash
INSTANCE_ID=api-a PORT=3000 node --import tsx examples/src/distributed-checkout/api.ts
```

```bash
INSTANCE_ID=api-b PORT=3001 node --import tsx examples/src/distributed-checkout/api.ts
```

Host defaults use ports 5433 and 6380 for the databases. Run the same smoke checks with:

```bash
node --import tsx examples/src/distributed-checkout/smoke.ts
```

## 8. Understand the Recovery Boundary

This is a local distributed execution demo using fake business services. A PostgreSQL checkpoint does not automatically schedule recovery after a process dies. There is no background worker or recovery loop here; an interrupted claim stays in progress until its 24-hour TTL expires or an operator reconciles it.

The TTL is a deduplication window, not a renewable lease with fencing. A paused process could outlive it, and provider side effects cannot be committed atomically with the saved HTTP response. Before handling real payments, add provider idempotency keys, bounded service calls and cancellation, reconciliation for ambiguous failures, and explicit recovery ownership. Do not infer exactly-once side effects from these claims. See [Idempotency](/idempotency), [Durable Workflows](/06-durable-workflows), and [Compensation and Sagas](/compensation-and-sagas).

For production, replace fake services, remove `failShipping`, derive prices from trusted data, authenticate the API and monitor, and derive namespaces from trusted identity. The status endpoint exposes only stack ID and status; it still needs authorization in a real service. Configure database retention and monitor redaction. Redis cache loss only removes the lookup optimization; PostgreSQL remains the checkpoint and response store. API health endpoints report process readiness, not continuous dependency health.

Stop the local containers with:

```bash
docker compose -f examples/distributed-checkout/docker-compose.yml down
```

To deliberately delete this demo's PostgreSQL history and saved responses, add `--volumes` to that command. Redis data is ephemeral in this setup.

Continue the tutorial with [Suspend Checkout for Approval and Resume Across Servers](/durable-distributed-checkout) to pause checkout at durable event waits, survive process restarts, and resume across replicas with webhooks.
