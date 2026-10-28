# Changelog

All notable changes to `Rivulet` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-10-27

### General Availability Release

This is the initial production release of **`Rivulet`** (v1.0.0), marking the transition from pre-v1 (`0.6.1`) to a fully stabilized, enterprise-grade workflow orchestration ecosystem.

`Rivulet` is a lightweight, zero-dependency in-process workflow orchestrator for TypeScript and Node.js. It combines functional composition with end-to-end accumulated context inference, deterministic test tooling, distributed ecosystem adapters, durable event-driven execution, and architecture visualization.

---

### Core Workflow Engine (`Rivulet`)

#### Pipeline Composition & Execution
- **Functional Composition (`flow` / `Step`)**: Construct linear and branched workflows without global registries. Steps are pure, reusable execution units.
- **Modern POJO Mode (`.modern()` / `{ pojo: true }`)**: Direct object destructuring and frozen plain outputs without accessor closures.
- **End-to-End TypeScript Context Inference**: Automatic compile-time context aggregation across sequential steps, including typed step history (`$steps[stepName]`).
- **5-Phase Step Lifecycle**: Deterministic lifecycle execution:
  1. `onBefore`: Conditional execution guards; returning `false` skips the step.
  2. Action Execution: Core business logic execution.
  3. `onAfter`: Post-execution enrichment and context modification.
  4. `onSkip`: Fallback handling when `onBefore` skips execution.
  5. `onFail`: Structured retries with exponential backoff, jitter, and error recovery.

#### Concurrency & Routing Combinators
- **Parallel Fan-Out (`parallel`, `all`)**: Concurrently execute branches with branch context isolation, configurable merge strategies (`shallow`, `deep`, `error`, custom), and fail-fast cancellation.
- **Result Aggregation (`allSettled`)**: Concurrently run branches and collect all results and errors without failing fast.
- **Speculative Racing (`race`)**: First branch to settle resolves; losing branches are aborted cooperatively.
- **Dynamic Branching (`when`, `branch`)**: Conditional if-then-else branching and multi-path key/predicate routing.
- **Bounded Concurrency Mapping (`map`)**: Process arrays or async iterables through worker pools with configurable concurrency limits and error collection.

#### Resilience & Error Handling
- **Sagas & LIFO Compensations (`step.compensate`)**: Automatic reverse-order compensation execution when downstream steps fail.
- **Scoped Idempotency (`step.idempotent`)**: Deterministic hash-based idempotency keys, claim locking, and TTL management.
- **Two-Tier Timeouts**:
  - `step.timeout(ms)`: Per-step SLA enforcement.
  - `flow.timeout(ms)`: Cumulative workflow deadline enforcement.
- **Structured Retries**: Exponential, linear, or fixed backoff with jitter and retry callbacks.
- **Standardized Error Hierarchy**: Rooted at `RivuletError`, with typed exceptions for timeouts, cancellation, validation, saga compensation, and idempotency conflicts.
- **Cooperative Cancellation**: Automatic `AbortSignal` propagation to HTTP clients, database queries, and async timers.

#### Durable Execution & Storage
- **Durable Waits (`waitForEvent`, `wait`)**: Suspend workflows until external events arrive or durations elapse without holding active memory threads.
- **Checkpoint Persistence**: Serialized stack snapshots with optimistic concurrency control (OCC) and revision tracking.
- **Workflow Versioning & Migrations**: Declare workflow versions (`flow.version('1.0.0')`) and register migration transform functions for schema evolution.
- **Distributed Storage Contract (`StorageAdapter`)**: Unified interface for checkpointing, step output caching, real-time context streaming, and namespace isolation.

#### Graph Compilation & Visual Export
- **Workflow AST (`toGraph`, `inspectGraph`, `validateGraph`)**: Declarative AST representation with cycle detection and reachability validation.
- **Architecture Export**:
  - `workflow.toMermaid()`: Mermaid flowchart diagrams with policy badges (timeouts, retries, sagas, cache, wait).
  - `workflow.toDot()`: Graphviz DOT format diagrams.
  - `workflow.toJSON()`: Clean, JSON-serializable AST structures.

#### Backwards Compatibility
- **100% Backwards Compatibility with 0.x**: Preserved aliases for `Chain`, `pipe`, `Pipeline`, and `Func`, legacy getter closure accessors, and mixed execution of legacy and modern steps.

---

### Ecosystem Packages

#### Developer Tools & CLI (`@rivulet/cli`)
- Terminal executable (`Rivulet`) and programmatic API:
  - `rivulet init [dir]`: Scaffolds a complete TypeScript starter workflow project with test suite.
  - `rivulet generate workflow <name>`: Scaffolds strongly-typed workflows with companion tests.
  - `rivulet generate step <name>`: Scaffolds strongly-typed steps with unit tests.
  - `rivulet export <file>`: Exports workflow diagrams to Mermaid, Graphviz DOT, or JSON with `--direction` and `--out`.
  - `rivulet visualize <file>`: Renders interactive Mermaid or text diagrams in terminal.
  - `rivulet validate <file>`: Statically validates workflow ASTs for cyclic dependencies.
  - `rivulet inspect <file>`: Inspects AST topology and complexity metrics with field redaction.
  - `rivulet checkpoint <file>`: Inspects serialized checkpoint state JSON files.
  - `rivulet replay <fixture>`: Replays recorded test fixtures and reports output discrepancies.

#### Deterministic Testing Harness (`@rivulet/testing`)
- **Virtual Clock (`FakeClock`)**: Deterministically advance time and timers without real-time delays.
- **`WorkflowHarness`**: Complete testing harness with step spies, mock implementations, trace history, and event injection.
- **Assertions**: Specialized assertions (`assertStepExecuted`, `assertStepRetried`, `assertStepFailed`).
- **`InMemoryStorageFake`**: In-memory storage adapter for zero-infrastructure checkpoint and cache testing.
- **Execution Replay (`replayExecution`)**: Replay execution records against workflow definitions with golden parity assertions.

#### Observability & Distributed Tracing (`@rivulet/opentelemetry`)
- Automatic root workflow span and child step spans with retry attempt counters.
- Standardized semantic attributes (`rivulet.workflow.name`, `rivulet.step.name`, `rivulet.step.attempt`, `rivulet.stack.id`, `rivulet.namespace`).
- W3C Trace Context propagation helpers (`injectTraceContext`, `extractTraceContext`, `getTraceHeaders`).
- Telemetry storage adapter streaming sanitized context attributes with configurable redaction.

#### Distributed Storage Adapters
- **PostgreSQL (`@rivulet/postgres`)**:
  - ACID transactional checkpoint persistence (`ensureTables`, `saveCheckpoint`, `getCheckpoint`).
  - Audit event logging and automated retention cleanup policies.
  - Transactional idempotency store with claim locking.
- **Redis (`@rivulet/redis`)**:
  - High-performance checkpointing and distributed step output caching.
  - Redis-backed idempotency store with automatic TTL expiration.
  - Distributed lock (`RedisLock`) for single-flight coordination.

#### Event Brokers & Queue Adapters
- **Kafka (`@rivulet/kafka`)**: Consumer batch processor with header correlation and W3C trace context extraction.
- **BullMQ (`@rivulet/bullmq`)**: Job processor with job progress tracking and idempotency deduplication.
- **AWS SQS (`@rivulet/sqs`)**: Batch message consumer with partial batch item failure reporting (`batchItemFailures`).

#### HTTP Middleware & Route Handlers
- **Express (`@rivulet/express`)**: Middleware and route handlers with status code mapping and error propagation.
- **Fastify (`@rivulet/fastify`)**: Native Fastify route handler integration with header correlation.
- **Hono (`@rivulet/hono`)**: Route handler supporting edge runtimes and Web Standards `Request`/`Response`.

---

### Documentation & Reference Guides

- **12 Dedicated Topic Guides** (`docs/01-` to `docs/12-`):
  1. Getting Started
  2. Core Concepts
  3. Sequential Workflows
  4. Branching and Parallelism
  5. Retries, Timeouts, and Cancellation
  6. Durable Workflows
  7. Storage and Adapters
  8. Observability
  9. Testing and Replay
  10. TypeScript Reference
  11. Migration and Compatibility
  12. Production Operations
- **Ecosystem Adapter Documentation**: Complete guides in [`docs/adapters/`](docs/adapters/).
- **Formal Runtime Contracts**:
  - [Execution Semantics Contract](docs/execution-semantics.md)
  - [Error Model & Hierarchy](docs/error-model.md)
  - [Storage & Checkpoint Contract](docs/storage-contract.md)
  - [Idempotency & Deduplication](docs/idempotency.md)
  - [Compensation & Sagas](docs/compensation-and-sagas.md)
  - [Durable Waits Contract](docs/durable-waits.md)
