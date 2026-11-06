# Zero-Code APM Dashboards

An independent tutorial example with a publisher, two Kafka consumers, PostgreSQL deduplication, a Redis-backed Siglo monitor, Jaeger traces, and provisioned Grafana metrics. All application code is in [`src/order-routing`](src/order-routing); it does not import code from another tutorial.

Follow the [illustrated tutorial](../../docs/zero-code-apm-dashboards.md).

From the repository root:

```bash
docker compose -f examples/zero-code-apm-dashboards/docker-compose.yml up --build -d --wait
docker compose -f examples/zero-code-apm-dashboards/docker-compose.yml exec worker-a \
  node --import tsx examples/zero-code-apm-dashboards/src/order-routing/publish.ts gift
```

| Service | Address |
|---|---|
| Grafana overview (`admin` / `admin`) | http://localhost:3000/d/siglo-apm |
| Grafana metrics | http://localhost:3000/d/siglo-live-monitoring |
| Jaeger | http://localhost:16686 |
| Prometheus targets | http://localhost:9090/targets |
| APM live monitor / metrics | http://127.0.0.1:4400 and http://127.0.0.1:4400/metrics |
| Worker A / B | http://127.0.0.1:3400/results and http://127.0.0.1:3401/results |
| Kafka | 127.0.0.1:39092 |
| PostgreSQL | postgres://siglo:siglo@127.0.0.1:5436/apm_orders |
| Redis | redis://127.0.0.1:6383 |

The `siglo-zero-code-apm-dashboards` project has its own image, network, Kafka and PostgreSQL volumes, `apm_orders` database, `apm.orders` topics, `apm-order-routing-v1` consumer group, `apm-demo` tenant, and Redis channel. The original Kafka routing tutorial can run concurrently on its original ports.

Scenarios: `standard`, `gift`, `review`, `cancel`, `unsupported`, and `invalid`. The publisher accepts optional event ID and order ID arguments. Reusing a completed event ID demonstrates deduplication across offsets and replicas.

With repository dependencies installed and the required Siglo packages built:

```bash
npm run build --workspace=siglo-apm-monitoring
npm run test:apm
```

Verify real Kafka processing and replay after restarting both APM workers:

```bash
sh examples/zero-code-apm-dashboards/smoke.sh
```

Stop only this tutorial:

```bash
docker compose -f examples/zero-code-apm-dashboards/docker-compose.yml down
```

Its named volumes survive `down`. Add `--volumes` only to reset this tutorial’s data. `APM_WORKER_A_PORT`, `APM_WORKER_B_PORT`, and `APM_MONITOR_PORT` override the HTTP host ports; `APM_KAFKA_IMAGE` and `APM_NODE_IMAGE` override the broker and Node base images.

The earlier standalone span demos remain under `src/scenarios`, with `demo:*` scripts and regression tests. They are separate from the tutorial’s `src/order-routing` application and are not linked from the dashboards.
