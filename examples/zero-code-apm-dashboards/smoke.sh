#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
docker compose -f examples/zero-code-apm-dashboards/docker-compose.yml exec -T worker-a \
  node --import tsx examples/zero-code-apm-dashboards/src/order-routing/smoke.ts submit
docker compose -f examples/zero-code-apm-dashboards/docker-compose.yml restart worker-a worker-b
docker compose -f examples/zero-code-apm-dashboards/docker-compose.yml exec -T worker-a \
  node --import tsx examples/zero-code-apm-dashboards/src/order-routing/smoke.ts replay
