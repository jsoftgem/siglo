---
title: 'Automated Exploratory Testing Plan'
description: 'Seeded exploratory charters, live persistent recovery, failure artifacts, and reproducible investigation across Siglo.'
---

## Current implementation

The exploratory suite contains **15 registered charters** in `test/exploratory/registry.ts`. PR CI runs 14 service-free charters plus invariant and runner regression tests. The persistent-recovery charter requires explicit integration mode and live Postgres and Redis connections. Nightly CI enables all 15.

The suite supplements deterministic package, IDE, example, and live Kafka integration tests. Core statement coverage and mutation scores do not establish that every charter detects meaningful failures; dedicated regression tests also verify wrong message identities, concurrency violations, and runner failures are rejected.

## Coverage matrix

| Charter ID            | Exercised behavior                                                                                                                                                    | Environment                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `combinators`         | Generated topologies; real Siglo bounded map, ordering, partial failures, race loser cancellation, and all-settled outcomes                                           | In process                                                   |
| `sagas`               | Completed-step rollback ordering with injected failures                                                                                                               | In process                                                   |
| `durable-occ`         | Resume contention against fake storage with seeded latency/conflicts                                                                                                  | In-memory adapter double                                     |
| `idempotency`         | Concurrent claims and retention expiry                                                                                                                                | In-memory store                                              |
| `queues-batch`        | Exact SQS failed IDs, Kafka offset/DLQ ordering, and BullMQ processor failure/deduplication                                                                           | Real handlers, transport doubles; no broker or worker daemon |
| `http-abort`          | Express/Fastify Node disconnect events, Hono request-signal cancellation, normal request close, downstream suppression, and listener/timer cleanup                    | Adapter request/response doubles                             |
| `cli-diagrams`        | Graph-to-Mermaid/DOT exports                                                                                                                                          | Library calls; no CLI subprocess                             |
| `graph-ast`           | Graph validation, network-policy metadata reflection, and reusable graph immutability                                                                                 | No network enforcement claim                                 |
| `opentelemetry`       | Instrumentation, span continuity, and context propagation                                                                                                             | Mock tracer                                                  |
| `ai`                  | Structured output repair, fallback/timeout outcomes, and tool compensation                                                                                            | Mock AI provider; no paid requests                           |
| `notifications`       | Dispatch deduplication, token tampering/key rotation, and approval races                                                                                              | Mock transports and in-memory state                          |
| `cluster-failover`    | Stale resumes, token ownership, and simulated cluster concurrency                                                                                                     | Fake storage and Redis double; no process-death claim        |
| `ide-telemetry`       | Four ecosystem recording kinds, secret exclusion, matching, duplicate diagnostics, edited source ranges, and imported factories without executing code                | Temporary source fixtures and static parser                  |
| `security-boundaries` | Reserved context keys, concurrent network-policy isolation, redirects to metadata, mixed DNS answers, and client durability controls                                  | Loopback HTTP server and controlled DNS lookup               |
| `persistent-recovery` | SIGKILL after an external effect, persisted approval recovery via competing schedulers, signed callback races, actual Redis expiry, and stale-owner release rejection | Live Postgres/Redis and a child process                      |

VS Code host tests additionally verify navigation uses updated source ranges after edits. Existing Kafka integration tests exercise broker-backed crashes, rebalances, and transactional outbox recovery; the exploratory queue charter does not replace them.

## Running the suite

Build packages first with `npm run build`, then:

```bash
# Type-check the exploratory harness and run PR smoke/regression tests
npm run test:exploratory

# Run all service-free charters, or select a stable charter ID
npm run explore -- --iterations=50 --seed=123
npm run explore -- --charter=ide-telemetry --iterations=25 --seed=123
npm run explore -- --charter=security-boundaries --iterations=25 --seed=123
```

Filters apply **before execution**. An exact ID takes precedence over substring matches. Unknown filters, non-positive iteration counts, and seeds outside the unsigned 32-bit integer range fail immediately. Result metadata includes the stable charter ID, effective seed, duration, iteration count, and checked invariant numbers. Charter-specific assertions may extend beyond the ten shared invariant oracles.

To run persistent recovery locally:

```bash
docker compose -p siglo-exploratory-tests -f test/exploratory/compose.yaml up -d --wait
SIGLO_TEST_POSTGRES_URL=postgres://siglo:siglo_test@localhost:15439/siglo_exploratory_test \
SIGLO_TEST_REDIS_URL=redis://localhost:16389 \
npm run explore -- --integration --charter=persistent-recovery --iterations=5 --seed=42
docker compose -p siglo-exploratory-tests -f test/exploratory/compose.yaml down -v
```

Integration mode fails when either connection variable is absent or a required service is unavailable. Each recovery run uses isolated table names and Redis keys and cleans them up. Its external effect has a durable idempotency key: a crash before checkpointing can replay an action, so successful recovery is checked through persisted effect counts rather than an exactly-once delivery assumption.

The nightly workflow runs 200 iterations per charter with Postgres and Redis service containers and uploads failure fixtures. It also runs the configured invariant mutation suite. Mutation reports describe that run; no historical mutation score is treated as a current gate result.

## Failure artifacts and replay

Failed charters write JSON snapshots under `test/fixtures/` and print a replay command:

```bash
npm run explore -- --replay=test/fixtures/failure_<charter>_seed<seed>_iter-1_<timestamp>_<unique>.json
```

Snapshots include effective/global seeds, iteration budget, errors, and available case evidence. New case-based charters record per-case seeds and generated inputs or injected faults. Replay executes the original charter and iteration budget with the same seed. Integration replays require the same service variables; connection credentials are not stored in the artifact.

Seeded generators and chaos decisions reproduce generated scenarios. Real clocks, OS scheduling, service-generated identifiers, and process timing remain nondeterministic. A replay can therefore pass for an intermittent race; preserve the original artifact when investigating.

`FailureShrinker.minimizeTrace` remains an opt-in delta-debugging helper. The runner does **not** automatically shrink ASTs or claim that a shortened observed trace reproduces a runtime failure. General AST minimization, exhaustive checkpoint-corruption exploration, and continuous heap/leak soak measurements remain future work.

## Runnable investigation example

Use case 25 demonstrates offline recording sanitization and unambiguous source attachment without running the recorded workflow:

```bash
npm run demo:telemetry --workspace=siglo-examples
```

See the [examples guide](../examples/README.md) for local-file input and related approval, monitoring, and governance scenarios.
