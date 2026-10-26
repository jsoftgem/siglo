# Changelog

All notable changes to `fluid-func` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.1.0] - 2026-10-26

### Phase 3: Ecosystem, Observability, and Adoption

This release establishes the monorepo architecture and provides first-class integrations, distributed tracing, persistent storage adapters, HTTP/Queue middleware, and developer inspection tooling while preserving zero dependencies in the core runtime.

### Added

- **OpenTelemetry Distributed Tracing (`@fluid-func/opentelemetry`)**:
  - Root workflow execution spans and individual child spans per step, retry attempt, and wait suspension.
  - Standardized OpenTelemetry attributes (`fluid.workflow.name`, `fluid.step.name`, `fluid.step.attempt`, `fluid.stack.id`, `fluid.tenant.id`).
  - W3C trace context extraction and injection helpers (`injectTraceContext`, `extractTraceContext`, `getTraceHeaders`).
  - Automatic sensitive data redaction with configurable field allowlists.
- **HTTP Framework Adapters (`@fluid-func/hono`, `@fluid-func/fastify`, `@fluid-func/express`)**:
  - Idiomatic route handlers and middleware for Hono, Fastify, and Express.
  - Automatic correlation ID propagation via `X-Correlation-Id` and `X-Workflow-Stack-Id` response headers.
  - Deterministic typed error status mapping (`Timeout` -> 504, `Validation` -> 400, `IdempotencyConflict` -> 409, `Cancellation` -> 499, default -> 500).
  - Cooperative request abort signal propagation.
- **Queue and Message Broker Adapters (`@fluid-func/bullmq`, `@fluid-func/kafka`, `@fluid-func/sqs`)**:
  - BullMQ job processor with deduplication via distributed `IdempotencyStore`.
  - Kafka consumer handler with topic, partition, offset correlation, and W3C trace context extraction.
  - AWS SQS batch handler with partial batch failure reporting (`batchItemFailures`).
- **Distributed Storage & Coordination Adapters (`@fluid-func/redis`, `@fluid-func/postgres`)**:
  - `@fluid-func/redis`: Distributed checkpointing, step output caching, real-time context streaming, and `RedisLock` for distributed single-flight coordination.
  - `@fluid-func/postgres`: ACID transactional checkpoint persistence, audit event log tables, and automated retention cleanup (`cleanupOldCheckpoints`, `cleanupOldEvents`).
- **Developer Tools & Local Inspector CLI (`@fluid-func/cli`)**:
  - `fluid-func init`: Scaffolds modern TypeScript starter workflow projects.
  - `fluid-func visualize`: Renders workflow AST as Mermaid flowcharts or ASCII text trees.
  - `fluid-func validate`: Performs static acyclic reachability validation.
  - `fluid-func inspect`: Generates workflow metrics, node types, and redaction reports.
  - `fluid-func checkpoint`: Inspects serialized checkpoint state files.
  - Offline fixture replay utility (`replayFixture`) with output diff validation.
- **Continuous Integration & Automation**:
  - Multi-version Node.js matrix CI pipeline across Node 18, 20, and 22 (`.github/workflows/ci.yml`).

---

## [2.0.0] - 2026-10-20

### Major Architecture Modernization: Separation of Code and State

This release eliminates the legacy string-based code registry model, decouples step definitions from storage, introduces native runtime multi-tenancy, provides resilient two-tier execution timeouts, and introduces a unified distributed `StorageAdapter` interface.

### Added

- **Resilient Execution Deadlines (Two-Tier Timeouts)**:
  - Added `step.timeout(ms)` to enforce per-step execution SLAs. Times out long-running operations and feeds into `.onFail()` retry loops with backoff.
  - Added `flow.timeout(ms)` to enforce cumulative, end-to-end workflow deadlines across all steps and retries.
  - Added `timeout?: number` to `ExecutionOptions` for dynamic runtime deadline enforcement per execution.
  - Added `StepTimeoutException` typed error class containing `stepName`, `timeoutMs`, and `elapsedMs`.
  - Added `FlowTimeoutException` typed error class containing `stackId`, `timeoutMs`, and `completedSteps`.
  - Added cooperative cancellation propagation: `param.$signal?.()` and `param.signal?.()` provide the combined `AbortSignal` directly to step actions for native cancellation of `fetch`, HTTP clients, and database queries.
- **Native Runtime Multi-Tenancy (`tenantId`)**:
  - Added `tenantId?: string` to `ExecutionOptions`. Workflows are shared immutable code; tenant data is isolated dynamically at runtime.
  - Context metadata automatically captures and correlates `tenantId` alongside `stackId`.
  - Added `param.$tenantId()` and `param.$tenantId.val` context accessor inside step actions.
  - Step caching (`.cache(ms)`) automatically partitions cache keys by `tenantId` (`${tenantId}:${stepId}:${inputHash}`) to prevent cross-tenant data leakage.
  - State serialization and saga checkpoints are scoped to `tenantId` to prevent cross-tenant restoration.
- **Unified Distributed `StorageAdapter` Interface**:
  - Introduced `StorageAdapter` and `ContextChangeEvent` interfaces in `src/features/storage/adapter.ts`.
  - Added `Step.useStorage(adapter)` and `storage.useStorage(adapter)` to configure distributed infrastructure in a single call.
  - Added `Step.getStorageAdapter()` and `storage.getStorageAdapter()`.
  - Support for real-time telemetry streaming (`onContextChange`).
  - Support for durable saga checkpointing (`saveCheckpoint`, `getCheckpoint`, `Step.getCheckpoint(stackId)`).
  - Support for distributed step caching (`getCachedStep`, `setCachedStep`).
- **100% Anonymous Step Support**:
  - Added numeric index access to step outputs: `param.$steps[i]` and `param.$history[i]`.
  - Named steps can now be accessed either by name (`param.$steps.stepName`) or index (`param.$steps[i]`).
- **State Serialization & Durable Workflows**:
  - Added `Step.checkpoint(stackId)`, `Step.restoreCheckpoint(checkpoint)`.
  - Added `Step.serializeState(stackId?)`, `Step.hydrateState(serializedState)`.\n- **POJO Execution Mode**:
  - Added `{ pojo: true }` and `{ mode: 'pojo' }` execution options, resolving frozen plain objects directly.
  - Added standalone `toPOJO<T>(data)` conversion utility.

### Changed

- **Decoupled Step Instantiation from Storage**:
  - `Step.create(action)` and `Step.create(name, action)` no longer write to `defaultStorageManager.chains`.
  - Step instances are pure, reusable execution units with zero global side effects.
  - Step names are now treated as optional debug labels for logging and `$steps` namespacing rather than mandatory registration keys.
- **Removed Code-in-Storage Loophole**:
  - Distributed databases (Redis, MongoDB) now strictly store execution state, telemetry, checkpoints, and cached outputs. Executable TypeScript closures remain in application code bundles.
- **Refactored Execution Runner**:
  - Internal runner (`runner.ts` and `StartChain.ts`) executes steps directly via object references instead of querying `state.chains`.
  - Automatically invokes `adapter.saveCheckpoint` upon workflow completion before deleting in-memory stacks.\n
### Deprecated

- **Legacy String Code Registry APIs**:
  - `putChain(name, chain)` &mdash; Use direct step references and `flow(...)`.
  - `getChain(name)` &mdash; Code lookup by string is deprecated; use direct imports.
  - `Step.exists(name)` and `isExists(name)` &mdash; Deprecated since steps are direct instances.
  - `setPutChainPlugin(plugin)` and `setGetChainPlugin(plugin)` &mdash; Deprecated. Step code belongs in repositories; use `StorageAdapter` for state.
  - `setPutChainContextPlugin(plugin)` and `setGetChainContextPlugin(plugin)` &mdash; Deprecated in favor of `StorageAdapter.onContextChange`.

### Fixed

- Fixed global memory leak where repeated step definitions accumulated in `defaultStorageManager.chains`.
- Fixed naming collision where two steps with the same name threw `ChainWithTheSameNameException` across concurrent flows.
- Fixed cache key serialization where function getters were stripped by `JSON.stringify`, leading to cache key collisions.
- Fixed non-configurable/non-writable property proxy invariant errors in V8.

---

## [1.0.0] - 2026-10-16

### Initial Release

- Core composable step pipelines (`Step`, `flow`, `Chain`, `pipe`).
- Parameter contracts via `.spec()`.
- Standard Schema & Zod support (`.schema()`).
- Lifecycle hooks: `.onBefore()`, `.onAfter()`, `.onSkip()`, `.onFail()`.
- Deterministic caching (`.cache()`).
- Array reduction steps (`.reduce()`).
- In-memory `StorageManager` isolation.
- Cooperative cancellation via `AbortSignal`.
