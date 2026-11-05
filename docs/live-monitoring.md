# Live Monitoring & DevTools

Follow [Serve a REST Endpoint and Watch It Run Live](rest-and-live-monitoring.md) for a runnable Express checkout with HTTP requests, live events, and failure inspection.

`Siglo` provides complete real-time live monitoring, dynamic DAG topology visualization, execution state diff inspection, and interactive DevTools for complex asynchronous workflows.

Unlike black-box execution engines, `Siglo` streams structured, strongly-typed execution events directly from the workflow engine without imposing runtime overhead or coupling your business logic to third-party proprietary services.

---

## 1. Architecture & Observability Layers

```
                           +---------------------------+
                           |    Siglo Workflow Run     |
                           +-------------+-------------+
                                         |
                                         v
                    +--------------------+--------------------+
                    | Workflow Event Bus / Monitoring Adapter |
                    +--------------------+--------------------+
                                         |
                 +-----------------------+-----------------------+
                 |                                               |
                 v (SSE / WebSocket)                             v (Prometheus / APM)
    +------------+------------+                     +------------+------------+
    |   React DevTools UI     |                     |  Production Telemetry   |
    | - Live DAG Visualizer   |                     | - Prometheus Metrics    |
    | - Context Diff Viewer   |                     | - Grafana Dashboards    |
    | - Latency Waterfall     |                     | - Multi-Worker Pub/Sub  |
    | - Interactive Resume    |                     | - OpenTelemetry Traces  |
    | - Replay Trigger        |                     |                         |
    +-------------------------+                     +-------------------------+
```

Observability is divided into three layers:
1. **Event Infrastructure (`@siglo/core`)**: Standardized typed execution events and zero-overhead `WorkflowEventEmitter` in the core runtime.
2. **Streaming Transports & React UI (`@siglo/monitor`)**: Built-in Server-Sent Events (SSE), WebSocket protocol, Redis pub/sub, telemetry ingestion API (`POST /api/events`), and a self-contained **React 18 + Vite + Tailwind CSS** DevTools Single Page Application (SPA).
3. **Developer & Production Telemetry**: CLI Dev Server (`siglo monitor`), Express/Fastify/Hono middlewares, Prometheus exposition (`/metrics`), and pre-packaged Grafana dashboard templates.

---

## 2. Standardized Execution Events

Workflows emit 14 typed lifecycle events during execution:

| Event Type | Payload Fields | Emitted When |
|---|---|---|
| `flow:start` | `stackId`, `flowName`, `version`, `ast`, `timestamp`, `namespace` | A workflow begins execution |
| `step:start` | `stackId`, `stepId`, `stepName`, `attempt`, `timestamp`, `namespace` | A step begins its action phase |
| `step:complete` | `stackId`, `stepId`, `stepName`, `durationMs`, `outputSummary`, `timestamp` | A step succeeds and merges output |
| `step:retry` | `stackId`, `stepId`, `stepName`, `attempt`, `maxAttempts`, `error`, `delayMs` | A failed step triggers a scheduled retry |
| `step:error` | `stackId`, `stepId`, `stepName`, `attempt`, `error`, `timestamp` | A step fails definitively |
| `step:skipped` | `stackId`, `stepId`, `stepName`, `timestamp` | A step is skipped via `onBefore` condition |
| `context:change` | `stackId`, `stepId`, `field`, `value`, `timestamp`, `namespace` | A context field is mutated or set |
| `cache:hit` | `stackId`, `stepId`, `key`, `timestamp`, `namespace` | A cached step output is retrieved |
| `cache:miss` | `stackId`, `stepId`, `key`, `timestamp`, `namespace` | Cache lookup missed; step will execute |
| `checkpoint:save` | `stackId`, `status`, `timestamp`, `namespace` | State snapshot persisted to storage adapter |
| `flow:suspended` | `stackId`, `waitingForEvent`, `timeoutMs`, `timestamp` | Workflow paused waiting for an event |
| `flow:resumed` | `stackId`, `correlationKey`, `eventName`, `timestamp` | Suspended workflow unblocked and resumed |
| `flow:complete` | `stackId`, `status`, `durationMs`, `error`, `timestamp` | Workflow successfully finished |
| `flow:error` | `stackId`, `error`, `timestamp`, `namespace` | Workflow terminated due to fatal error |

### Subscribing to Events Programmatically

Use `WorkflowEventEmitter` from `@siglo/core`:

```typescript
import { Step, flow, WorkflowEventEmitter } from '@siglo/core';

const monitor = new WorkflowEventEmitter();

// Listen to specific events
monitor.on('step:start', (ev) => {
    console.log(`Starting step ${ev.stepName} (attempt ${ev.attempt})`);
});

monitor.on('step:retry', (ev) => {
    console.warn(`Retrying step ${ev.stepName} in ${ev.delayMs}ms. Error: ${ev.error.message}`);
});

// Wildcard listener receives all execution events
monitor.on('*', (ev) => {
    console.log(`[Event: ${ev.type}] stackId=${ev.stackId}`);
});

const myFlow = flow(
    Step.create('fetchData', async () => ({ count: 10 })),
    Step.create('processData', async (ctx) => ({ total: ctx.count * 2 }))
).monitor(monitor);

await myFlow.run({});
```

---

## 3. Global Monitoring & Static Hooks

You can register a global default monitor for all workflows executed within an application process:

```typescript
import { Step, WorkflowEventEmitter } from '@siglo/core';

const globalMonitor = new WorkflowEventEmitter();
globalMonitor.on('flow:error', (ev) => {
    reportToAlertingSystem(ev);
});

// Sets default monitor for all Step.start() and flow().run() calls
Step.setDefaultMonitor(globalMonitor);
```

To retrieve or remove the default monitor:
```typescript
const current = Step.getDefaultMonitor();
Step.setDefaultMonitor(undefined);
```

---

## 4. Real-Time DevTools Web Dashboard (`@siglo/monitor`)

Install `@siglo/monitor`:

```bash
npm install @siglo/monitor @siglo/core
```

### Launching the Dashboard Server

```typescript
import { createMonitorServer } from '@siglo/monitor';
import { Step, flow } from '@siglo/core';

const monitor = await createMonitorServer({
    port: 4000,
    host: '0.0.0.0'
});

console.log(`DevTools available at http://localhost:${monitor.port}`);

// Register monitor with your workflows
Step.setDefaultMonitor(monitor.emitter);
```

### Modern React 18 DevTools Features

The web dashboard is an interactive, zero-dependency Single Page Application (SPA) built with React 18, Vite, and Tailwind CSS. It embeds the Siglo brand logo and favicon, and delivers rich real-time tooling:

1. **Interactive DAG Topology**: Rendered dynamically from workflow AST (`flow.toJSON()`).
   - Node status states: ⚪ **Pending**, 🔵 **Running** (with subtle pulse animation), 🟢 **Completed**, 🔴 **Failed**, 🟡 **Suspended**.
   - Attempt badges (`#1`, `#2`) displaying retry counts.
   - Node inspector slideover showing execution duration, step inputs, and error details when a node is clicked.
2. **Step Latency Waterfall Timeline**:
   - Visual duration bars showing exact execution time and offset relative to the total workflow duration.
   - Highlights bottlenecks and retried steps at a glance.
3. **Context & State Diff Inspector**:
   - Monospace syntax-highlighted JSON viewer.
   - Displays initial input context, final state, and an audit trail of granular field mutations (`context:change`).
   - One-click copy to clipboard.
4. **Live Events Feed**:
   - Chronological real-time stream of all 14 execution events.
   - Filter by event type (`step:start`, `step:retry`, `context:change`, etc.).
   - Expandable raw event JSON payloads.
5. **Interactive Durable Resumption**:
   - Built-in resumption modal for workflows suspended on `waitForEvent()`.
   - Submit signal event name and JSON payload directly from the browser to resume execution.
6. **Workflow Replay**:
   - One-click replay button to re-trigger recorded workflow runs with initial input context.
7. **Search & Multi-Tenant Isolation**:
   - Search runs by flow name, stack ID, or namespace.
   - Filter by execution status (`ALL`, `RUNNING`, `SUSPENDED`, `FAILED`, `COMPLETED`).
   - Multi-tenant dropdown to isolate telemetry to a specific `$namespace`.

---

## 5. Attaching Workflows to Running Monitor Servers

Instead of creating a new HTTP server in every script or test, workflows can attach to a monitor server that is **already running** (e.g., started via `siglo monitor` CLI, running in another container, or started once during service bootstrap).

### Scenario A: Remote / Separate Process (CLI or Dedicated Server)

When your monitor server is running in a different process (such as `siglo monitor --port 4000` in another terminal or Docker):

```typescript
import { flow, Step } from '@siglo/core';
import { attachToMonitorServer } from '@siglo/monitor';

const myWorkflow = flow(
    Step.create('fetchOrder', async () => ({ orderId: 'ord_123', total: 100 })),
    Step.create('chargeCustomer', async (ctx) => ({ paid: true }))
).monitor(attachToMonitorServer('https://monitor.corp.internal:4000', {
    apiKey: process.env.MONITOR_API_KEY
}));
// or local dev: .monitor(attachToMonitorServer(4000));

await myWorkflow.run();
```

`attachToMonitorServer` automatically creates an asynchronous non-blocking HTTP telemetry dispatcher pointing to `POST /api/events`. Workflow execution is never delayed or blocked, and errors (such as a temporary network disconnect) are handled gracefully in the background.

### Scenario B: Same Process (In-Memory Singleton / App Bootstrap)

If your application boots the monitor server once at startup, other modules and workflows can attach directly without creating duplicate HTTP ports:

```typescript
import { createMonitorServer, attachToMonitorServer, getMonitorEmitter } from '@siglo/monitor';
import { flow, Step } from '@siglo/core';

// In server bootstrap (e.g. server.ts):
const monitor = await createMonitorServer({
    port: 4000,
    reuseExisting: true // Reuses existing instance instead of throwing EADDRINUSE
});

// In any workflow file:
const orderPipeline = flow(stepA, stepB)
    .monitor(attachToMonitorServer()); // Auto-resolves the active in-process server
```

You can also retrieve the active server or its emitter directly:

```typescript
import { getActiveMonitorServer, getMonitorEmitter } from '@siglo/monitor';

// Get active server instance
const activeServer = getActiveMonitorServer();

// Or get its WorkflowEventEmitter directly
const emitter = getMonitorEmitter();
const orderPipeline = flow(stepA, stepB).monitor(emitter!);
```

### Scenario C: High-Throughput Buffered Client

For high-throughput worker fleets, serverless functions, or background queues pushing events to a central monitor server, use `createMonitorClient` to configure event batching, authentication, and flush intervals:

```typescript
import { createMonitorClient } from '@siglo/monitor';
import { flow, Step } from '@siglo/core';

const client = createMonitorClient({
    url: 'https://monitor-service:4000',
    apiKey: process.env.MONITOR_INGESTION_KEY,
    batchSize: 20,          // Flush when 20 events accumulate
    flushIntervalMs: 50,    // Or flush every 50ms
    maxQueueSize: 1000,     // Drop oldest events if buffer exceeds 1000 items
    redaction: {
        redactKeys: ['password', 'creditCard']
    }
});

const workerFlow = flow(stepA, stepB).monitor(client.monitor);
await workerFlow.run();

// Clean up or flush remaining events on shutdown
await client.close();
```

---

## 6. CLI Dev Server Integration

With `@siglo/cli`, launch the live monitor server directly from your terminal:

```bash
# Start monitor on default port 4000
siglo monitor

# Specify custom port, host, and optional workflow file to inspect
siglo monitor src/workflows/checkout.ts --port=8080 --host=127.0.0.1 --namespace=production
```

Terminal output:
```text
🚀 Siglo Live Monitor running at http://127.0.0.1:8080
   - Dashboard: http://127.0.0.1:8080/
   - SSE Stream: http://127.0.0.1:8080/events
   - WebSocket: ws://127.0.0.1:8080/ws
   - Prometheus Metrics: http://127.0.0.1:8080/metrics
```

---

## 7. Web Framework Middlewares

Embed the live monitoring UI and telemetry endpoints directly into your existing HTTP applications:

### Express

```typescript
import express from 'express';
import { createExpressMonitorMiddleware } from '@siglo/monitor';
import { Step } from '@siglo/core';

const app = express();
const monitor = createExpressMonitorMiddleware();

// Mounts UI, /events, and /api endpoints under /_siglo
app.use('/_siglo', monitor);
Step.setDefaultMonitor(monitor.emitter);

app.listen(3000, () => {
    console.log('Monitor dashboard available at http://localhost:3000/_siglo');
});
```

### Fastify

```typescript
import Fastify from 'fastify';
import { fastifyMonitorPlugin } from '@siglo/monitor';

const fastify = Fastify();

await fastify.register(fastifyMonitorPlugin, { prefix: '/_siglo' });
await fastify.listen({ port: 3000 });
```

### Hono

```typescript
import { Hono } from 'hono';
import { honoMonitorMiddleware } from '@siglo/monitor';

const app = new Hono();

app.use('/_siglo/*', honoMonitorMiddleware());
```

---

## 8. Distributed Transports & Streaming

### Server-Sent Events (SSE)
Clients can subscribe to lightweight, one-way event feeds over standard HTTP with automated keep-alive heartbeats:

```bash
curl -N http://localhost:4000/events?namespace=tenant_alpha
```

SSE message format:
```http
event: step:complete
data: {"type":"step:complete","stackId":"s1","stepId":"st1","stepName":"chargeCard","durationMs":42,"timestamp":1730419200000}
```

In browser JavaScript:
```javascript
const es = new EventSource('http://localhost:4000/events');

es.addEventListener('flow:start', (e) => {
    console.log('Flow started:', JSON.parse(e.data));
});

es.addEventListener('step:complete', (e) => {
    console.log('Step finished:', JSON.parse(e.data));
});
```

### WebSockets (RFC 6455)
Connect via WebSocket on `/ws` for bi-directional communication and remote controls:

```javascript
const ws = new WebSocket('ws://localhost:4000/ws');

// Filter to a specific tenant
ws.send(JSON.stringify({ action: 'subscribe', namespace: 'eu-west' }));

// Resume a suspended workflow
ws.send(JSON.stringify({
    action: 'resume',
    stackId: 'stk_abc123',
    eventName: 'kyc.approved',
    payload: { verifiedBy: 'compliance-officer' }
}));
```

### Distributed Redis Pub/Sub
For distributed clusters where workflows execute across multiple serverless functions or worker nodes:

```typescript
import { RedisMonitoringAdapter, createMonitorServer } from '@siglo/monitor';
import { WorkflowEventEmitter } from '@siglo/core';
import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// 1. In Worker Process: Publish events to Redis
const publisher = new Redis(redisUrl);
const workerAdapter = new RedisMonitoringAdapter({
    publisher,
    channel: 'siglo:monitor:events'
});

emitter.on('*', (event) => {
    workerAdapter.publish(event);
});

// 2. In Central Monitor Server: Subscribe to Redis and deliver into server's emitter
const subscriber = new Redis(redisUrl);
const monitor = await createMonitorServer({ port: 4000 });

const serverAdapter = new RedisMonitoringAdapter({
    subscriber,
    channel: 'siglo:monitor:events',
    emitter: monitor.emitter // Automatically routes incoming Redis events to monitor store & SSE
});
```

---

## 9. Production Telemetry: Prometheus & Grafana

`@siglo/monitor` includes a built-in Prometheus metrics exposition endpoint on `/metrics`.

### Exposed Metrics

```text
# HELP siglo_active_flows Current number of actively running workflows.
# TYPE siglo_active_flows gauge
siglo_active_flows 3

# HELP siglo_flow_executions_total Total number of workflow executions completed or failed.
# TYPE siglo_flow_executions_total counter
siglo_flow_executions_total{status="completed"} 142
siglo_flow_executions_total{status="failed"} 2

# HELP siglo_flow_duration_seconds Total execution time of workflows in seconds.
# TYPE siglo_flow_duration_seconds summary
siglo_flow_duration_seconds_sum 18.4200
siglo_flow_duration_seconds_count 144

# HELP siglo_step_retries_total Total count of step execution retries.
# TYPE siglo_step_retries_total counter
siglo_step_retries_total 5

# HELP siglo_steps_total Total count of step completions and failures.
# TYPE siglo_steps_total counter
siglo_steps_total{status="completed"} 432
siglo_steps_total{status="failed"} 2
```

### Pre-Configured Grafana Dashboard
Import the JSON dashboard template located at:
`monitoring/grafana/provisioning/dashboards/siglo-live-monitoring.json` (or `node_modules/@siglo/monitor/grafana/siglo-live-monitoring.json`).

Panels include:
- Active workflows gauge
- Total completed and failed flow counters
- Step retries counter
- Workflow execution duration time-series graph
- Step throughput breakdown

---

## 10. Security, Authentication & Production Hardening

Deploying `@siglo/monitor` in remote environments requires hardening to protect runtime state and prevent unauthorized access:

### 10.1 API Key & Token Authentication
Protect all endpoints with scoped API keys:

```typescript
const monitor = await createMonitorServer({
    port: 4000,
    auth: {
        ingestionKey: 'worker-token-xyz', // Authorizes POST /api/events
        adminKey: 'admin-token-abc',       // Authorizes /resume, /replay, /api/workflows
    }
});
```

Clients pass the key using standard authorization:
```typescript
const client = attachToMonitorServer('https://monitor.corp.internal:4000', {
    apiKey: 'worker-token-xyz'
});
```

Web UI and SSE clients authenticate via `Authorization: Bearer <token>`, `X-API-Key: <token>`, or URL parameter `?token=<token>`.

### 10.2 Disabling Remote Control in Sensitive Environments
In production environments, interactive workflow resumption (`/resume`) and replays (`/replay`) can be disabled entirely to enforce zero-trust immutability:

```typescript
const monitor = await createMonitorServer({
    allowRemoteResume: false // Rejects resume and replay requests with 403 Forbidden
});
```

### 10.3 CORS Hardening
Prevent browser-based intranet CSRF by restricting access to explicit trusted origins:

```typescript
const monitor = await createMonitorServer({
    cors: {
        origin: ['https://devtools.internal.corp', 'http://localhost:3000'],
        credentials: true
    }
});
```

### 10.4 Ingestion Limits & Memory Protection
- **Payload Size Caps**: Requests exceeding `maxPayloadBytes` (default: 1MB) receive `413 Payload Too Large` and are immediately aborted.
- **Bounded Client Buffer**: Remote clients automatically evict oldest events if the queue reaches `maxQueueSize` (default: 1000), preventing worker memory leaks during network downtime.

### 10.5 Network Egress Policy Compliance
When workflows enforce least-privilege network egress using Siglo's ASL Network Egress Policy, ensure the remote monitor host is whitelisted:

```typescript
const orderFlow = flow(stepA, stepB)
    .networkPolicy({
        defaultPolicy: 'deny',
        allowedHosts: ['api.stripe.com', 'monitor.internal.corp']
    })
    .monitor(attachToMonitorServer('https://monitor.internal.corp:4000', {
        apiKey: process.env.MONITOR_KEY
    }));
```

### 10.6 Context Redaction & Multi-Tenancy
Automatic redaction masks sensitive credentials (`password`, `token`, `secret`, `apikey`, etc.) with `[REDACTED]`. Custom hooks can be provided via `redaction.redactHook`. Workflows configured with `{ namespace: 'tenant_id' }` emit events isolated to their tenant partition.

---

## 11. REST API Reference

The monitor server exposes standard REST endpoints for telemetry ingestion and DevTools control:

| Method | Endpoint | Description | Auth Scope |
|---|---|---|---|
| `GET` | `/` or `/index.html` | Serves the single-page React DevTools dashboard | Public / Browser |
| `GET` | `/events` | Server-Sent Events (SSE) stream (`?namespace=...`) | `read` |
| `POST` | `/api/events` | Ingests telemetry events from external processes / clients | `ingest` |
| `GET` | `/metrics` | Prometheus metrics exposition endpoint | `read` |
| `GET` | `/api/workflows` | List recorded workflow runs (`?namespace=...&status=...`) | `read` |
| `GET` | `/api/workflows/:stackId` | Get detailed execution run, steps, and context diff | `read` |
| `POST` | `/api/workflows/:stackId/resume` | Resume a suspended workflow (`{ eventName, payload }`) | `control` |
| `POST` | `/api/workflows/:stackId/replay` | Trigger replay of a recorded workflow | `control` |

---

## 12. Dashboard UI Architecture (`packages/monitor/ui`)

The live monitor web interface source code is located in [`packages/monitor/ui`](../packages/monitor/ui) and follows an industry-standard React project structure:

- **React 18** with TypeScript and functional hooks
- **Vite** with `vite-plugin-singlefile` bundling
- **Tailwind CSS** for dark-mode styling
- **Lucide React** icons
- **Zero External Runtime CDN Dependencies**: Fully inlined into `packages/monitor/src/ui/dashboard.ts` via build script (`embed-html.js`).

### UI Directory Structure

```text
packages/monitor/ui/
├── src/
│   ├── api/workflowApi.ts             # REST client for workflow fetch, resume, and replay
│   ├── constants/                     # Event types and status filter constants
│   ├── hooks/                         # useWorkflowMonitor (SSE & state sync), useClipboard
│   ├── types/                         # TypeScript interfaces for workflows and events
│   ├── utils/formatters.ts            # Time, duration, ID, and JSON formatters
│   ├── components/
│   │   ├── ui/                        # Reusable atoms (StatusBadge, Modal, EmptyState)
│   │   ├── layout/Header.tsx          # Navigation header with Siglo logo & live status
│   │   └── workflows/                 # Feature components
│   │       ├── RunList/               # Left sidebar workflow run selector & search
│   │       ├── Dag/                   # Interactive DAG graph visualizer
│   │       ├── Waterfall/             # Step latency waterfall chart
│   │       ├── Context/               # Context state & mutation diff inspector
│   │       ├── Events/                # Live streaming telemetry log
│   │       ├── ResumeModal/           # Signal resumption modal
│   │       ├── Stats/                 # High-level metrics KPI grid
│   │       └── WorkflowDetail.tsx     # Tabbed execution details container
│   ├── App.tsx                        # Root application layout
│   └── main.tsx                       # React DOM entrypoint
├── scripts/embed-html.js              # Inlines dist/index.html into src/ui/dashboard.ts
└── vite.config.ts
```

### Developing & Building the UI

```bash
# Run Vite dev server with proxy to backend port 4000
npm run dev:ui --workspace=@siglo/monitor

# Build production bundle and embed into dashboard.ts
npm run build:ui --workspace=@siglo/monitor
```
