# Zero-Code APM Dashboards for `Rivulet`

> Turnkey OpenTelemetry observability stack for `Rivulet` workflows with **Jaeger**, **Grafana**, and **Prometheus**.
> Visualize step latencies, retries, saga rollbacks, and distributed parent-child calls across services immediately without building custom UI components.

---\

## ⚡ Quickstart

### 1. Start the APM Infrastructure (Docker Compose)

Launch Jaeger All-In-One, Grafana, and Prometheus:

```bash
cd monitoring
docker compose up -d
```

| Service | URL | Credentials / Notes |
|---|---|---|
| **Jaeger Tracing UI** | [http://localhost:16686](http://localhost:16686) | Distributed trace waterfalls & DAG visualization |
| **Grafana Dashboard** | [http://localhost:3000](http://localhost:3000) | `admin` / `admin` (pre-provisioned with Jaeger) |
| **Prometheus Metrics** | [http://localhost:9090](http://localhost:9090) | Metric scrape targets |
| **OTLP HTTP Receiver** | `http://localhost:4318/v1/traces` | Standard OpenTelemetry ingest endpoint |

> **Note**: Even if Docker is not currently running, the demo scripts will still execute cleanly and display full color-coded trace waterfalls directly in your terminal!

---

### 2. Run the APM Demonstration

Execute all 4 scenarios in sequence:

```bash
npm run demo
```

Or run individual scenarios:

```bash
npm run demo:latencies    # Scenario 1: Step Latencies & Parallel Fan-Out
npm run demo:retries      # Scenario 2: Retries, Backoff & Attempt Spans
npm run demo:sagas        # Scenario 3: Saga Failure & LIFO Compensations
npm run demo:distributed  # Scenario 4: Cross-Service Parent-Child Tracing (W3C)
```

---

### 3. Run Automated APM Verification Tests

```bash
npm test
```

---

## 🔍 Visualizing the 4 Scenarios in Jaeger & Grafana

### Scenario 1: Step Latencies & Parallel Fan-Out
- **Service in Jaeger**: `order-service`
- **What it shows**:
  - The root `workflow:OrderFulfillmentPipeline` span wraps the entire execution.
  - Sequential steps (`step:validateOrder` 30ms, `step:enrichCustomer` 40ms) run in series.
  - The `step:parallel` combinator executes 3 branches concurrently (`checkInventory` 75ms, `performRiskAssessment` 90ms, `fetchPricingRules` 50ms), showing stacked concurrent bars in the waterfall.
  - Final step `step:generateInvoice` runs after all parallel branches join.

```
workflow:OrderFulfillmentPipeline [==================================================] (205ms)
  ├── step:validateOrder          [======]                                            (30ms)
  ├── step:enrichCustomer                [========]                                   (40ms)
  ├── step:parallel                               [===================]               (93ms)
  │     ├── checkInventory                        [===============]                   (75ms)
  │     ├── performRiskAssessment                 [===================]               (90ms)
  │     └── fetchPricingRules                     [==========]                        (50ms)
  └── step:generateInvoice                                            [=====]         (25ms)
```

---

### Scenario 2: Retries, Exponential Backoff & Attempt Spans
- **Service in Jaeger**: `billing-service`
- **What it shows**:
  - Transient network failures during `chargeCreditCard` produce distinct attempt spans:
    - `step:chargeCreditCard` (attempt 1 &rarr; ❌ `ERROR`, records `503 UpstreamGatewayTimeout`)
    - `step:chargeCreditCard (retry #2)` (attempt 2 &rarr; ❌ `ERROR`, records `503 UpstreamGatewayTimeout`)
    - `step:chargeCreditCard (retry #3)` (attempt 3 &rarr; ✅ `OK`, payment captured)
  - Spans include the attribute `rivulet.step.attempt: 3` and exception stack traces attached directly to failed spans.

---

### Scenario 3: Sagas & LIFO Compensation Rollbacks
- **Service in Jaeger**: `travel-booking-service`
- **What it shows**:
  - `step:reserveHotelRoom` and `step:chargeTravelerCard` succeed.
  - `step:bookFlightSeat` fails with `AirlineInventoryExhausted``.
  - The root workflow span is marked `SpanStatusCode.ERROR` with the exception event attached.
  - **Compensations run automatically in reverse (LIFO) order**:
    1. `compensation:refundPayment` (refunds $450)
    2. `compensation:releaseHotelRoom` (releases room reservation)
  - Both rollback actions are captured as spans with `saga.action: rollback` attributes, giving full auditability of the undo sequence.

---

### Scenario 4: Cross-Service Parent-Child Tracing (W3C Propagation)
- **Services in Jaeger**: `checkout-api` & `warehouse-worker`
- **What it shows**:
  - **Service A (`checkout-api`)**: Validates the checkout and calls `injectTraceContext(headers)` to write standard W3C `traceparent` headers into an event or queue payload.
  - **Service B (`warehouse-worker`)**: Receives the payload, calls `extractTraceContext(headers)`, and runs `WarehouseFulfillmentFlow` inside the extracted context.
  - **In Jaeger**: Searching for the trace displays a single end-to-end distributed waterfall across **both** services under one unified `traceId`!

---

## 🌐 Connecting to External APM Providers

Because this setup uses the standard OpenTelemetry SDK and OTLP exporter, you can stream traces to any cloud APM backend without code changes simply by setting environment variables:

### Honeycomb
```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.honeycomb.io"
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=<YOUR_API_KEY>"
npm run demo
```

### Datadog
Point to a local Datadog Agent with OTLP ingest enabled on port 4318:
```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318/v1/traces"
npm run demo
```

### Grafana Cloud / Tempo
```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://otlp-gateway-prod-us-east-0.grafana.net/otlp"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <BASE64_INSTANCE_ID_AND_TOKEN>"
npm run demo
```

---

## 📁 Folder Structure

```
monitoring/
├── README.md                              # This guide
├── docker-compose.yml                     # Jaeger, Grafana, and Prometheus containers
├── prometheus.yml                         # Prometheus scrape targets
├── grafana/
│   └── provisioning/
│       ├── datasources/datasources.yaml   # Auto-provisioned Jaeger & Prometheus datasources
│       └── dashboards/
│           ├── dashboards.yaml            # Dashboard provider configuration
│           └── rivulet-overview.json   # Pre-built APM dashboard
├── package.json                           # Scripts and OTel dependencies
├── tsconfig.json                          # TypeScript configuration
└── src/
    ├── tracer.ts                          # OpenTelemetry NodeTracerProvider & visualizer
    ├── scenarios/
    │   ├── 1-step-latencies.ts            # Scenario 1: Duration waterfalls & parallel fan-out
    │   ├── 2-retries.ts                   # Scenario 2: Retries, backoff, and attempt spans
    │   ├── 3-saga-rollback.ts             # Scenario 3: Sagas & LIFO compensation rollbacks
    │   └── 4-distributed-calls.ts         # Scenario 4: Distributed W3C traceparent propagation
    ├── index.ts                           # Master demonstration runner
    └── apm.test.ts                        # Automated test suite
```
