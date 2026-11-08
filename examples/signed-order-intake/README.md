# Signed order intake

Follow [the tutorial](../../docs/signed-order-intake.md) for the security profile and walkthrough.
Requires Node 22 (22.13+) or Node 24+, repository dependencies, and Docker Compose with `up --wait`.
From the repository root:

```sh
npm ci
npm run build --workspace=@siglo/core
npm run build --workspace=@siglo/crypto
npm run build --workspace=@siglo/express
npm run build --workspace=@siglo/kafka
npm run build:ui --workspace=@siglo/monitor
npm run build --workspace=@siglo/monitor
node --import tsx examples/src/signed-order-intake/keys.ts
docker compose -f examples/signed-order-intake/docker-compose.yml up -d --wait
node --import tsx examples/src/signed-order-intake/server.ts
```

Open **http://127.0.0.1:4500** for live monitoring. In a second terminal:

```sh
node --import tsx examples/src/signed-order-intake/client.ts gift
sh examples/signed-order-intake/smoke.sh
node --import tsx --test examples/src/signed-order-intake/*.test.ts
npx tsc -p examples/signed-order-intake/tsconfig.json
```

The server prints the routed event ID, actions and result. Client scenarios: `standard`, `gift`,
`review`, `tamper`, `expired`, `replay`. The smoke script checks HTTP acceptance/rejection;
accepted responses await Kafka publication. Inspect server logs for consumer completion.

Own resources: Compose project `siglo-signed-order-intake`, broker `127.0.0.1:39092`,
API `127.0.0.1:3400`, monitor `127.0.0.1:4500`, topic `signed-order-intake.orders`, consumer group
`signed-order-intake.routing-v1`, Compose-scoped Kafka volume, and ignored `.local/` keys.
No source imports or running services from other tutorials are required.
`SIGNED_ORDER_PORT`, `SIGNED_ORDER_MONITOR_PORT`, `SIGNED_ORDER_URL`, `SIGNED_ORDER_BROKER`, and
`SIGNED_ORDER_KAFKA_IMAGE` override only this example's configuration.

Stop the server with Ctrl-C, then:

```sh
docker compose -f examples/signed-order-intake/docker-compose.yml down
```

Broker records survive shutdown; use `down --volumes` to reset this example's broker.
Keys persist separately. Key generation refuses to overwrite them; remove the two demo PEM
files in `.local/` while the server is stopped to generate a new pair. Restarting the server
clears its in-memory nonces. Keep this localhost demo separate from production traffic.

The live monitor runs in the server process and observes intake and nested Kafka routing.
Raw request bodies, headers, signatures, nonces, and key material are redacted. Remote
resumption is disabled. Monitor history is in memory and clears on server restart.
