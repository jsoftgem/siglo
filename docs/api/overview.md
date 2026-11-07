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
| ⛓️ **[Orchestration and Combinators](orchestration-and-combinators.md)** | Workflow composition (`flow`), parallel execution (`parallel`, `all`, `allSettled`, `race`), branching (`when`, `branch`), dynamic mapping (`map`), durable waits (`waitForEvent`, `wait`, `resumeWorkflow`), and AST exports (`toMermaid`, `toDot`, `toJSON`). |
| 🌊 **[Flow Instance Methods (`Flow`)](flow.md)** | Primary workflow instance interface (`run`, `execute`, `start`), SLA timeouts (`flow.timeout`), versioning (`flow.version`), network guardrails (`flow.networkPolicy`), live monitoring (`flow.monitor`), execution hooks (`flow.hook`), manual compensations (`flow.compensate`), resumption (`flow.resume`), and AST inspection. |
| 🧱 **[Step Methods (`Step`)](step.md)** | Core execution unit construction (`Step.create`), Standard Schema validation (`schema`, `spec`, `strict`), lifecycle hooks (`onBefore`, `onSkip`, `onAfter`), retries (`onFail`), sagas (`compensate`), idempotency (`idempotent`), caching (`cache`), DI (`withDependencies`, `requireDependency`), output reduction (`reduce`), and network egress guardrails (`allowNetwork`, `allowUnixSockets`, `denyNetwork`, `networkPolicy`). |
| ⚙️ **[Execution Options (`ExecutionOptions`)](execution-options.md)** | Runtime configuration options passed to `.run()` and `.resume()`: POJO mode (`pojo`, `mode`), cooperative cancellation (`signal`), deadlines (`timeout`), dependency injection (`services`), durability (`durable`), multi-tenancy (`namespace`), idempotency (`idempotencyKey`), execution hooks (`stepExecutionHook`), and live monitoring (`monitor`). |
| 💾 **[Storage and Persistence Utilities](storage-and-persistence.md)** | Persistent checkpoint management (`useStorage`, `getStorageAdapter`), error modes (`setErrorMode`), optimistic concurrency control (OCC), serialized snapshot creation (`checkpoint`, `restoreCheckpoint`), and expiration cleanup (`cleanExpiredCheckpoints`). |
| 🚨 **[Error Hierarchy and Exceptions (`SigloError`)](error-hierarchy.md)** | Strongly typed runtime exception model rooted at `SigloError`: timeouts, cancellations, schema validation failures, saga rollbacks (`CompensationException`, `UnresolvableCompensationException`), network guardrail violations (`NetworkPolicyViolationException`), idempotency conflicts, version mismatches, and `normalizeError()`. |
| 🧪 **[Deterministic Testing (`@siglo/testing`)](testing.md)** | Deterministic test harness (`createWorkflowHarness`), virtual clocks (`FakeClock`), step spies (`spyStep`), step mocking (`mockStep`), event injection (`injectEvent`), test assertions, execution fixtures, and replay (`replayExecution`). |

---

## Architectural Guides and Topic References

For higher-level design patterns, system architecture, and production topologies, consult the topic guides:

### Step-by-Step Guides
- [01. Getting Started](../01-getting-started.md)
- [02. Core Concepts](../02-core-concepts.md)
- [03. Sequential Workflows](../03-sequential-workflows.md)
- [04. Branching and Parallelism](../04-branching-and-parallelism.md)
- [05. Retries, Timeouts, and Cancellation](../05-retries-timeouts-and-cancellation.md)
- [06. Durable Workflows](../06-durable-workflows.md)
- [07. Storage and Adapters](../07-storage-and-adapters.md)
- [08. Observability](../08-observability.md)
- [09. Testing and Replay](../09-testing-and-replay.md)
- [10. TypeScript Reference](../10-typescript-reference.md)
- [11. Production Operations](../11-production-operations.md)

### Formal Contracts and Architecture
- [Execution Semantics](../execution-semantics.md)
- [Concurrency and Parallelism](../concurrency-and-parallelism.md)
- [Error Model and Hierarchy](../error-model.md)
- [Storage and Checkpoint Contract](../storage-contract.md)
- [Compensation and Sagas Contract](../compensation-and-sagas.md)
- [Durable Waits Contract](../durable-waits.md)
- [Idempotency Contract](../idempotency.md)
- [Network Egress Policy](../network-egress-policy.md)
- [Production Best Practices](../production-best-practices.md)
- [Workflow Graph AST](../workflow-graph.md)
- [Workflow Versioning and Migrations](../workflow-versioning.md)
