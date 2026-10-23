# fluid-func Redis & MongoDB Storage & Event-Driven Use Cases Sample

This is a working test project demonstrating how to connect **Redis** and **MongoDB** as external storage providers for [`fluid-func`](https://github.com/rickzx98/fluid-func) using the unified [`StorageAdapter`](file:///Users/jericodeguzman/IdeaProjects/fluid-func/src/features/storage/adapter.ts) interface (`Step.useStorage(...)`), along with complete runnable implementations and automated tests for the **Top 10 Event-Driven Distributed Use Cases** (as documented in [`usecases.md`](../usecases.md)).

- [`StorageAdapter`](file:///Users/jericodeguzman/IdeaProjects/fluid-func/src/features/storage/adapter.ts)
- [`Step.useStorage(...)`](file:///Users/jericodeguzman/IdeaProjects/fluid-func/src/features/storage/index.ts)
- [`onContextChange`](file:///Users/jericodeguzman/IdeaProjects/fluid-func/src/features/storage/adapter.ts) (real-time telemetry and context streaming)
- [`saveCheckpoint` / `getCheckpoint`](file:///Users/jericodeguzman/IdeaProjects/fluid-func/src/features/storage/adapter.ts) (durable saga pause/resume)
- [`getCachedStep` / `setCachedStep`](file:///Users/jericodeguzman/IdeaProjects/fluid-func/src/features/storage/adapter.ts) (distributed memoized step execution)

---

## Architecture Overview

```
                      ┌─────────────────────────────────────────┐
                      │               fluid-func                │
                      │        Distributed Step Pipelines       │
                      └─────────────────────┬───────────────────┘
                                            │
                        Storage Hooks (Plugins Interface)
                                            │
                     ┌──────────────────────┴──────────────────────┐
                     ▼                                             ▼
       ┌───────────────────────────┐               ┌───────────────────────────┐
       │           Redis           │               │          MongoDB          │
       │     (Distributed Cache)   │               │    (Persistent Storage)   │
       ├───────────────────────────┤               ├───────────────────────────┤
       │ • fluid:chain:{name}      │               │ • Collection: checkpoints │
       │ • fluid:context:{chainId} │               │ • Collection: logs        │
       │   (High-speed step state) │               │   (Audit trail & history) │
       │ • fluid:stack:{stackId}   │               │   with unbroken stackId   │
       └───────────────────────────┘               └───────────────────────────┘
```

1. **Redis**: Acts as a fast distributed cache for step results (`fluid:cache:{key}`), stack-partitioned contexts (`fluid:stack:{stackId}`), and checkpoints (`fluid:checkpoint:{stackId}`).
2. **MongoDB**: Serves as the durable document store for permanent execution audit logs (`fluid_execution_logs`) with `stackId` and `tenantId` tracing, and saga checkpoints (`fluid_checkpoints`).

---

## The Top 10 Event-Driven Use Cases Implemented

| # | Use Case | Implementation File | Key Features Demonstrated |
| :-: | :--- | :--- | :--- |
| **1** | **E-Commerce Saga Orchestration** | [`usecase-1-ecommerce-saga.ts`](src/workflow/usecases/usecase-1-ecommerce-saga.ts) | Spec validation, `onFail` retry with exponential backoff, compensating actions, context accumulation |
| **2** | **AI / LLM & RAG Pipelines** | [`usecase-2-ai-rag-pipeline.ts`](src/workflow/usecases/usecase-2-ai-rag-pipeline.ts) | Claim-check pointers, chunking, deterministic caching with `.cache(60000)` to avoid redundant LLM embedding costs |
| **3** | **Financial Transaction & Fraud** | [`usecase-3-financial-fraud-detection.ts`](src/workflow/usecases/usecase-3-financial-fraud-detection.ts) | Strict `spec` contracts, idempotent deduplication, ML risk scoring, double-entry ledger booking |
| **4** | **Media Transcoding & Assets** | [`usecase-4-media-transcoding.ts`](src/workflow/usecases/usecase-4-media-transcoding.ts) | S3 claim-check pointers, native `AbortSignal` cancellation support, multi-variant transcoding, CDN warm-up |
| **5** | **IoT Ingestion & Anomaly Detection** | [`usecase-5-iot-telemetry-anomaly.ts`](src/workflow/usecases/usecase-5-iot-telemetry-anomaly.ts) | Data normalization via `spec` transformer (Fahrenheit to Celsius, PSI to Bar), real-time anomaly detection, cold storage partitioning |
| **6** | **CDC & Data Lakehouse ETL** | [`usecase-6-cdc-lakehouse-etl.ts`](src/workflow/usecases/usecase-6-cdc-lakehouse-etl.ts) | Schema `translator` (snake_case DB columns to analytical schema), LSN deduplication, dimension enrichment, Iceberg/Parquet sink |
| **7** | **KYC & Customer Onboarding** | [`usecase-7-kyc-onboarding.ts`](src/workflow/usecases/usecase-7-kyc-onboarding.ts) | PII datastore encryption, multi-service orchestration (OCR + biometrics + OFAC watchlist), resilient external API retries |
| **8** | **Healthcare FHIR Clinical Events** | [`usecase-8-healthcare-fhir.ts`](src/workflow/usecases/usecase-8-healthcare-fhir.ts) | Standard FHIR spec validation, HIPAA PII de-identification (pseudonymous hashes), W3C OpenTelemetry `traceparent` propagation, STAT emergency alerting |
| **9** | **Omnichannel Notification Engine** | [`usecase-9-omnichannel-notifications.ts`](src/workflow/usecases/usecase-9-omnichannel-notifications.ts) | Dynamic routing slip, personalized template rendering, HTTP 429 gateway retry backoff, channel failover (PUSH -> SMS/EMAIL) |
| **10** | **SecOps & Auto-Remediation** | [`usecase-10-secops-remediation.ts`](src/workflow/usecases/usecase-10-secops-remediation.ts) | Safe lifecycle execution via `onBefore` maintenance lock verification, root cause correlation, automated node cordoning, Slack post-mortem dispatch |

---

## Project Structure

```
test-project/
├── docker-compose.yml              # Starts authenticated Redis and MongoDB containers
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── database/
    │   ├── redis.ts                # Redis client adapter (live URL or in-memory fallback)
    │   └── mongodb.ts              # MongoDB client adapter (live URI or in-memory fallback)
    ├── plugin/
    │   └── redis-mongo-storage.ts  # Storage hook implementation for fluid-func
    ├── workflow/
    │   ├── order-pipeline.ts       # Original base e-commerce order pipeline
    │   └── usecases/               # Top 10 Event-Driven Use Cases implementation
    │       ├── index.ts            # Barrel export for all 10 use case pipelines
    │       ├── usecase-1-ecommerce-saga.ts
    │       ├── usecase-2-ai-rag-pipeline.ts
    │       ├── usecase-3-financial-fraud-detection.ts
    │       ├── usecase-4-media-transcoding.ts
    │       ├── usecase-5-iot-telemetry-anomaly.ts
    │       ├── usecase-6-cdc-lakehouse-etl.ts
    │       ├── usecase-7-kyc-onboarding.ts
    │       ├── usecase-8-healthcare-fhir.ts
    │       ├── usecase-9-omnichannel-notifications.ts
    │       └── usecase-10-secops-remediation.ts
    ├── index.ts                    # Executable demo script running all 10 use cases
    ├── index.test.ts               # Storage plugin & base order pipeline test suite
    └── usecases.test.ts            # Full integration test suite for all 10 use cases
```

---

## Running the Demo & Test Suites

### Zero-Daemon Mode (In-Memory Fallback - Zero Setup Required)

```bash
# Run the demo showcasing all 10 use cases and storage integration
npm start

# Run the complete automated test suite (all 12 integration tests)
npm test

# Run use cases test suite specifically
npm run test:usecases
```

### Live Docker Services Mode (Optional)

To run against live authenticated containers:

```bash
# 1. Start Docker containers
docker compose up -d

# 2. Run demo against live containers
REDIS_URL="redis://:redispassword@localhost:6379" \
MONGODB_URI="mongodb://admin:mongopassword@localhost:27017/fluid_func_db?authSource=admin" \
npm start

# 3. Run tests against live containers
REDIS_URL="redis://:redispassword@localhost:6379" \
MONGODB_URI="mongodb://admin:mongopassword@localhost:27017/fluid_func_db?authSource=admin" \
npm test
```
