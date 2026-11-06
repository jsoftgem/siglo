#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
docker compose -f examples/kafka-order-routing/docker-compose.yml exec -T worker-a \
  node --import tsx examples/src/kafka-order-routing/smoke.ts submit
docker compose -f examples/kafka-order-routing/docker-compose.yml restart worker-a worker-b
docker compose -f examples/kafka-order-routing/docker-compose.yml exec -T worker-a \
  node --import tsx examples/src/kafka-order-routing/smoke.ts replay
