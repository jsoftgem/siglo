# Siglo Examples & Production-Grade Use Cases

This workspace provides runnable examples demonstrating [`Siglo`](https://github.com/jsoftgem/siglo) v1.2.3 and its ecosystem integrations, including storage adapters, OpenTelemetry observability, web framework middlewares, event stream adapters, and complete implementations of **25 Event-Driven & Workflow Power Use Cases**.

- [`StorageAdapter`](../packages/core/src/features/storage/adapter.ts)
- [`Step.useStorage(...)`](../packages/core/src/features/storage/index.ts)
- [`onContextChange`](../packages/core/src/features/storage/adapter.ts) (real-time telemetry and context streaming)
- [`saveCheckpoint` / `getCheckpoint`](../packages/core/src/features/storage/adapter.ts) (durable saga pause/resume)
- [`getCachedStep` / `setCachedStep`](../packages/core/src/features/storage/adapter.ts) (distributed memoized step execution)
- [`compensate`](../packages/core/src/features/step/index.ts) / [`CompensationException`](../packages/core/src/features/executer/exceptions.ts) (distributed sagas and LIFO compensation rollback)
- [`map`](../packages/core/src/features/combinators/index.ts) (bounded concurrency worker mapping)
- [`race`](../packages/core/src/features/combinators/index.ts) / [`parallel`](../packages/core/src/features/combinators/index.ts) / [`allSettled`](../packages/core/src/features/combinators/index.ts) (speculative competitive racing and concurrent branches)
- [`branch`](../packages/core/src/features/combinators/index.ts) / [`when`](../packages/core/src/features/combinators/index.ts) (deterministic conditional routing slips)
- [`idempotent`](../packages/core/src/features/step/index.ts) (scoped idempotency claim locking)
- [`waitForEvent`](../packages/core/src/features/durable/index.ts) / `workflow.resume` / `flow.version` (durable human-in-the-loop suspension checkpoints and schema migrations)
- [`toGraph`](../packages/core/src/features/graph/index.ts) / [`validateGraph`](../packages/core/src/features/graph/index.ts) (workflow AST graph governance and cycle validation)
- [`sigloFastifyHandler`](../packages/fastify/src/index.ts) / [`sigloExpressMiddleware`](../packages/express/src/index.ts) / [`sigloMiddleware`](../packages/hono/src/index.ts) (HTTP API adapters with `x-namespace` propagation)
- [`createKafkaMessageHandler`](../packages/kafka/src/index.ts) / [`createBullMQProcessor`](../packages/bullmq/src/index.ts) / [`createSqsBatchHandler`](../packages/sqs/src/index.ts) (asynchronous messaging & queue workers)
- [`instrumentWorkflow`](../packages/opentelemetry/src/instrument.ts) / [`createTelemetryStorageAdapter`](../packages/opentelemetry/src/instrument.ts) (OpenTelemetry spans, retry tracing, W3C trace context, and namespace redaction)
- [`PostgresStorageAdapter`](../packages/postgres/src/adapter.ts) / [`RedisStorageAdapter`](../packages/redis/src/adapter.ts) (enterprise storage adapters and distributed locks)

## Start Here: A Checkout You Can Run Locally

New to Siglo? Follow [Getting Started: Build a Checkout That Handles Failure](../docs/01-getting-started.md). The [checkout example](src/getting-started/checkout.ts) uses fake inventory, payment, and shipping services to show retries and compensation without external infrastructure.

From the repository root, with dependencies installed:

```bash
npm run build --workspace=@siglo/core
node --import tsx examples/src/getting-started/checkout-demo.ts
node --import tsx --test examples/src/getting-started/checkout.test.ts
```

To call checkout over HTTP and inspect it in the dashboard, follow [REST Integration and Live Monitoring](../docs/rest-and-live-monitoring.md) and run `node --import tsx examples/src/getting-started/checkout-server.ts` after building `@siglo/express` and `@siglo/monitor`.

The demo shows a recovered payment failure and a shipping failure that triggers a refund and stock release. The tests also cover invalid input, permanent payment failure, and duplicate requests.

Continue with [Kafka Order Routing](../docs/kafka-order-routing.md) and the [ready-made two-consumer example](kafka-order-routing/README.md) to explore `@siglo/kafka`, shared `@siglo/postgres` idempotency, `branch`, and `when`.

Continue with [Zero-Code APM Dashboards](../docs/zero-code-apm-dashboards.md) and its [self-contained example](zero-code-apm-dashboards/README.md) for traced publisher-to-worker execution and provisioned Grafana metrics. It runs independently of the Kafka routing tutorial.

---

## Architecture Overview

```mermaid
flowchart TD
    Core["Siglo<br/>Distributed Step Pipelines"]

    subgraph StorageHooks["Storage Hooks (Plugins Interface)"]
        direction LR
        Redis["Redis<br/>(Cache & Locks)"]
        Postgres["Postgres<br/>(Durable Ledgers)"]
        MongoDB["MongoDB<br/>(Audit & Analytics)"]
        Jaeger["Jaeger<br/>(OpenTelemetry)"]
    end

    Core --> StorageHooks
```

1. **Redis**: Acts as a fast distributed cache (`@siglo/redis`), checkpoints, scoped idempotency keys, and distributed locks (`RedisLock`).
2. **PostgreSQL**: Durable transactional checkpoints (`@siglo/postgres`), audit event streams, and scoped idempotency claims.
3. **MongoDB**: Document store for permanent analytical execution audit logs (`siglo_execution_logs`) with `stackId` and `namespace` tracing.
4. **Redpanda / Kafka**: Streaming message broker (`@siglo/kafka`) for high-throughput event enrichment and dead-letter handling.
5. **Jaeger**: OpenTelemetry visualizer and collector (`@siglo/opentelemetry`) displaying root workflow spans, step child spans, and retry attempts.

---

## The 25 Production Event-Driven & Workflow Power Use Cases

### Phase 1: Event-Driven Distributed Architectures

|   #    | Use Case                              | Implementation File                                                                                      | Key Features Demonstrated                                                                                                                              |
| :----: | :------------------------------------ | :------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | **E-Commerce Saga Orchestration**     | [`usecase-1-ecommerce-saga.ts`](src/workflow/usecases/usecase-1-ecommerce-saga.ts)                       | Spec validation, `onFail` retry with exponential backoff, compensating actions, modern parameter mapping                                               |
| **2**  | **AI / LLM & RAG Pipelines**          | [`usecase-2-ai-rag-pipeline.ts`](src/workflow/usecases/usecase-2-ai-rag-pipeline.ts)                     | Claim-check pointers, chunking, deterministic caching with `.cache(60000)` to avoid redundant LLM embedding costs                                      |
| **3**  | **Financial Transaction & Fraud**     | [`usecase-3-financial-fraud-detection.ts`](src/workflow/usecases/usecase-3-financial-fraud-detection.ts) | Strict `spec` contracts, idempotent deduplication, ML risk scoring, double-entry ledger booking                                                        |
| **4**  | **Media Transcoding & Assets**        | [`usecase-4-media-transcoding.ts`](src/workflow/usecases/usecase-4-media-transcoding.ts)                 | S3 claim-check pointers, native `AbortSignal` cancellation support, multi-variant transcoding, CDN warm-up                                             |
| **5**  | **IoT Ingestion & Anomaly Detection** | [`usecase-5-iot-telemetry-anomaly.ts`](src/workflow/usecases/usecase-5-iot-telemetry-anomaly.ts)         | Data normalization via `spec` transformer (Fahrenheit to Celsius, PSI to Bar), real-time anomaly detection, cold storage partitioning                  |
| **6**  | **CDC & Data Lakehouse ETL**          | [`usecase-6-cdc-lakehouse-etl.ts`](src/workflow/usecases/usecase-6-cdc-lakehouse-etl.ts)                 | Schema `translator` (snake_case DB columns to analytical schema), LSN deduplication, dimension enrichment, Iceberg/Parquet sink                        |
| **7**  | **KYC & Customer Onboarding**         | [`usecase-7-kyc-onboarding.ts`](src/workflow/usecases/usecase-7-kyc-onboarding.ts)                       | PII datastore encryption, multi-service orchestration (OCR + biometrics + OFAC watchlist), resilient external API retries                              |
| **8**  | **Healthcare FHIR Clinical Events**   | [`usecase-8-healthcare-fhir.ts`](src/workflow/usecases/usecase-8-healthcare-fhir.ts)                     | Standard FHIR spec validation, HIPAA PII de-identification (pseudonymous hashes), W3C OpenTelemetry `traceparent` propagation, STAT emergency alerting |
| **9**  | **Omnichannel Notification Engine**   | [`usecase-9-omnichannel-notifications.ts`](src/workflow/usecases/usecase-9-omnichannel-notifications.ts) | Dynamic routing slip, personalized template rendering, HTTP 429 gateway retry backoff, channel failover (PUSH -> SMS/EMAIL)                            |
| **10** | **SecOps & Auto-Remediation**         | [`usecase-10-secops-remediation.ts`](src/workflow/usecases/usecase-10-secops-remediation.ts)             | Safe lifecycle execution via `onBefore` maintenance lock verification, root cause correlation, automated node cordoning, Slack post-mortem dispatch    |

### Phase 2: Core Workflow Power, Concurrency & Graph Governance

|   #    | Use Case                                     | Implementation File                                                                                                  | Key Features Demonstrated                                                                                                                                                                                            |
| :----: | :------------------------------------------- | :------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **11** | **Distributed Travel Booking Saga**          | [`usecase-11-distributed-saga-compensation.ts`](src/workflow/usecases/usecase-11-distributed-saga-compensation.ts)   | Forward distributed reservations across Flight, Hotel, and Car services with automatic LIFO rollback (`step.compensate(...)`, `CompensationException`)                                                               |
| **12** | **Bounded Concurrency Batch Ingestion**      | [`usecase-12-bounded-batch-mapping.ts`](src/workflow/usecases/usecase-12-bounded-batch-mapping.ts)                   | Controlled parallel document vectorization with fixed worker pool (`map(accessor, worker, { concurrency: 3 })`), dynamic rate limiting, and failure containment                                                      |
| **13** | **Multi-Cloud Latency Race & Parallel Sync** | [`usecase-13-parallel-cloud-race.ts`](src/workflow/usecases/usecase-13-parallel-cloud-race.ts)                       | Competitive latency racing across cloud regions (`race(...)`), deep payload state merging (`parallel(..., { mergeStrategy: 'deep' })`), and non-blocking background telemetry (`allSettled(...)`)                    |
| **14** | **Fintech Loan Underwriting Routing**        | [`usecase-14-dynamic-underwriting-branching.ts`](src/workflow/usecases/usecase-14-dynamic-underwriting-branching.ts) | Multi-tier risk tier evaluation via switch routing (`branch(selector, branches, defaultBranch)`) and condition-based promo rate adjustments (`when(predicate, thenStep, elseStep)`)                                  |
| **15** | **Idempotent Bank Payment Settlement**       | [`usecase-15-idempotent-payment-claims.ts`](src/workflow/usecases/usecase-15-idempotent-payment-claims.ts)           | Scoped idempotency claim locking (`step.idempotent(...)`, `InMemoryIdempotencyStore`, `buildIdempotencyKey`) preventing concurrent double charges or duplicate execution                                             |
| **16** | **Durable Expense Approval & Versioning**    | [`usecase-16-durable-human-approval.ts`](src/workflow/usecases/usecase-16-durable-human-approval.ts)                 | Durable human-in-the-loop wait checkpoints (`waitForEvent('expense.decision', { correlationKey })`), external event resumption (`workflow.resume`), and workflow schema version migration (`flow.version('v1.2.3')`) |
| **17** | **CI/CD Pipeline AST Graph Governance**      | [`usecase-17-workflow-graph-governance.ts`](src/workflow/usecases/usecase-17-workflow-graph-governance.ts)           | Pipeline static compilation (`toGraph(pipeline)`), cycle detection & structural assertions (`validateGraph`, `assertValidGraph`), and compliance introspection (`inspectGraph`)                                      |

### Phase 3: Ecosystem, Adapters & Distributed Power

|   #    | Use Case                                       | Implementation File                                                                                                    | Key Features Demonstrated                                                                                                                                   |
| :----: | :--------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **18** | **HTTP Checkout & Order Processing**           | [`usecase-18-http-order-service.ts`](src/workflow/usecases/usecase-18-http-order-service.ts)                           | Framework adapters (`@siglo/fastify`, `@siglo/express`, `@siglo/hono`), automatic `x-namespace` routing, typed input extraction, and HTTP status mapping    |
| **19** | **Kafka Event Stream Enrichment**              | [`usecase-19-kafka-stream-enrichment.ts`](src/workflow/usecases/usecase-19-kafka-stream-enrichment.ts)                 | Streaming event consumer (`@siglo/kafka`), header namespace parsing, account tier enrichment, anomaly risk scoring, and dead-letter isolation               |
| **20** | **Resilient Async Queue Worker**               | [`usecase-20-async-queue-worker.ts`](src/workflow/usecases/usecase-20-async-queue-worker.ts)                           | Heavy background job processor (`@siglo/bullmq`) with progress reporting, plus AWS SQS batch consumer (`@siglo/sqs`) with partial batch failure containment |
| **21** | **Distributed Tracing & Context Propagation**  | [`usecase-21-distributed-telemetry-tracing.ts`](src/workflow/usecases/usecase-21-distributed-telemetry-tracing.ts)     | OpenTelemetry spans (`@siglo/opentelemetry`), retry attempt counting (`siglo.step.attempt`), W3C `traceparent` propagation, and namespace privacy redaction |
| **22** | **Multi-Tenant SaaS Billing & Audit Ledger**   | [`usecase-22-saas-billing-ledger.ts`](src/workflow/usecases/usecase-22-saas-billing-ledger.ts)                         | Scoped multi-tenant billing (`@siglo/postgres`, `@siglo/redis`), durable checkpoints, audit streams, idempotency locks, and single-flight `RedisLock`       |
| **23** | **Live Workflow Monitoring & DevTools Server** | [`usecase-23-live-workflow-monitoring.ts`](src/workflow/usecases/usecase-23-live-workflow-monitoring.ts)               | Live telemetry streaming (`@siglo/monitor`), SSE/WebSocket events, latency tracking, Prometheus metrics, and real-time dashboard                            |
| **24** | **Order Intake Contracts & Input Specs**       | [`usecase-24-order-intake-specs.ts`](src/workflow/usecases/usecase-24-order-intake-specs.ts)                           | Input normalization, field translators, standard schema contracts, and default value mapping                                                                |
| **25** | **Offline Telemetry Investigation**            | [`usecase-25-offline-telemetry-investigation.ts`](src/workflow/usecases/usecase-25-offline-telemetry-investigation.ts) | Sanitize imported recordings, match workflow/version/step identity, avoid ambiguous source matches, and investigate without execution                       |

---

## Project Structure

```
examples/
├── docker-compose.yml              # Redis 7, Postgres 16, MongoDB 7, Redpanda (Kafka), Jaeger
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── database/
    │   ├── redis.ts                # Redis client adapter
    │   └── mongodb.ts              # MongoDB client adapter
    ├── plugin/
    │   └── redis-mongo-storage.ts  # Storage hook implementation for Siglo
    ├── workflow/
    │   ├── order-pipeline.ts       # Original base e-commerce order pipeline
    │   └── usecases/               # Top 25 Production Event-Driven & Workflow Use Cases
    │       ├── index.ts
    │       └── usecase-1..25-*.ts
    ├── index.ts                    # Executable demo script for the original workflow use cases
    └── index.test.ts               # Integration tests for storage plugins and workflow use cases
```

---

## Running the Demo & Test Suites

### Zero-Daemon Mode (In-Memory Fallback - Zero Setup Required)

```bash
# Run the original workflow demo and ecosystem integrations
npm start --workspace=siglo-examples

# Run all test suites
npm test --workspace=siglo-examples
```

### Live Docker Services Mode (Optional)

To spin up all Phase 3 backing infrastructure:

```bash
# 1. Start all Docker containers (Redis, PostgreSQL, MongoDB, Redpanda/Kafka, Jaeger)
docker compose -f examples/docker-compose.yml up -d

# 2. Run the demo against live containers
REDIS_URL="redis://:redispassword@localhost:6379" \
MONGODB_URI="mongodb://admin:mongopassword@localhost:27017/siglo_db?authSource=admin" \
POSTGRES_URL="postgres://postgres:postgrespassword@localhost:5432/siglo_db" \
KAFKA_BROKERS="localhost:9092" \
npm start --workspace=siglo-examples
```

## Offline telemetry investigation

Run `npm run demo:telemetry --workspace=siglo-examples` for a service-free investigation of a synthetic checkout recording. The summary includes a sanitized HTTP failure and counts unmatched records; malformed records are discarded and credentials, request headers, and raw payloads are excluded.

Pass a local recording with `npm run demo:telemetry --workspace=siglo-examples -- /absolute/path/recording.json`. The sample matches workflow `checkout`, version `1`, and step `charge`. Adapt `offlineInvestigationTarget` for your workflow. Duplicate matching node names are reported as ambiguous and receive no attachment.

The approval/checkout tests include competing deliveries, monitoring tests verify dashboard snapshots redact secrets, and governance tests demonstrate static diagnostics before executing workflow actions. Real process-death recovery with Postgres and Redis is covered by the [persistent exploratory charter](../test/exploratory/charters/persistent-recovery.explore.ts).
