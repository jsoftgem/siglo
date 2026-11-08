---
title: "API Reference Overview"
description: "Comprehensive API reference for Siglo: orchestration combinators, Flow and Step methods, execution options, storage adapters, error hierarchy, and deterministic testing."
---

# Siglo API Reference

Welcome to the comprehensive API Reference for **Siglo** &mdash; zero-daemon, in-process workflow orchestration with durable checkpoints, Sagas, network guardrails, and live visual DevTools.

---

## Reference Sections

| Section | Description |
|---|---|
| ⛓️ **[Orchestration and Combinators](/api/orchestration-and-combinators)** | Workflow composition (`flow`), parallel execution (`parallel`, `all`, `allSettled`, `race`), branching (`when`, `branch`), dynamic mapping (`map`), durable waits (`waitForEvent`, `wait`, `resumeWorkflow`), and AST exports (`toMermaid`, `toDot`, `toJSON`). |
| 🌊 **[Flow Instance Methods (`Flow`)](/api/flow)** | Primary workflow instance interface (`run`, `execute`, `start`), SLA timeouts (`flow.timeout`), versioning (`flow.version`), network guardrails (`flow.networkPolicy`), live monitoring (`flow.monitor`), execution hooks (`flow.hook`), manual compensations (`flow.compensate`), resumption (`flow.resume`), and AST inspection. |
| 🧱 **[Step Methods (`Step`)](/api/step)** | Core execution unit construction (`Step.create`), Standard Schema validation (`schema`, `spec`, `strict`), lifecycle hooks (`onBefore`, `onSkip`, `onAfter`), retries (`onFail`), sagas (`compensate`), idempotency (`idempotent`), caching (`cache`), DI (`withDependencies`, `requireDependency`), output reduction (`reduce`), and network egress guardrails (`allowNetwork`, `allowUnixSockets`, `denyNetwork`, `networkPolicy`). |
| ⚙️ **[Execution Options (`ExecutionOptions`)](/api/execution-options)** | Runtime configuration options passed to `.run()` and `.resume()`: POJO mode (`pojo`, `mode`), cooperative cancellation (`signal`), deadlines (`timeout`), dependency injection (`services`), durability (`durable`), multi-tenancy (`namespace`), idempotency (`idempotencyKey`), execution hooks (`stepExecutionHook`), and live monitoring (`monitor`). |
| 💾 **[Storage and Persistence Utilities](/api/storage-and-persistence)** | Persistent checkpoint management (`useStorage`, `getStorageAdapter`), error modes (`setErrorMode`), optimistic concurrency control (OCC), serialized snapshot creation (`checkpoint`, `restoreCheckpoint`), and expiration cleanup (`cleanExpiredCheckpoints`). |
| 🚨 **[Error Hierarchy and Exceptions (`SigloError`)](/api/error-hierarchy)** | Strongly typed runtime exception model rooted at `SigloError`: timeouts, cancellations, schema validation failures, saga rollbacks (`CompensationException`, `UnresolvableCompensationException`), network guardrail violations (`NetworkPolicyViolationException`), idempotency conflicts, version mismatches, and `normalizeError()`. |
| 🧪 **[Deterministic Testing (`@siglo/testing`)](/api/testing)** | Deterministic test harness (`createWorkflowHarness`), virtual clocks (`FakeClock`), step spies (`spyStep`), step mocking (`mockStep`), event injection (`injectEvent`), test assertions, execution fixtures, and replay (`replayExecution`). |

---

## Architectural Guides and Topic References

For higher-level design patterns, system architecture, and production topologies, consult the topic guides:

### Step-by-Step Guides
- [01. Getting Started](/01-getting-started)
- [02. Core Concepts](/02-core-concepts)
- [03. Sequential Workflows](/03-sequential-workflows)
- [04. Branching and Parallelism](/04-branching-and-parallelism)
- [05. Retries, Timeouts, and Cancellation](/05-retries-timeouts-and-cancellation)
- [06. Durable Workflows](/06-durable-workflows)
- [07. Storage and Adapters](/07-storage-and-adapters)
- [08. Observability](/08-observability)
- [09. Testing and Replay](/09-testing-and-replay)
- [10. TypeScript Reference](/10-typescript-reference)
- [11. Production Operations](/11-production-operations)

### Formal Contracts and Architecture
- [Execution Semantics](/execution-semantics)
- [Concurrency and Parallelism](/concurrency-and-parallelism)
- [Error Model and Hierarchy](/error-model)
- [Storage and Checkpoint Contract](/storage-contract)
- [Compensation and Sagas Contract](/compensation-and-sagas)
- [Durable Waits Contract](/durable-waits)
- [Idempotency Contract](/idempotency)
- [Network Egress Policy](/network-egress-policy)
- [Production Best Practices](/production-best-practices)
- [Workflow Graph AST](/workflow-graph)
- [Workflow Versioning and Migrations](/workflow-versioning)
