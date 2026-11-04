# 08. Observability

Observability is a first-class citizen in `Siglo`. Workflows can export their topological structure as diagrams, emit telemetry spans to OpenTelemetry collectors, record granular execution traces, and stream real-time events to an interactive React DevTools dashboard.

---

## 1. Graph Inspection & Visualization

Every workflow can export its AST directly:

```typescript
import { Step, flow } from 'siglo';

const s1 = Step.create('fetchUser', async () => ({ user: 'Alice' })).timeout(3000);
const s2 = Step.create('charge', async () => ({ charged: true })).onFail({ maxRetries: 3, delay: 100 });
const myWorkflow = flow(s1, s2);

// 1. Export as Mermaid Flowchart
const mermaidMarkdown = myWorkflow.toMermaid({ direction: 'TD' });
console.log(mermaidMarkdown);

// 2. Export as Graphviz DOT
const dotGraph = myWorkflow.toDot({ graphName: 'BillingPipeline' });
console.log(dotGraph);

// 3. Export as JSON AST
const jsonAst = myWorkflow.toJSON();
console.log(jsonAst);
```

### Visual Badges in Diagrams
`toMermaid()` and `toDot()` automatically embed badges for execution policies:
- ⏱️ `timeoutMs`: Execution deadline
- 🔁 `retry(N)`: Retry count policy
- ⏪ `saga`: Compensation rollback registered
- 💾 `cache`: Step output caching enabled
- ⏳ `wait`: Durable suspension or timer sleep

---

## 2. OpenTelemetry Distributed Tracing

Install `@siglo/opentelemetry`:

```bash
npm install @siglo/opentelemetry @opentelemetry/api
```

Instrument workflows with a single call:

```typescript
import { instrumentWorkflow } from '@siglo/opentelemetry';
import { myWorkflow } from './workflows';

// Wraps workflow to emit root workflow spans and child step spans
const tracedWorkflow = instrumentWorkflow(myWorkflow, {
    tracerName: 'orders-service',
    allowNamespace: true,
    redactContextKeys: ['password', 'cardNumber']
});

const result = await tracedWorkflow.run({ orderId: '123' });
```

---

## 3. W3C Trace Context Propagation

Propagate trace headers (`traceparent`, `tracestate`) across distributed boundaries (HTTP, Kafka, SQS):

```typescript
import { injectTraceContext, extractTraceContext } from '@siglo/opentelemetry';

// On the caller side (HTTP client or event producer):
const headers: Record<string, string> = {};
injectTraceContext(headers);
await httpClient.post('/orders', body, { headers });

// On the receiver side (Express/Fastify/Kafka worker):
const traceparent = req.headers['traceparent'];
const extractedSpanContext = extractTraceContext({ traceparent });
```

---

## 4. Real-Time Live Monitoring & DevTools

In addition to OpenTelemetry distributed tracing, Siglo provides a real-time monitoring engine with a built-in **React 18 + Vite + Tailwind CSS** web dashboard, SSE/WebSocket streaming, and Prometheus metrics via `@siglo/monitor`:

```typescript
import { Step, flow } from 'siglo';
import { createMonitorServer, attachToMonitorServer } from '@siglo/monitor';

// 1. Launch monitor server (or attach to an existing one via CLI `siglo monitor`)
const monitor = await createMonitorServer({ port: 4000 });

// 2. Attach workflows
const myFlow = flow(
    Step.create('stepA', async () => ({ a: 1 })),
    Step.create('stepB', async () => ({ b: 2 }))
).monitor(attachToMonitorServer(4000)); // or: .monitor(monitor.emitter)

await myFlow.run({});
```

- **React DevTools Dashboard**: Interactive DAG graph topology visualizer, step latency waterfalls, context mutation diff inspector, and live event log at `http://localhost:4000`.
- **Flexible Attachment**: Connect workflows to a local or remote monitor server via `attachToMonitorServer(urlOrPort)`, or use `createMonitorClient` for buffered high-throughput worker fleets.
- **Interactive Resumption & Replay**: Unblock suspended workflows (`waitForEvent`) directly from the browser UI or trigger instant replays.
- **Prometheus Metrics**: Live metrics exported on `/metrics` for active workflows, execution duration, and retry counts.
- **Framework Middleware**: Built-in support for Express, Fastify, and Hono.

See the complete [Live Monitoring Guide](./live-monitoring.md) and [Monitor Adapter Guide](./adapters/monitor.md) for full details.

### Runnable Sample Project

A turnkey sample application showcasing `@siglo/monitor` is available at [`examples/live-monitoring`](../examples/live-monitoring):

```bash
# Run the live monitoring sample
npm start --workspace=siglo-live-monitoring-sample
```

This demo:
- Launches the live monitoring DevTools server at `http://localhost:4000/`.
- Simulates an e-commerce order fulfillment pipeline with transient errors, retry backoff (`onFail`), conditional step skips (`onBefore`), and credential masking.
- Demonstrates durable workflow suspension (`waitForEvent('order.approved')`) and automated resumption.
- Streams live events over Server-Sent Events (`/events`) and WebSockets (`/ws`).
- Exposes Prometheus metrics at `/metrics`.

---

## 5. Minimal Example

```typescript
import { Step, flow, toMermaid } from 'siglo';

const s1 = Step.create('start', () => ({ ok: true })).timeout(5000);
const wf = flow(s1);

console.log(toMermaid(wf));
// flowchart TD
//     start["start (step) [⏱️ 5000ms]"]
```

---

## 6. Failure Example: OpenTelemetry Exception Recording

When an error occurs, `@siglo/opentelemetry` records the exception and marks the span status as `ERROR`:

```typescript
import { Step, flow } from 'siglo';
import { instrumentWorkflow } from '@siglo/opentelemetry';

const failingStep = Step.create('flakyCall', () => {
    throw new Error('Database connection failed');
});

const tracedWf = instrumentWorkflow(flow(failingStep));

try {
    await tracedWf.run();
} catch (err: any) {
    // Span will have:
    // - status: SpanStatusCode.ERROR
    // - exception event with stack trace
    // - attributes: siglo.step.name = 'flakyCall', siglo.step.phase = 'action'
}
```

---

## 7. Testing Example

```typescript
import { expect } from 'chai';
import { Step, flow } from 'siglo';
import { instrumentWorkflow } from '@siglo/opentelemetry';

describe('OpenTelemetry Integration Test', () => {
    it('instruments workflow and executes cleanly', async () => {
        const step = Step.create('calculate', () => ({ num: 42 }));
        const traced = instrumentWorkflow(flow(step));

        const result = await traced.run();
        expect(result.num).to.equal(42);
    });
});
```

---

## 8. Operational Caveats

1. **Context Redaction in Telemetry**: Always specify `redactContextKeys` when capturing span attributes or monitoring streams to ensure PII, tokens, and secrets are excluded from logs and tracing dashboards.
2. **Span Limiters**: In loops or deep recursive pipelines, avoid creating unbounded spans. Use bounded batching with `map(items, step, { concurrency })`.

---

## API Reference Links

- [Live Monitoring & DevTools Guide](./live-monitoring.md)
- [Monitor Adapter Guide](./adapters/monitor.md)
- [OpenTelemetry Adapter Guide](./adapters/opentelemetry.md)
- [Workflow Graph Architecture](./workflow-graph.md)
- [Testing & Replay Reference](./09-testing-and-replay.md)
