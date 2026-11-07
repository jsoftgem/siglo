# Siglo API Reference

Welcome to the comprehensive API Reference for **Siglo** &mdash; zero-daemon, in-process workflow orchestration with durable checkpoints, Sagas, and live visual DevTools.

---

## Reference Sections

| Section | Description |
|---|---|
| ⛓️ **[Orchestration & Combinators](orchestration-and-combinators.md)** | Workflow composition (`flow`), parallel execution (`parallel`, `all`, `allSettled`, `race`), branching (`when`, `branch`), dynamic mapping (`map`), durable waits (`waitForEvent`, `wait`, `resumeWorkflow`), and AST exports (`toMermaid`, `toDot`, `toJSON`). |
| 🌊 **[Flow Instance Methods (`Flow`)](flow.md)** | Primary workflow instance interface (`run`, `execute`, `start`), SLA timeouts (`flow.timeout`), versioning (`flow.version`), manual compensations (`flow.compensate`), resumption (`flow.resume`), and AST inspection. |
| 🧱 **[Step Methods (`Step`)](step.md)** | Core execution unit construction (`Step.create`), Standard Schema validation (`schema`, `spec`, `strict`), lifecycle hooks (`onBefore`, `onSkip`, `onAfter`), retries (`onFail`), sagas (`compensate`), idempotency (`idempotent`), caching (`cache`), and DI (`withDependencies`). |
| ⚙️ **[Execution Options (`ExecutionOptions`)](execution-options.md)** | Runtime configuration options passed to `.run()` and `.resume()`: POJO mode (`pojo`, `mode`), cooperative cancellation (`signal`), deadlines (`timeout`), dependency injection (`services`), durability (`durable`), multi-tenancy (`namespace`), and idempotency (`idempotencyKey`). |
| 💾 **[Storage & Persistence Utilities](storage-and-persistence.md)** | Persistent checkpoint management (`useStorage`, `getStorageAdapter`), error modes (`setErrorMode`), optimistic concurrency control (OCC), serialized snapshot creation (`checkpoint`, `restoreCheckpoint`), and expiration cleanup (`cleanExpiredCheckpoints`). |
| 🚨 **[Error Hierarchy & Exceptions (`SigloError`)](error-hierarchy.md)** | Strongly typed runtime exception model rooted at `SigloError`: step and flow timeouts, cancellations, schema validation failures, saga rollbacks (`CompensationException`), idempotency conflicts, version mismatches, and `normalizeError()`. |
| 🧪 **[Deterministic Testing (`@siglo/testing`)](testing.md)** | Deterministic test harness (`createWorkflowHarness`), virtual clocks (`FakeClock`), step spies (`spyStep`), step mocking (`mockStep`), event injection (`injectEvent`), test assertions, execution fixtures, and replay (`replayExecution`). |

---

## Architectural Guides & Topic References

For higher-level design patterns, system architecture, and production topologies, consult the topic guides:

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
