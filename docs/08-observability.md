# 08. Observability

Observability is a first-class citizen in `Rivulet`. Workflows can export their topological structure as diagrams, emit telemetry spans to OpenTelemetry collectors, and record granular execution traces.

---

## 1. Graph Inspection & Visualization

Every workflow can export its AST directly:

```typescript
import { Step, flow } from 'rivulet';

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

Install `@rivulet/opentelemetry`:

```bash
npm install @rivulet/opentelemetry @opentelemetry/api
```

Instrument workflows with a single call:

```typescript
import { instrumentWorkflow } from '@rivulet/opentelemetry';
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
import { injectTraceContext, extractTraceContext } from '@rivulet/opentelemetry';

// On the caller side (HTTP client or event producer):
const headers: Record<string, string> = {};
injectTraceContext(headers);
await httpClient.post('/orders', body, { headers });

// On the receiver side (Express/Fastify/Kafka worker):
const traceparent = req.headers['traceparent'];
const extractedSpanContext = extractTraceContext({ traceparent });
```

---

## Minimal Example

```typescript
import { Step, flow, toMermaid } from 'rivulet';

const s1 = Step.create('start', () => ({ ok: true })).timeout(5000);
const wf = flow(s1);

console.log(toMermaid(wf));
// flowchart TD
//     start["start (step) [⏱️ 5000ms]"]
```

---

## Failure Example: OpenTelemetry Exception Recording

When an error occurs, `@rivulet/opentelemetry` records the exception and marks the span status as `ERROR`:

```typescript
import { Step, flow } from 'rivulet';
import { instrumentWorkflow } from '@rivulet/opentelemetry';

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
    // - attributes: fluid.step.name = 'flakyCall', fluid.step.phase = 'action'
}
```

---

## Testing Example

```typescript
import { expect } from 'chai';
import { Step, flow } from 'rivulet';
import { instrumentWorkflow } from '@rivulet/opentelemetry';

describe('OpenTelemetry Integration Test', () => {
    it('instruments workflow and executes cleanly', async () => {
        const step = Step.create('calculate', () => ({ num: 42 })).modern();
        const traced = instrumentWorkflow(flow(step));

        const result = await traced.run();
        expect(result.num).to.equal(42);
    });
});
```

---

## Operational Caveats

1. **Context Redaction in Telemetry**: Always specify `redactContextKeys` when capturing span attributes to ensure PII, tokens, and secrets are excluded from logs and tracing dashboards.
2. **Span Limiters**: In loops or deep recursive pipelines, avoid creating unbounded spans. Use bounded batching with `map(items, step, { concurrency })`.

---

## API Reference Links

- [OpenTelemetry Adapter Guide](./adapters/opentelemetry.md)
- [Workflow Graph Architecture](./workflow-graph.md)
- [Testing & Replay Reference](./09-testing-and-replay.md)
