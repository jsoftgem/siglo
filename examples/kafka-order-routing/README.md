# Kafka order routing

Follow [Route Kafka Order Events with `branch` and `when`](../../docs/kafka-order-routing.md). Two consumers share `@siglo/postgres` idempotency; Redis carries events to the live monitor. Fulfillment operations are fake.

From a repository checkout, with Docker and Compose supporting `up --wait`:

```bash
docker compose -f examples/kafka-order-routing/docker-compose.yml up --build -d --wait
```

| Service | Local address |
|---|---|
| Worker A / shared results | http://127.0.0.1:3300/results |
| Worker B / shared results | http://127.0.0.1:3301/results |
| Live monitor | http://127.0.0.1:4300 |
| Kafka | 127.0.0.1:29092 |
| PostgreSQL | postgres://siglo:siglo@127.0.0.1:5435/kafka_orders |
| Redis | redis://127.0.0.1:6382 |

Publish an event from worker A's container; either worker can receive it:

```bash
docker compose -f examples/kafka-order-routing/docker-compose.yml exec worker-a \
  node --import tsx examples/src/kafka-order-routing/publish.ts gift
```

Scenarios: `standard`, `gift`, `review`, `cancel`, `unsupported`, `invalid`. The publisher accepts optional event ID and order ID arguments. Repeating the same event ID within one tenant deduplicates across Kafka offsets; different events may share an order ID.

Run routing unit tests on the host after `npm ci` and building `@siglo/core`:

```bash
node --import tsx --test examples/src/kafka-order-routing/workflow.test.ts
```

Run the live smoke test, which verifies all routes, real dead-letter publication, monitoring, and PostgreSQL deduplication after restarting both workers:

```bash
sh examples/kafka-order-routing/smoke.sh
```

The Compose project, image, ports, Kafka topics, Redis channel, and database volumes are isolated from the earlier checkout tutorials. Rebuild after editing source. Stop this stack with:

```bash
docker compose -f examples/kafka-order-routing/docker-compose.yml down
```

Named Kafka and PostgreSQL volumes survive `down`. Add `--volumes` to reset only this example's data. `KAFKA_WORKER_A_PORT`, `KAFKA_WORKER_B_PORT`, and `KAFKA_MONITOR_PORT` override the HTTP host ports; `KAFKA_IMAGE` overrides the broker image. `KAFKA_NODE_IMAGE` can select a compatible Node.js 24 base image from a local cache when Docker Hub is unavailable.

For producer-to-consumer traces and Grafana metrics, continue with [Zero-Code APM Dashboards](../../docs/zero-code-apm-dashboards.md). That tutorial has independent code and infrastructure in [`../zero-code-apm-dashboards`](../zero-code-apm-dashboards), with separate ports and volumes.
