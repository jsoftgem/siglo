# Distributed checkout

Continue the REST and live-monitoring walkthrough with two API replicas, PostgreSQL persistence and idempotency, a Redis catalog cache, and a separate Redis-connected monitor.

Check the tutorial's [prerequisites](../../docs/distributed-rest-and-live-monitoring.md#prerequisites): a repository checkout, a running Docker daemon, Docker Compose v2 with `up --wait`, and available local ports. Node.js is only required for the optional host workflow.

Follow [the tutorial](../../docs/distributed-rest-and-live-monitoring.md). From the repository root:

```bash
docker compose -f examples/distributed-checkout/docker-compose.yml up --build -d --wait
```

APIs: http://127.0.0.1:3000 and http://127.0.0.1:3001. Dashboard: http://127.0.0.1:4000.

Run the integration smoke checks:

```bash
docker compose -f examples/distributed-checkout/docker-compose.yml exec \
  -e API_A_URL=http://api-a:3000 -e API_B_URL=http://api-b:3000 \
  -e MONITOR_URL=http://monitor:4000 \
  api-a node --import tsx examples/src/distributed-checkout/smoke.ts
```

Stop with `docker compose -f examples/distributed-checkout/docker-compose.yml down`.
