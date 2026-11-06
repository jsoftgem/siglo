#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
docker compose -f examples/durable-distributed-checkout/docker-compose.yml exec -T api-a \
  node --import tsx examples/src/durable-distributed-checkout/smoke.ts submit
docker compose -f examples/durable-distributed-checkout/docker-compose.yml restart api-a api-b
docker compose -f examples/durable-distributed-checkout/docker-compose.yml exec -T api-a \
  node --import tsx examples/src/durable-distributed-checkout/smoke.ts resume
