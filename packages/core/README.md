<p align="center">
  <img src="../../docs/assets/siglo-logo.png" alt="Siglo Logo" width="220" style="border-radius: 16px;" />
</p>

# Siglo Core
> Zero-daemon, in-process workflow orchestration with durable checkpoints, Sagas, and live visual DevTools.

[![NPM Version](https://img.shields.io/npm/v/@siglo/core.svg)](https://www.npmjs.com/package/@siglo/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node Version](https://img.shields.io/badge/node-%5E22.13.0%20%7C%7C%20%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)]()

**Siglo** is a lightweight, zero-daemon workflow runtime for TypeScript. It orchestrates complex business logic into composable, resilient steps—featuring end-to-end type inference, automatic Sagas, durable checkpoints, and live DevTools without external infrastructure.

---

## Positioning: In-Process Orchestration vs Distributed Engines

| Dimension | `Siglo` | Distributed Engines (Temporal, Inngest) |
|---|---|---|
| **Architecture** | Lightweight, zero-infrastructure in-process library | Heavy multi-cluster / external orchestrator daemon |
| **Latency** | Microsecond direct async function invocation | Millisecond-to-second RPC / polling overhead |
| **Footprint** | Zero external dependencies, pure TypeScript | Requires persistent workers, queue servers, and databases |
| **Primary Focus** | Modular workflows, parallel fan-out/fan-in, bounded worker mapping, request-scoped sagas, idempotency, durable event waits, retry backoff with jitter, OCC checkpointing | Months-long durable human-in-the-loop workflows |

---

## Documentation & Topic Guides

Explore the 11 comprehensive guides covering architecture, design patterns, testing, and production operations:

1. 🚀 [01. Getting Started](../../docs/01-getting-started.md) &mdash; Installation, quickstart walkthrough, minimal examples, and CLI scaffolding.
2. 💡 [02. Core Concepts](../../docs/02-core-concepts.md) &mdash; Executable ASTs, accumulated context immutability, 5-phase step lifecycle, and reserved keys.
3. ⛓️ [03. Sequential Workflows](../../docs/03-sequential-workflows.md) &mdash; Linear pipelines, clean POJO parameters, lifecycle hooks (`onBefore`, `onSkip`, `onAfter`), and caching.
4. 🔀 [04. Branching and Parallelism](../../docs/04-branching-and-parallelism.md) &mdash; Concurrent fan-outs (`parallel`, `all`, `allSettled`, `race`), dynamic routing (`when`, `branch`), and bounded mapping (`map`).
5. 🛡️ [05. Retries, Timeouts, and Cancellation](../../docs/05-retries-timeouts-and-cancellation.md) &mdash; Two-tier timeouts, exponential backoff with jitter, cooperative `AbortSignal` cancellation, and saga rollbacks.
6. ⏳ [06. Durable Workflows](../../docs/06-durable-workflows.md) &mdash; Long-running human-in-the-loop waits (`waitForEvent`, `wait`), checkpoint resumption, and state migrations.
7. 💾 [07. Storage and Adapters](../../docs/07-storage-and-adapters.md) &mdash; Distributed persistence contracts, PostgreSQL & Redis adapters, and multi-tenant namespaces.
8. 🔭 [08. Observability](../../docs/08-observability.md) &mdash; Graph exports (Mermaid, DOT, JSON), OpenTelemetry distributed tracing, and W3C trace propagation.
9. 🧪 [09. Testing and Replay](../../docs/09-testing-and-replay.md) &mdash; Deterministic workflow harnesses (`@siglo/testing`), fake clocks, step spies, mocks, and failure replay.
10. 🏷️ [10. TypeScript Reference](../../docs/10-typescript-reference.md) &mdash; End-to-end accumulated context inference, typed step history (`$steps`), and Standard Schema integration.
11. 🏭 [11. Production Operations](../../docs/11-production-operations.md) &mdash; Production deployment checklist, zero-daemon operational topologies, connection pooling, and retention cleanup.

---

## Quickstart: Type-Safe Composable Flows

Install the TypeScript workflow runtime:

```bash
npm install @siglo/core
```

```typescript
import { Step, flow } from '@siglo/core';

// 1. Define modular steps with input/output contracts
const fetchUser = Step.create('fetchUser', async (param: { userId: string }) => {
    return { name: 'Alice', tier: 'PRO' };
});

const calculateDiscount = Step.create('calculateDiscount', async (param: { tier: string }) => {
    const discount = param.tier === 'PRO' ? 0.20 : 0.05;
    return { discountPercentage: discount };
});

// 2. Compose into an executable flow
export const orderWorkflow = flow(fetchUser, calculateDiscount);

// 3. Run the flow with full type safety
async function main() {
    const result = await orderWorkflow.run({ userId: 'u_123' }, { pojo: true });
    console.log(result.name);               // 'Alice'
    console.log(result.discountPercentage); // 0.20
    console.log(result.$steps.fetchUser);   // { name: 'Alice', tier: 'PRO' }
}

main();
```

---

## Key Features

- ⚡ **Composable Flows (`flow`)** &mdash; Compose steps directly into workflows without global registries; steps are pure execution units.
- 🧠 **Accumulated Context Inference** &mdash; TypeScript automatically computes the accumulated output type across composed sequential steps at compile time.
- 📜 **Typed Step History (`$steps`)** &mdash; Statically typed access to any step's output using string literal names (`context.$steps.loadUser.user`).
- 🗺️ **Workflow Graph Visualization** &mdash; Export workflow graphs directly to Mermaid diagrams (`flow.toMermaid()`), Graphviz DOT (`flow.toDot()`), and JSON AST (`flow.toJSON()`) with policy badges.
- 💉 **Runtime Dependency Injection** &mdash; Inject services and repositories explicitly via `options.services` or step-level `step.withDependencies()`.
- 🔀 **Parallel Execution Combinators** &mdash; Run branches concurrently with `parallel`, `all`, `allSettled`, and `race`, equipped with branch context isolation and configurable merge strategies.
- 🌿 **Conditional Branching & Routing** &mdash; Dynamic decision routing via `when(predicate, thenStep, elseStep)` and multi-branch selectors via `branch(selectorFn, branchesMap, defaultBranch)`.
- 🔄 **Dynamic Mapping & Bounded Concurrency** &mdash; Process arrays with `map(items, step, { concurrency })`, order preservation, and error aggregation.
- 🔑 **Scoped Idempotency & Deduplication** &mdash; Protect workflows and individual steps (`step.idempotent()`) with deterministic hash keys and TTL stores.
- ⏪ **Sagas & LIFO Compensations** &mdash; Attach rollback handlers (`step.compensate(handler)`) that run automatically in reverse execution order upon failure.
- ⏳ **Durable Waits & Event Resumption** &mdash; Pause execution with `waitForEvent(eventName)` or `wait('30m')`, persist suspended checkpoints, and safely resume workflows.
- 🏷️ **Workflow Versioning & State Migrations** &mdash; Declare workflow versions (`flow.version('v2')`), detect version mismatches upon resumption, and run registered state transformation functions.
- ⏱️ **Resilient Deadlines & Two-Tier Timeouts** &mdash; Enforce per-step SLA (`step.timeout(ms)`) and workflow-level deadlines (`flow.timeout(ms)`).\
- 🔁 **Structured Retry Strategies** &mdash; Automatic retries with exponential, linear, or fixed backoff, jitter, and `onRetry` hooks right in `onFail`.\
- 📦 **Standard Schema Integration (`spec` / `schema`)** &mdash; Native Standard Schema, Zod, Valibot, and ArkType contract enforcement.\
- 🛑 **Graceful Cancellation & AbortSignals** &mdash; Cancel flows, in-flight async steps, and retry timers seamlessly using standard `AbortSignal`.

---

## License

This project is licensed under the MIT License - see the [LICENSE](../../LICENSE) file for details.
