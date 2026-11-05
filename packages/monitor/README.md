# @siglo/monitor

> Real-time workflow telemetry server, modern React DevTools web dashboard, SSE/WebSocket streaming, and Prometheus metrics exporter for [Siglo](https://github.com/jsoftgem/siglo) workflows.

[![npm version](https://img.shields.io/npm/v/@siglo/monitor.svg)](https://www.npmjs.com/package/@siglo/monitor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 1. Overview

`@siglo/monitor` provides complete runtime observability, telemetry, and interactive developer tooling for `Siglo` workflows. It captures fine-grained execution events (`flow:start`, `step:start`, `step:complete`, `step:retry`, `step:error`, `step:skipped`, `flow:suspended`, `flow:resumed`, `context:change`, etc.) and streams them to a modern **React 18 + Vite + Tailwind CSS** DevTools dashboard, Server-Sent Events (SSE) clients, WebSockets, or distributed Redis pub/sub channels.

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
                 v (SSE / WebSocket)                             v (Prometheus / Metrics)
    +------------+------------+                     +------------+------------+
    |   React DevTools UI     |                     |  Production Telemetry   |
    | - Live DAG Visualizer   |                     | - Prometheus Metrics    |
    | - Context Diff Viewer   |                     | - Grafana Dashboards    |
    | - Latency Waterfall     |                     | - Multi-Worker Pub/Sub  |
    | - Interactive Resume    |                     |                         |
    +-------------------------+                     +-------------------------+
```

### Key Capabilities

- ⚛️ **Modern React DevTools UI**: Built with React 18, Vite, and Tailwind CSS. Packaged as a self-contained, zero-dependency SPA with no external CDN or asset server required at runtime.
- 🔗 **Flexible Attachment**: Attach workflows to a newly created server, an active in-process server, or a remotely running server (e.g. started via CLI `siglo monitor`).
- 🗺️ **Interactive DAG Topology**: Dynamic visual representation of workflow steps, live execution states (pulsing running state, completed, failed, suspended), attempt counts, and step details inspector.
- ⏱️ **Latency Waterfall Timeline**: Visual duration breakdown of each step relative to total execution time with attempt indicators.
- 🔍 **Context & State Diff Inspector**: Syntax-highlighted JSON viewer tracking state mutations, initial input, and diff history with one-click clipboard copying.
- ⚡ **Interactive Durable Resumption**: Resume suspended workflows (`waitForEvent`) directly from the web UI with custom signal event names and JSON payloads.
- 🔄 **Replay Workflows**: Trigger execution replays directly from the dashboard or REST endpoints.
- 📡 **Multi-Transport Streaming**: Native Server-Sent Events (SSE) and RFC 6455 WebSockets with automatic reconnection, heartbeat pings, and connection tracking.
- 📊 **Prometheus Telemetry**: Standard `/metrics` endpoint exporting active flow gauges, completion counters, execution summaries, and step retry counters.
- 📈 **Pre-Packaged Grafana Dashboard**: Ready-to-import Grafana JSON template (`grafana/siglo-live-monitoring.json`).
- 🛡️ **Automated Data Redaction**: Automatic masking of sensitive fields (`password`, `token`, `secret`, `apiKey`) and tenant-isolated `$namespace` filtering.
- 🔌 **Framework Middlewares**: One-line integration for Express, Fastify, and Hono applications.

---

## 2. Installation

```bash
npm install @siglo/monitor @siglo/core
```

For developer CLI commands (`siglo monitor`):
```bash
npm install --save-dev @siglo/cli
```

---

## 3. Quick Start: Standalone Dev Server

Start a standalone monitor server and attach it to your workflow runs:

```typescript
import { Step, flow } from '@siglo/core';
import { createMonitorServer } from '@siglo/monitor';

async function main() {
    // 1. Launch monitor server on port 4000
    const monitor = await createMonitorServer({
        port: 4000,
        host: '0.0.0.0'
    });

    console.log(`Live DevTools available at: http://localhost:${monitor.port}`);

    // 2. Define workflow steps
    const fetchUser = Step.create('fetchUser', async () => ({ id: 'usr_100', name: 'Alice' }));
    const chargeCard = Step.create('chargeCard', async (ctx) => {
        return { charged: true, amount: 49.99 };
    });

    const orderPipeline = flow(fetchUser, chargeCard)
        .monitor(monitor.emitter); // Attach live monitoring

    // 3. Execute workflow
    await orderPipeline.run({ orderId: 'ord_999' });
}

main();
```

Open `http://localhost:4000` in your browser to inspect the interactive DAG, step latency waterfall, state diffs, and live event log in real time.

---

## 4. Attaching to an Already Running Monitor Server

Instead of spinning up a new HTTP server every time, workflows can attach to a monitor server that is **already running** (e.g. launched via the CLI `npm exec --package=@siglo/cli -- siglo monitor`, in a Docker container, or started once at application bootstrap).

### Scenario A: Remote / Separate Process (CLI or Dedicated Server)

When your monitor server is running in a different process (such as `npm exec --package=@siglo/cli -- siglo monitor --port 4000` in another terminal):

```typescript
import { flow } from '@siglo/core';
import { attachToMonitorServer } from '@siglo/monitor';

// Attach workflow directly to the running server by port or URL
const orderPipeline = flow(fetchUser, chargeCard)
    .monitor(attachToMonitorServer('https://monitor.internal.corp:4000', {
        apiKey: process.env.MONITOR_API_KEY
    }));
    // or local dev: .monitor(attachToMonitorServer(4000))

await orderPipeline.run({ orderId: 'ord_123' });
```

Events are automatically dispatched asynchronously to the monitor server's `POST /api/events` endpoint without blocking your workflow execution or throwing errors if the server is temporarily unreachable.

### Scenario B: Same Process (In-Memory Singleton / App Bootstrap)

If your application starts the monitor server once during startup, other files and services can connect without creating redundant HTTP servers:

```typescript
import { flow } from '@siglo/core';
import { createMonitorServer, attachToMonitorServer, getMonitorEmitter } from '@siglo/monitor';

// In server startup file (e.g., server.ts):
const monitor = await createMonitorServer({
    port: 4000,
    reuseExisting: true // Reuses existing instance instead of throwing EADDRINUSE
});

// In any other file / workflow definition:
const orderPipeline = flow(fetchUser, chargeCard)
    .monitor(attachToMonitorServer()); // Automatically resolves the active in-process server
```

You can also retrieve the global emitter directly:
```typescript
import { getMonitorEmitter } from '@siglo/monitor';

const emitter = getMonitorEmitter();
const orderPipeline = flow(fetchUser, chargeCard).monitor(emitter!);
```

### Scenario C: High-Throughput Remote Client

For distributed workers or background jobs pushing events to a central monitor server, use `createMonitorClient` to configure batching and debounce intervals:

```typescript
import { createMonitorClient } from '@siglo/monitor';

const client = createMonitorClient({
    url: 'http://monitor-service:4000',
    batchSize: 20,          // Flush when 20 events accumulate
    flushIntervalMs: 50,    // Or flush every 50ms
    redaction: {
        redactKeys: ['password', 'creditCard']
    }
});

const orderPipeline = flow(fetchUser, chargeCard)
    .monitor(client.monitor);
```

---

## 5. Web Framework Middlewares

Embed the live monitoring UI and telemetry endpoints directly inside your existing web applications without running a separate server.

### Express Integration

```typescript
import express from 'express';
import { createExpressMonitorMiddleware } from '@siglo/monitor';

const app = express();

// Mount dashboard UI, /events SSE, and /api endpoints on /_siglo
app.use('/_siglo', createExpressMonitorMiddleware());

app.listen(3000, () => {
    console.log('Monitor dashboard available at http://localhost:3000/_siglo');
});
```

### Fastify Integration

```typescript
import Fastify from 'fastify';
import { fastifyMonitorPlugin } from '@siglo/monitor';

const fastify = Fastify();

await fastify.register(fastifyMonitorPlugin, { prefix: '/_siglo' });
await fastify.listen({ port: 3000 });
```

### Hono Integration

```typescript
import { Hono } from 'hono';
import { honoMonitorMiddleware } from '@siglo/monitor';

const app = new Hono();

app.use('/_siglo/*', honoMonitorMiddleware());
```

---

## 6. Live DevTools Dashboard Features

The web dashboard is a responsive single-page application built with React, Vite, and Tailwind CSS:

| View / Feature | Description |
|---|---|
| **Topology (DAG)** | Interactive step sequence diagram highlighting active nodes (`RUNNING`), completions, failures, and retry counters. Clicking a node opens an inspector with execution duration and errors. |
| **Latency Waterfall** | Horizontal timeline chart showing execution offset, relative latency, and attempt counts for each step. |
| **Context & State Diff** | Monospace JSON viewer with tabs for current state and chronological field mutations (`context:change`), plus one-click copy. |
| **Live Events Stream** | Chronological feed of all 14 Siglo events with filtering by event type and expandable raw payloads. |
| **Interactive Resume** | Modal for durable workflows suspended on `waitForEvent()`. Enter signal event name and JSON payload to resume execution. |
| **Replay Trigger** | One-click workflow replay button to re-trigger executions with recorded input context. |
| **Search & Status Filter** | Instant client-side search by flow name, namespace, or stack ID with status filter tabs (`ALL`, `RUNNING`, `SUSPENDED`, `FAILED`, `COMPLETED`). |
| **Multi-Tenant Filter** | Top header dropdown to isolate telemetry to a specific `$namespace`. |

---

## 7. Transports & Streaming

### Server-Sent Events (SSE)

Clients can subscribe to `/events` for one-way live event streaming with automated heartbeat keep-alive:

```javascript
const es = new EventSource('http://localhost:4000/events');

es.addEventListener('flow:start', (e) => {
    console.log('Flow started:', JSON.parse(e.data));
});

es.addEventListener('step:complete', (e) => {
    console.log('Step finished:', JSON.parse(e.data));
});

es.addEventListener('flow:suspended', (e) => {
    console.log('Waiting for signal:', JSON.parse(e.data));
});
```

Filter events by namespace via query parameter:
```javascript
const es = new EventSource('http://localhost:4000/events?namespace=tenant-a');
```

### WebSocket Streaming

For bidirectional communication or interactive controls, connect to `ws://localhost:4000/ws`:

```javascript
const ws = new WebSocket('ws://localhost:4000/ws');

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log('WebSocket event:', data);
};
```

---

## 8. Distributed Monitoring with Redis Pub/Sub

When scaling workflows across multiple worker processes or Kubernetes pods, aggregate telemetry through Redis:

```typescript
import { RedisMonitoringAdapter, createMonitorServer } from '@siglo/monitor';

const redisAdapter = new RedisMonitoringAdapter({
    redisUrl: 'redis://localhost:6379',
    channel: 'siglo:monitor:events'
});

// 1. In Worker Process: Publish events to Redis
emitter.on('*', (event) => {
    redisAdapter.publish(event);
});

// 2. In Central Monitor Server: Subscribe and broadcast to web dashboard
const monitor = await createMonitorServer({ port: 4000 });

redisAdapter.subscribe((event) => {
    monitor.store.addEvent(event);
    monitor.sse.broadcast(event);
});
```

---

## 9. Prometheus Metrics & Grafana

Expose standard Prometheus metrics for cluster alerting and visualization:

```typescript
import { PrometheusExporter, createMonitorServer } from '@siglo/monitor';

const monitor = await createMonitorServer({ port: 4000 });

// GET /metrics exposes:
// - siglo_active_flows
// - siglo_flow_executions_total{status="completed|failed"}
// - siglo_flow_duration_seconds
// - siglo_step_retries_total
```

Import the ready-to-use Grafana JSON dashboard located in:
[`grafana/siglo-live-monitoring.json`](./grafana/siglo-live-monitoring.json)

---

## 10. Security, Authentication & Production Hardening

When deploying `@siglo/monitor` across internal networks or attaching remote workers, apply production-grade security controls:

### 10.1 API Key & Token Authentication
Protect telemetry ingestion, control-plane endpoints, and event streams with API keys:

```typescript
const monitor = await createMonitorServer({
    port: 4000,
    auth: {
        ingestionKey: 'ingest-secret-token', // Required for POST /api/events
        adminKey: 'admin-secret-token',       // Required for /resume, /replay, /api/workflows
    }
    // Or shorthand for general single key: auth: 'my-secret-key'
});
```

Remote clients attach with their key:
```typescript
const monitor = attachToMonitorServer('https://monitor.corp.internal:4000', {
    apiKey: 'ingest-secret-token'
});
```

The Web UI and SSE clients authenticate via `Authorization: Bearer <token>`, `X-API-Key: <token>`, or URL query parameter `?token=<token>`.

### 10.2 Disabling Remote Control in Sensitive Environments
In production, disable interactive workflow resumption (`/resume`) and replays (`/replay`) to prevent remote state manipulation:

```typescript
const monitor = await createMonitorServer({
    allowRemoteResume: false // Returns 403 Forbidden on resume/replay
});
```

### 10.3 CORS Hardening
Restrict browser DevTools access to explicit trusted origins (preventing drive-by intranet CSRF):

```typescript
const monitor = await createMonitorServer({
    cors: {
        origin: ['https://devtools.internal.corp', 'http://localhost:3000'],
        credentials: true
    }
});
```

### 10.4 Payload Caps & Client Memory Protection
- **Payload Limits**: Limits JSON ingestion payloads to 1MB (configurable via `maxPayloadBytes`). Exceeding requests receive `413 Payload Too Large`.
- **Bounded Client Queue**: Remote client automatically drops oldest events if telemetry buffer exceeds `maxQueueSize` (default: 1000) when the network is slow or unreachable.

### 10.5 Context & Credential Redaction
Prevent sensitive credentials, API keys, or personal identifiable information (PII) from leaking to dashboards and event streams:

```typescript
const monitor = await createMonitorServer({
    redaction: {
        redactKeys: ['apiKey', 'password', 'creditCard', 'secret', 'token'],
        redactHook: (key, val) => {
            if (key === 'email') return val.replace(/(?<=.).(?=[^@]*?@)/g, '*');
            return undefined; // use default '[REDACTED]'
        }
    }
});
```

---

## 11. Dashboard UI Development (React + Vite + Tailwind)

The live monitor web interface source code is located in [`packages/monitor/ui`](./ui) and adheres to modular, industry-standard frontend architecture.

### Tech Stack
- **React 18** with typed hooks and functional components
- **Tailwind CSS** for dark-mode DevTools styling
- **Lucide React** for icons
- **Vite** with `vite-plugin-singlefile` for self-contained distribution

### Directory Layout
```
packages/monitor/ui/
├── src/
│   ├── api/
│   │   └── workflowApi.ts             # REST client for workflow fetch, resume, and replay
│   ├── constants/
│   │   ├── events.ts                  # Siglo event types enumeration
│   │   └── status.ts                  # Workflow status filters list
│   ├── hooks/
│   │   ├── useWorkflowMonitor.ts      # SSE connection, event reducer & state sync hook
│   │   └── useClipboard.ts            # Clipboard copy helper with timeout
│   ├── types/
│   │   ├── workflow.ts                # WorkflowRun, StepRun, ContextDiff types
│   │   ├── events.ts                  # MonitoringEvent, SigloEventType types
│   │   └── index.ts                   # Centralized type exports
│   ├── utils/
│   │   └── formatters.ts              # Time, duration, ID, and JSON formatters
│   ├── components/
│   │   ├── ui/                        # Reusable design system atoms
│   │   │   ├── StatusBadge.tsx        # Color-coded status badge
│   │   │   ├── Modal.tsx              # Accessible dialog modal
│   │   │   └── EmptyState.tsx         # Empty state illustration card
│   │   ├── layout/                    # Layout shells
│   │   │   └── Header.tsx             # Navigation header & SSE connectivity badge
│   │   └── workflows/                 # Feature-specific components
│   │       ├── RunList/               # Workflow execution sidebar & filters
│   │       ├── Dag/                   # Interactive DAG topology visualizer
│   │       ├── Waterfall/             # Latency waterfall chart
│   │       ├── Context/               # Context JSON & mutation diff inspector
│   │       ├── Events/                # Live streaming telemetry log
│   │       ├── ResumeModal/           # Resumption modal dialog
│   │       ├── Stats/                 # High-level metrics grid
│   │       └── WorkflowDetail.tsx     # Tabbed workflow execution view
│   ├── App.tsx                        # Root layout orchestrator
│   ├── main.tsx                       # React DOM entry point
│   └── index.css                      # Tailwind base & utilities
├── scripts/
│   └── embed-html.js                  # Inlines dist/index.html into src/ui/dashboard.ts
├── vite.config.ts                     # Vite config with backend proxy and singlefile plugin
├── tailwind.config.js                 # Tailwind configuration
└── package.json
```

### Local Development Server

Run Vite with hot module replacement (HMR) and backend proxy forwarding `/events` and `/api` to `http://localhost:4000`:

```bash
npm run dev:ui
```

### Production Build

Builds the SPA into a single inlined bundle and updates [`src/ui/dashboard.ts`](./src/ui/dashboard.ts):

```bash
npm run build:ui
```

---

## 12. REST API Reference

The monitor server exposes REST endpoints for programmatic inspection and control:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` or `/index.html` | Serves the single-page DevTools web dashboard |
| `GET` | `/events` | Server-Sent Events (SSE) stream (`?namespace=...`) |
| `POST` | `/api/events` | Ingests telemetry events from external processes / clients |
| `GET` | `/metrics` | Prometheus metrics exposition format |
| `GET` | `/api/workflows` | List recorded workflow runs (`?namespace=...&status=...`) |
| `GET` | `/api/workflows/:stackId` | Get execution details and step history for a workflow |
| `POST` | `/api/workflows/:stackId/resume` | Resume a suspended workflow (`{ eventName, payload }`) |
| `POST` | `/api/workflows/:stackId/replay` | Trigger replay of a recorded workflow |

---

## 13. Programmatic API Reference

### `attachToMonitorServer(target?: string | number | MonitorServerInstance | MonitorClientOptions): (event: WorkflowExecutionEvent) => void`
Convenient hook to attach a workflow to a running monitor server (in-process or remote over HTTP).

### `createMonitorClient(options?: MonitorClientOptions): MonitorClientInstance`
Creates a remote client with configurable buffering and auto-flush to stream events to an external monitor server.

### `getActiveMonitorServer(port?: number): MonitorServerInstance | undefined`
Returns the active in-process monitor server instance.

### `getMonitorEmitter(port?: number): WorkflowEventEmitter | undefined`
Returns the event emitter of the currently active in-process monitor server.

### `createMonitorServer(options?: MonitorServerOptions): Promise<MonitorServerInstance>`
Creates and starts an HTTP monitor server. Supports `reuseExisting: true` to reuse an already running instance.

---

## 14. License

MIT &copy; Jerico de Guzman
