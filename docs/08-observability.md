---
title: 'Observability'
description: 'Telemetry, diagram exports, and real-time DevTools in Siglo: OpenTelemetry distributed tracing, Mermaid/DOT AST exports, and React live monitoring.'
---

For provisioned Jaeger, Grafana, and Prometheus dashboards, follow [Zero-Code APM Dashboards](/zero-code-apm-dashboards).

For a complete HTTP example, follow [Serve a REST Endpoint and Watch It Run Live](/rest-and-live-monitoring).

For multi-service microservice correlation and live monitoring, follow [Correlate Distributed Multi-Domain Services with stackId and namespace](/distributed-cross-service-workflows).

Observability is a first-class citizen in `Siglo`. Workflows can export their topological structure as diagrams, emit telemetry spans to OpenTelemetry collectors, record granular execution traces, and stream real-time events to an interactive React DevTools dashboard.

---

## 1. Graph Inspection & Visualization

Every workflow can export its AST directly:

```typescript
import { Step, flow } from '@siglo/core';

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
import { flow, Step } from '@siglo/core';
import { instrumentWorkflow } from '@siglo/opentelemetry';

const myWorkflow = flow(
    Step.create('processOrder', async ctx => {
        return { orderId: 'ord-123' };
    }),
);

// Instruments the workflow to automatically create root spans and child step spans
const tracedWorkflow = instrumentWorkflow(myWorkflow, {
    serviceName: 'order-service',
});

await tracedWorkflow.run({ customerId: 'cust-99' });
```

---

## 3. Real-Time DevTools and Live Monitoring

Siglo provides built-in Live Monitoring via `@siglo/monitor`. You can attach an event emitter to your workflow to stream execution events over Server-Sent Events (SSE) or WebSockets to the embedded React DevTools UI.

```typescript
import { flow, Step, WorkflowEventEmitter } from '@siglo/core';
import { createMonitorServer } from '@siglo/monitor';

const emitter = new WorkflowEventEmitter();

// Start DevTools server on port 4000
const monitor = await createMonitorServer({
    port: 4000,
    emitter,
});

const myWorkflow = flow(
    Step.create('step1', async () => ({ ok: true })),
).monitor(emitter);

await myWorkflow.run({});
```

---

## Related Topic Guides

- [Correlate Distributed Multi-Domain Services with stackId and namespace](/distributed-cross-service-workflows)
- [Serve a REST Endpoint and Watch It Run Live](/rest-and-live-monitoring)
- [Zero-Code APM Dashboards](/zero-code-apm-dashboards)
- [Live Monitoring & DevTools](/live-monitoring)
