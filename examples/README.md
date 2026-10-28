# Rivulet Examples & Production-Grade Use Cases

This workspace provides runnable examples demonstrating [`Rivulet`](https://github.com/rickzx98/Rivulet) v2.0.0 and its ecosystem integrations, including storage adapters, OpenTelemetry observability, web framework middlewares, event stream adapters, and complete implementations of **22 Event-Driven & Workflow Power Use Cases**.

- [`StorageAdapter`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/storage/adapter.ts)
- [`Step.useStorage(...)`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/storage/index.ts)
- [`onContextChange`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/storage/adapter.ts) (real-time telemetry and context streaming)
- [`saveCheckpoint` / `getCheckpoint`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/storage/adapter.ts) (durable saga pause/resume)
- [`getCachedStep` / `setCachedStep`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/storage/adapter.ts) (distributed memoized step execution)
- [`compensate`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/step/index.ts) / [`CompensationException`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/executer/exceptions.ts) (distributed sagas and LIFO compensation rollback)
- [`map`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/combinators/index.ts) (bounded concurrency worker mapping)
- [`race`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/combinators/index.ts) / [`parallel`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/combinators/index.ts) / [`allSettled`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/combinators/index.ts) (speculative competitive racing and concurrent branches)
- [`branch`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/combinators/index.ts) / [`when`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/combinators/index.ts) (deterministic conditional routing slips)
- [`idempotent`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/step/index.ts) (scoped idempotency claim locking)
- [`waitForEvent`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/durable/index.ts) / `workflow.resume` / `flow.version` (durable human-in-the-loop suspension checkpoints and schema migrations)
- [`toGraph`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/graph/index.ts) / [`validateGraph`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/core/src/features/graph/index.ts) (workflow AST graph governance and cycle validation)
- [`fluidFastifyHandler`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/fastify/src/index.ts) / [`fluidExpressMiddleware`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/express/src/index.ts) / [`fluidMiddleware`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/hono/src/index.ts) (HTTP API adapters with `x-namespace` propagation)
- [`createKafkaMessageHandler`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/kafka/src/index.ts) / [`createBullMQProcessor`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/bullmq/src/index.ts) / [`createSqsBatchHandler`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/sqs/src/index.ts) (asynchronous messaging & queue workers)
- [`instrumentWorkflow`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/opentelemetry/src/instrument.ts) / [`createTelemetryStorageAdapter`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/opentelemetry/src/instrument.ts) (OpenTelemetry spans, retry tracing, W3C trace context, and namespace redaction)
- [`PostgresStorageAdapter`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/postgres/src/adapter.ts) / [`RedisStorageAdapter`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/packages/redis/src/adapter.ts) (enterprise storage adapters and distributed locks)

---

## Architecture Overview

```
                      ┌─────────────────────────────────────────┐
                      │               Rivulet                │
                      │        Distributed Step Pipelines       │
                      └─────────────────────┬───────────────────┘
                                            │
                        Storage Hooks (Plugins Interface)
                                            │
         ┌───────────────────┬──────────────┴──────┬───────────────────┐
         ▼                   ▼                     ▼                   ▼
   ┌───────────┐       ┌───────────┐         ┌───────────┐       ┌───────────┐
   │   Redis   │       │ Postgres  │         │  MongoDB  │       │  Jaeger   │
   │  (Cache & │       │ (Durable  │         │ (Audit &  │       │ (Open-    │
   │   Locks)  │       │ Ledgers)  │         │ Analytics)│       │ Telemetry)│
   └───────────┘       └───────────┘         └───────────┘       └───────────┘
```

1. **Redis**: Acts as a fast distributed cache (`@rivulet/redis`), checkpoints, scoped idempotency keys, and distributed locks (`RedisLock`).
2. **PostgreSQL**: Durable transactional checkpoints (`@rivulet/postgres`), audit event streams, and scoped idempotency claims.
3. **MongoDB**: Document store for permanent analytical execution audit logs (`fluid_execution_logs`) with `stackId` and `namespace` tracing.
4. **Redpanda / Kafka**: Streaming message broker (`@rivulet/kafka`) for high-throughput event enrichment and dead-letter handling.
5. **Jaeger**: OpenTelemetry visualizer and collector (`@rivulet/opentelemetry`) displaying root workflow spans, step child spans, and retry attempts.

---

## The 22 Production Event-Driven & Workflow Power Use Cases

### Phase 1: Event-Driven Distributed Architectures

| # | Use Case | Implementation File | Key Features Demonstrated |
| :-: | :--- | :--- | :--- |
| **1** | **E-Commerce Saga Orchestration** | [`usecase-1-ecommerce-saga.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/usecases/usecase-1-ecommerce-saga.ts) | Spec validation, `onFail` retry with exponential backoff, compensating actions, modern parameter mapping |
| **2** | **AI / LLM & RAG Pipelines** | [`usecase-2-ai-rag-pipeline.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/usecases/usecase-2-ai-rag-pipeline.ts) | Claim-check pointers, chunking, deterministic caching with `.cache(60000)` to avoid redundant LLM embedding costs |
| **3** | **Financial Transaction & Fraud** | [`usecase-3-financial-fraud-detection.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/usecases/usecase-3-financial-fraud-detection.ts) | Strict `spec` contracts, idempotent deduplication, ML risk scoring, double-entry ledger booking |
| **4** | **Media Transcoding & Assets** | [`usecase-4-media-transcoding.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/usecases/usecase-4-media-transcoding.ts) | S3 claim-check pointers, native `AbortSignal` cancellation support, multi-variant transcoding, CDN warm-up |
| **5** | **IoT Ingestion & Anomaly Detection** | [`usecase-5-iot-telemetry-anomaly.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/usecases/usecase-5-iot-telemetry-anomaly.ts) | Data normalization via `spec` transformer (Fahrenheit to Celsius, PSI to Bar), real-time anomaly detection, cold storage partitioning |
| **6** | **CDC & Data Lakehouse ETL** | [`usecase-6-cdc-lakehouse-etl.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/usecases/usecase-6-cdc-lakehouse-etl.ts) | Schema `translator` (snake_case DB columns to analytical schema), LSN deduplication, dimension enrichment, Iceberg/Parquet sink |
| **7** | **KYC & Customer Onboarding** | [`usecase-7-kyc-onboarding.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/usecases/usecase-7-kyc-onboarding.ts) | PII datastore encryption, multi-service orchestration (OCR + biometrics + OFAC watchlist), resilient external API retries |
| **8** | **Healthcare FHIR Clinical Events** | [`usecase-8-healthcare-fhir.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/usecases/usecase-8-healthcare-fhir.ts) | Standard FHIR spec validation, HIPAA PII de-identification (pseudonymous hashes), W3C OpenTelemetry `traceparent` propagation, STAT emergency alerting |
| **9** | **Omnichannel Notification Engine** | [`usecase-9-omnichannel-notifications.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/usecases/usecase-9-omnichannel-notifications.ts) | Dynamic routing slip, personalized template rendering, HTTP 429 gateway retry backoff, channel failover (PUSH -> SMS/EMAIL) |
| **10** | **SecOps & Auto-Remediation** | [`usecase-10-secops-remediation.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/usecases/usecase-10-secops-remediation.ts) | Safe lifecycle execution via `onBefore` maintenance lock verification, root cause correlation, automated node cordoning, Slack post-mortem dispatch |

### Phase 2: Core Workflow Power, Concurrency & Graph Governance

| # | Use Case | Implementation File | Key Features Demonstrated |
| :-: | :--- | :--- | :--- |
| **11** | **Distributed Travel Booking Saga** | [`usecase-11-distributed-saga-compensation.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/phase2/usecase-11-distributed-saga-compensation.ts) | Forward distributed reservations across Flight, Hotel, and Car services with automatic LIFO rollback (`step.compensate(...)`, `CompensationException`) |
| **12** | **Bounded Concurrency Batch Ingestion** | [`usecase-12-bounded-batch-mapping.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/phase2/usecase-12-bounded-batch-mapping.ts) | Controlled parallel document vectorization with fixed worker pool (`map(accessor, worker, { concurrency: 3 })`), dynamic rate limiting, and failure containment |
| **13** | **Multi-Cloud Latency Race & Parallel Sync** | [`usecase-13-parallel-cloud-race.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/phase2/usecase-13-parallel-cloud-race.ts) | Competitive latency racing across cloud regions (`race(...)`), deep payload state merging (`parallel(..., { mergeStrategy: 'deep' })`), and non-blocking background telemetry (`allSettled(...)`) |
| **14** | **Fintech Loan Underwriting Routing** | [`usecase-14-dynamic-underwriting-branching.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/phase2/usecase-14-dynamic-underwriting-branching.ts) | Multi-tier risk tier evaluation via switch routing (`branch(selector, branches, defaultBranch)`) and condition-based promo rate adjustments (`when(predicate, thenStep, elseStep)`) |
| **15** | **Idempotent Bank Payment Settlement** | [`usecase-15-idempotent-payment-claims.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/phase2/usecase-15-idempotent-payment-claims.ts) | Scoped idempotency claim locking (`step.idempotent(...)`, `InMemoryIdempotencyStore`, `buildIdempotencyKey`) preventing concurrent double charges or duplicate execution |
| **16** | **Durable Expense Approval & Versioning** | [`usecase-16-durable-human-approval.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/phase2/usecase-16-durable-human-approval.ts) | Durable human-in-the-loop wait checkpoints (`waitForEvent('expense.decision', { correlationKey })`), external event resumption (`workflow.resume`), and workflow schema version migration (`flow.version('v2.0.0')`) |
| **17** | **CI/CD Pipeline AST Graph Governance** | [`usecase-17-workflow-graph-governance.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/phase2/usecase-17-workflow-graph-governance.ts) | Pipeline static compilation (`toGraph(pipeline)`), cycle detection & structural assertions (`validateGraph`, `assertValidGraph`), and compliance introspection (`inspectGraph`) |

### Phase 3: Ecosystem, Adapters & Distributed Power

| # | Use Case | Implementation File | Key Features Demonstrated |
| :-: | :--- | :--- | :--- |
| **18** | **HTTP Checkout & Order Processing** | [`usecase-18-http-order-service.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/phase3/usecase-18-http-order-service.ts) | Framework adapters (`@rivulet/fastify`, `@rivulet/express`, `@rivulet/hono`), automatic `x-namespace` routing, typed input extraction, and HTTP status mapping |
| **19** | **Kafka Event Stream Enrichment** | [`usecase-19-kafka-stream-enrichment.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/phase3/usecase-19-kafka-stream-enrichment.ts) | Streaming event consumer (`@rivulet/kafka`), header namespace parsing, account tier enrichment, anomaly risk scoring, and dead-letter isolation |
| **20** | **Resilient Async Queue Worker** | [`usecase-20-async-queue-worker.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/phase3/usecase-20-async-queue-worker.ts) | Heavy background job processor (`@rivulet/bullmq`) with progress reporting, plus AWS SQS batch consumer (`@rivulet/sqs`) with partial batch failure containment |
| **21** | **Distributed Tracing & Context Propagation** | [`usecase-21-distributed-telemetry-tracing.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/phase3/usecase-21-distributed-telemetry-tracing.ts) | OpenTelemetry spans (`@rivulet/opentelemetry`), retry attempt counting (`fluid.step.attempt`), W3C `traceparent` propagation, and namespace privacy redaction |
| **22** | **Multi-Tenant SaaS Billing & Audit Ledger** | [`usecase-22-saas-billing-ledger.ts`](file:///Users/jericodeguzman/IdeaProjects/Rivulet/examples/src/workflow/phase3/usecase-22-saas-billing-ledger.ts) | Scoped multi-tenant billing (`@rivulet/postgres`, `@rivulet/redis`), durable checkpoints, audit streams, idempotency locks, and single-flight `RedisLock` |

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
    │   └── redis-mongo-storage.ts  # Storage hook implementation for Rivulet
    ├── workflow/
    │   ├── order-pipeline.ts       # Original base e-commerce order pipeline
    │   ├── usecases/               # Top 10 Event-Driven Use Cases (Phase 1)
    │   │   ├── index.ts
    │   │   └── usecase-1..10-*.ts
    │   ├── phase2/                 # 7 Advanced Workflow Power Use Cases (Phase 2)
    │   │   ├── index.ts
    │   │   └── usecase-11..17-*.ts
    │   └── phase3/                 # 5 Ecosystem & Adapter Use Cases (Phase 3)
    │       ├── index.ts
    │       ├── usecase-18-http-order-service.ts
    │       ├── usecase-19-kafka-stream-enrichment.ts
    │       ├── usecase-20-async-queue-worker.ts
    │       ├── usecase-21-distributed-telemetry-tracing.ts
    │       └── usecase-22-saas-billing-ledger.ts
    ├── index.ts                    # Executable demo script running all 22 use cases
    ├── index.test.ts               # Storage plugin & base order pipeline test suite
    ├── usecases.test.ts            # Integration test suite for Phase 1 use cases
    ├── phase2-usecases.test.ts     # Integration test suite for Phase 2 use cases
    └── phase3-usecases.test.ts     # Integration test suite for Phase 3 use cases
```

---

## Running the Demo & Test Suites

### Zero-Daemon Mode (In-Memory Fallback - Zero Setup Required)

```bash
# Run the demo showcasing all 22 use cases and ecosystem integrations
npm start --workspace=Rivulet-examples

# Run all test suites
npm test --workspace=Rivulet-examples

# Run Phase 1 event-driven use cases specifically
npm run test:usecases --workspace=Rivulet-examples

# Run Phase 2 workflow power use cases specifically
npm run test:phase2 --workspace=Rivulet-examples

# Run Phase 3 ecosystem & adapter use cases specifically
npm run test:phase3 --workspace=Rivulet-examples
```

### Live Docker Services Mode (Optional)

To spin up all Phase 3 backing infrastructure:

```bash
# 1. Start all Docker containers (Redis, PostgreSQL, MongoDB, Redpanda/Kafka, Jaeger)
docker compose -f examples/docker-compose.yml up -d

# 2. Run the demo against live containers
REDIS_URL="redis://:redispassword@localhost:6379" \
MONGODB_URI="mongodb://admin:mongopassword@localhost:27017/fluid_func_db?authSource=admin" \
POSTGRES_URL="postgres://postgres:postgrespassword@localhost:5432/fluid_func_db" \
KAFKA_BROKERS="localhost:9092" \
npm start --workspace=Rivulet-examples
```
