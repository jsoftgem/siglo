# Durable distributed checkout

Try the [durable checkout tutorial](../../docs/durable-distributed-checkout.md) before editing any code. This example uses fake stock, payment, and shipping services; PostgreSQL checkpoints and wait records; Redis monitoring events; and `@siglo/express` for submission.

You need a repository checkout, a running Docker daemon, and Docker Compose with `up --wait`. From the repository root:

```bash
docker compose -f examples/durable-distributed-checkout/docker-compose.yml up --build -d --wait
```

| Service | Local address |
| :--- | :--- |
| API A | http://127.0.0.1:3100 |
| API B | http://127.0.0.1:3101 |
| Dashboard | http://127.0.0.1:4100 |
| PostgreSQL | postgres://siglo:siglo@127.0.0.1:5434/checkout |
| Redis | redis://127.0.0.1:6381 |

The Compose project, image, database volume, Redis channel, and ports are separate from `examples/distributed-checkout`. Both examples can run at the same time. `DURABLE_API_A_PORT`, `DURABLE_API_B_PORT`, and `DURABLE_MONITOR_PORT` can override the HTTP ports.

Submit an order (every order in this demo needs approval):

```bash
curl -i http://127.0.0.1:3100/api/checkouts \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"try-5001","sku":"espresso-machine","quantity":1,"amountCents":120000}'
```

Expect `202 Accepted` and a JSON waiting descriptor. Open the dashboard to inspect the suspended run. Restart the originating API, then approve on the other replica:

```bash
docker compose -f examples/durable-distributed-checkout/docker-compose.yml restart api-a
curl -i http://127.0.0.1:3101/api/webhooks/orders/try-5001/approval \
  -H 'Content-Type: application/json' \
  -d '{"approved":true,"approverId":"reader@shop.com"}'
```

Expect `200 OK` with `status: "confirmed"` inside `result`. Repeating the approval returns `409 Conflict`. Submission also rejects reused order IDs for 24 hours; choose a new ID to try again. Submit another order to try the dashboard's **Resume** control instead, using `approved: true` and an `approverId` in the payload.

Run the automated checks, including restarting **both** APIs between submission and resumption:

```bash
sh examples/durable-distributed-checkout/smoke.sh
```

The smoke check uses unique order IDs each time. It checks input validation, automatic `202`, persisted state, concurrent approval claims, duplicate protection, completed checkpoints, Redis monitoring, and dashboard resumption.

Start tinkering with [checkout-durable.ts](../src/durable-distributed-checkout/checkout-durable.ts), [api-durable.ts](../src/durable-distributed-checkout/api-durable.ts), [infrastructure.ts](../src/durable-distributed-checkout/infrastructure.ts), and [monitor.ts](../src/durable-distributed-checkout/monitor.ts). Re-run the build command after edits. The submission wrapper drains pending checkpoint and wait writes before the adapter sends its default response. The monitor registers the workflow and connects to the same persistence, so interactive resumption works from a separate process.

Stop only this example, keeping its persisted data:

```bash
docker compose -f examples/durable-distributed-checkout/docker-compose.yml down
```

To also reset this example's database volume, append `--volumes` to that command. This does not remove the previous tutorial's volume.
