# Changelog

All notable changes to `Siglo` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.3.0] - 2026-11-23

### Added

- **Synchronous Dynamic Options & Duration Ergonomics (`@siglo/core`, `@siglo/http`, `@siglo/notifications`, `@siglo/crypto`, `@siglo/ai`)**:
    - Added `DynamicOption<T, TContext>` (`T | ((ctx: TContext) => T)`) and `resolveDynamic` helper in `@siglo/core/shared` to allow steps to synchronously read accumulated context produced by preceding steps without async serialization pitfalls or hidden I/O.
    - Added `DurationInput` (`number | string`) and hardened `parseDuration` supporting human-readable strings (`"500ms"`, `"30s"`, `"5m"`, `"2h"`, `"1d"`) and numeric strings across timeouts, TTLs, and backoff delays.
    - Standardized durable `wait(durationOrMs)` and `waitForEvent(eventName, options)` to accept dynamic duration and correlation key resolvers (`DynamicDuration`, `DynamicOption<string>`) with `NoInfer<TContext>` type guards and `WaitNode` DAG support.
    - Added ergonomic duration strings to `Step.timeout()`, `Flow.timeout()`, `ExecutionOptions.timeout`/`timeoutMs`/`idempotencyTtlMs`, `IdempotencyOptions.ttl`/`ttlMs`, `RetryConfig.delay`/`maxDelay`, `CompensationOptions.delay`, and `Step.cache()`.
    - Standardized `ExecutionOptions.idempotencyKey`, `IdempotencyOptions.key`, and `Step.idempotent()` on `DynamicOption<string, TContext>`, supporting both `step.idempotent(keyOrFn, options)` and object-first configuration.
    - Extended `@siglo/notifications`: `SendNotificationOptions` (`channel`, `recipient`, `subject`, `template`, `data`) and `InteractiveApprovalOptions` (`recipient`, `title`, `description`, `correlationKey`, `timeout`) on `DynamicOption`; `deduplicationTtl` accepts `DurationInput`.
    - Extended `@siglo/http`: `url`, `headers`, `query`, and `body` on `DynamicOption`; added `timeout` and `timeoutMs` support as `DurationInput`; enforced early `onBefore` ASL policy verification on dynamic URLs.
    - Extended `@siglo/crypto`: Standardized `aad`, `deriveKeyContext`, `secret`, and `provider` on `DynamicOption`; preserved `secretKey` async resolution and sync request extractors.
    - Extended `@siglo/ai`: Standardized `AiModelConfig.apiKey` and `AiStepOptions.prompt` on `DynamicOption`; `requestTimeoutMs` accepts `DurationInput`; ensured input schema validation runs prior to model resolution; normalized duration representations for deterministic `AiStep.cache()` key generation.
    - Added parser tests to `@siglo/ide-analysis` verifying zero-execution extraction of dynamic context expressions and duration configurations.
- **In-Process ASL Network Egress Policy Inheritance**:
    - Hardened `StartChain.ts` to merge and intersect enclosing `networkPolicyStorage.getStore()` with step/sub-flow policies, guaranteeing nested `parallel`, `branch`, `map`, and `Step.create(subFlow)` cannot widen outer perimeters.
    - Hardened `CompensationManager` and `flow.compensate(stackId)` to capture and re-apply effective step network policies during automatic and checkpoint-hydrated Saga rollback compensations.
- **Synchronous Compute Steps (`Step.compute`) (`@siglo/core`, `@siglo/opentelemetry`, `@siglo/testing`, IDE Tooling)**:
    - Added `Step.compute` / `ComputeStep` for synchronous non-I/O CPU logic with zero-microtask fast-path batching in `ArrayChain` and `StartChain`, unconditional always-deny ASL network guardrails (`COMPUTE_NETWORK_POLICY`), fail-fast thenable guards, synchronous `.spec()` validation (`runSpecsSync`), bounded LRU + TTL in-memory `.cache()` (`ComputeCache`), and graph/diagram annotations (`toGraph`, `toMermaid`, `toDot`, `toJSON`).
    - Added dual sync/async `stepExecutionHook` and `siglo.step.kind = 'compute'` / `siglo.cache.hit` span attribution in `@siglo/opentelemetry`.
    - Extended `@siglo/testing` (`WorkflowHarness`) to preserve synchronous wrapping, spies, mocks, assertions, and trace parity for `ComputeStep`.
    - Extended `@siglo/ide-protocol`, `@siglo/ide-analysis`, `@siglo/ide-ui`, `@siglo/vscode`, and the IntelliJ IDEA plugin to parse, render, exempt from `SIGLO_MISSING_COMPENSATION`, and execute single or ranged `Step.compute` steps.

### Fixed

- **Type Safety, Boundary Validation & Strictness Hardening**:
    - Replaced unsafe `any` signatures and catch bindings with `unknown` and runtime validation across JSON-RPC messages, telemetry sanitization, `.siglo/run.json`, webhook/API payloads, and IDE/Monitor UI bridges.
    - Added exhaustive `never` checks on discriminated status/ecosystem switches and fixed falsy `0` / `0ms` duration and status handling across UI and core helpers.
    - Tightened TypeScript and ESLint coverage (`noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`) across IDE UI, Monitor UI, and test suites.

### Changed

- Synchronized monorepo packages, CLI, telemetry, and IDE plugin distributions at `1.3.0`.
- Updated internal `@siglo/*` workspace and example dependency ranges to `^1.3.0`.
- Synchronized bundled IntelliJ plugin assets (`analyzer.js`, `prepare.cjs`, `ide-ui/index.html`) for `1.3.0`.

## [1.2.8] - 2026-11-18

### Added

- **Query Adapter, GraphQL API & Model Context Protocol (MCP) Server (`@siglo/query`, `@siglo/query/mcp`, `@siglo/postgres`)**:
    - Added `WorkflowQueryEngine` (`createWorkflowQueryEngine`) with accumulated context materialization, recursive secret redaction (`redactFields`), deterministic base64 cursor pagination, and `MemoryStorageAdapter` fallback.
    - Added standard GraphQL SDL contract (`WORKFLOW_SCHEMA_SDL`, `createWorkflowGraphQLSchema`) with custom `JSON` and `DateTime` scalars, AST-driven zero-cost context projection, root `Query`/`Mutation`/`Subscription` resolvers, and strict tenant namespace guardrails.
    - Extended `@siglo/postgres` with native `queryWorkflows` support, conditional `state->'contexts'` projection, composite cursor pagination indexes, and GIN metadata indexes.
    - Added real-time GraphQL subscription transports over Server-Sent Events (SSE with configurable proxy heartbeats) and WebSockets (`graphql-ws`).
    - Added drop-in GraphQL & SSE route handlers for Express (`createExpressQueryMiddleware`), Fastify (`fastifyQueryPlugin`), and Hono (`createHonoQueryHandler`).
    - Added AI-native Model Context Protocol (MCP) server (`@siglo/query/mcp`, `createWorkflowMcpServer`) over `stdio` and `sse` transports with tools (`search_workflows`, `inspect_workflow`, `execute_workflow_query`, `resume_workflow`), resources (`siglo://workflows/active`, `siglo://workflows/{stackId}`, `siglo://schema/graphql`), and the `diagnose_failure` prompt template.
    - Published adapter reference and tutorials in `docs/adapters/query.md`, `docs/querying-workflows-graphql.md`, and `docs/querying-workflows-mcp.md`.

### Changed

- Synchronized monorepo packages, CLI, telemetry, and IDE plugin distributions at `1.2.8`.

## [1.2.7] - 2026-11-17

### Added

- **AI Agent Skills: Zero-Trust Security & Runtime Resilience (`skills/`, `.agents/skills`, `@siglo/cli`, `@siglo/core`)**:
    - Added `siglo-security-and-guardrails`: Declarative in-process zero-trust network perimeter guardrails via AsyncLocalStorage (`allowNetwork`, `denyNetwork`, `allowUnixSockets`, `networkPolicy`), `NetworkPolicyViolationException` handling, and cryptographic envelope protection with `@siglo/crypto`.
    - Added `siglo-runtime-and-resilience`: Runtime execution controls via `ExecutionOptions` (`signal: AbortSignal`, `timeout`, `services`, `namespace`, `pojo`), pre-flight AST graph verification with `assertValidGraph()`, structured error taxonomy, and Dead-Letter Queue (DLQ) escalations on unresolvable saga compensations.
    - Enhanced `siglo-workflow-development`: Added full awareness and documentation for Step input contracts (`.spec()`, `.strict()`, `.schema()`) with async validation predicates, sanitizing transformers, translation/remapping, default fallbacks, and strict parameter filtering.
    - Updated hands-on interactive tutorial in `docs/agent-skills.md` with idiomatic zero-trust security perimeter lockdown and resilient runner patterns.

### Changed

- Synchronized monorepo packages, CLI, telemetry, and IDE plugin distributions at `1.2.7`.

## [1.2.6] - 2026-11-16

### Added

- **AI Agent Skills Suite & CLI Distribution (`skills/`, `.agents/skills`, `@siglo/cli`, `@siglo/core`)**:
    - Published comprehensive suite of four specialized Agent Skills for AI coding assistants (Antigravity, JetBrains AI, Cursor, Claude Code, GitHub Copilot):
        - `siglo-workflow-development`: 5-phase step lifecycle, accumulated context inference, automatic LIFO Saga compensations, retries with exponential backoff & jitter, combinators (`parallel`, `race`, `when`, `branch`, `map`), and Mermaid diagram exports.
        - `siglo-durable-workflows`: Asynchronous event suspensions (`waitForEvent`), durable timer sleeps (`wait`), webhook resumptions, PostgreSQL & Redis OCC persistence adapters, and zero-downtime state migrations.
        - `siglo-ecosystem-adapters`: Web framework middlewares (Express, Fastify, Hono), background queue workers (BullMQ, Kafka, AWS SQS partial batch responses), multi-provider AI steps (`@siglo/ai`), resilient HTTP (`@siglo/http`), and OpenTelemetry tracing.
        - `siglo-testing-and-replay`: Zero-flake testing harness (`createWorkflowHarness`), step mocks & spies, virtual clock time travel (`FakeClock`), and golden execution replay.
    - Added `siglo skills install` (and `siglo skills add`) CLI command in `@siglo/cli` to install skills directly into local `.agents/skills` directories.
    - Integrated automatic Agent Skills scaffolding into `siglo init`.
    - Bundled verified skills inside `@siglo/core` and `@siglo/cli` npm tarballs.
    - Published interactive tutorial documentation in `docs/agent-skills.md` and registered under Developer Tools in `docs/docs.json`.

### Changed

- Synchronized monorepo packages, CLI, telemetry, and IDE plugin distributions at `1.2.6`.

## [1.2.5] - 2026-11-15

### Added

- **Distributed Cross-Service Workflows & Multi-Domain Correlation (`examples/src/distributed-domains-stackid`, `examples/distributed-cross-service-workflows`)**:
    - Added parent-child correlated workflow pattern linking independent domain workflows (Order Service → Fulfillment Service) through explicit stack ID propagation (`${stackId}:fulfillment`) and tenant namespace propagation (`x-tenant-id` / `x-namespace`).
    - Added runnable multi-service architecture with Redis event pub/sub transport, standalone HTTP servers, and containerized Docker Compose environment.
    - Published comprehensive multi-domain guide in `docs/distributed-cross-service-workflows.md`.

### Fixed

- **Live Monitoring Dashboard Namespace Filtering (`@siglo/monitor`)**:
    - Fixed issue where selecting a namespace in the Live Monitor header dropdown failed to filter workflow runs in `RunList` and `StatsOverview`.
    - Preserved discovered tenant namespaces in the header dropdown to enable 0ms instantaneous tenant switching without re-establishing SSE connections.
    - Added tenant namespace indicator badges to workflow list item cards.
    - Synced selected namespace filter to browser URL query parameter (`?namespace=...`) via `window.history.replaceState`.
    - Scoped `useWorkflowMonitor` state hydration and event ingestion to the active namespace partition.

### Changed

- Synchronized monorepo packages, CLI, telemetry, and IDE plugin distributions at `1.2.5`.

## [1.2.4] - 2026-11-14

### Added

- **IDE Interactive Step & Range Runner (`@siglo/ide-runner`, `@siglo/ide-ui`, `@siglo/ide-protocol`, `@siglo/vscode`, IntelliJ Plugin)**:
    - Added the **Run** tab in the visualizer right panel to execute real application code for a single step or an inclusive sequential step range (`reserveStock → chargePayment`).
    - Added `executionRange` topology calculation in `@siglo/ide-protocol` to resolve sequential ranges, reject invalid/boundary-crossing selections, and highlight active paths on the DAG canvas.
    - Added isolated child worker process execution in `@siglo/ide-runner` communicating over newline JSON stdio / IPC using project `tsx` and local Node.js.
    - Added support for `.siglo/run.json` project configuration (`cwd`, `setupModule`, `env` overrides).
    - Added input JSON formatting, live step status tracking (`Running...`, `Completed`, `Failed`, `Cancelled`), execution elapsed timers, Pretty and Raw JSON output views with one-click clipboard copying, and safe cancellation.
    - Added core step execution hooks (`ExecutionOptions.onStepResult`) in `@siglo/core` exposing unredacted local step return values to the IDE runner.

### Changed

- Synchronized monorepo packages, CLI, telemetry, and IDE plugin distributions at `1.2.4`.
- Updated IntelliJ plugin documentation and marketplace assets with `06-step-runner.png` screenshot and runner execution guide.
- Updated split-screen hero GIF (`docs/assets/hero-split-screen.gif`) and IDE code sync GIF (`docs/assets/ide-code-sync.gif`) to demonstrate the interactive step runner.

## [1.2.3] - 2026-11-12

### Added

- **IDE Static Diagnostics (Milestone 2 - `@siglo/ide-analysis`, `@siglo/vscode`, IntelliJ Plugin)**:
    - Surface in-editor diagnostic annotations and warnings without executing application code:
        - DAG cyclic dependency detection (`SIGLO_STATIC_CYCLE`).
        - Missing compensation warnings for sagas with side-effect steps (`SIGLO_MISSING_COMPENSATION`).
        - Unhandled error branch warnings in durable workflows (`SIGLO_UNHANDLED_ERROR_BRANCH`).
        - Duplicate step ID validation within the same workflow (`SIGLO_DUPLICATE_STEP_ID`).
    - Integrated via `DiagnosticCollection` in VS Code and `SigloWorkflowInspection` (`LocalInspectionTool`) / `SigloWorkflowAnnotator` (`ExternalAnnotator`) in IntelliJ IDEA.

- **Ecosystem Deep-Dive Inspectors & Offline Telemetry (Milestone 4 - `@siglo/ide-protocol`, `@siglo/ide-ui`, `@siglo/vscode`, IntelliJ Plugin)**:
    - Dedicated inspector panels for HTTP, Crypto, Notification, and AI ecosystem steps.
    - Offline local JSON telemetry recording import (`Siglo: Import Telemetry Recording...` in VS Code and `Import Siglo Telemetry Recording...` in IntelliJ).
    - Unambiguous workflow/version and step identity source matching with fail-closed secret redaction (credentials, raw payloads, and authorization headers never touch the webview DOM or clipboard).

### Changed

- Synchronized monorepo package, CLI, telemetry, and IDE plugin distributions at `1.2.3`.
- Updated plugin README guides, documentation, and marketplace listing assets with new screenshot `05-ecosystem-telemetry.png` and diagnostic/telemetry capabilities.

## [1.2.2] - 2026-11-10

### Fixed

- **IDE Static Analysis (`@siglo/ide-analysis`, `@siglo/vscode`, IntelliJ Plugin)**: Added pure static AST resolution for `SpreadElement` (`...`), `.steps` flow properties, local/imported flow & step factories, and relative ES/CommonJS imports (named, aliased, default, namespace, re-exports) without executing application code. Fixes `Unresolved expression` on `...createCheckout(services).steps` in `examples/src/distributed-checkout/api.ts`.
- **Cross-File Workflow Navigation (`@siglo/ide-protocol`, `@siglo/ide-ui`, `@siglo/vscode`, IntelliJ Plugin)**: Clicking imported steps, workflow titles, or related files in the workflow view opens the corresponding source file at its definition range while preserving in-file cursor tracking.
- **VS Code Marketplace Icon (`@siglo/vscode`)**: Added `media/siglo-logo-128.png` and declared `"icon"` in `plugins/vscode/package.json`.

### Changed

- Synchronized package, CLI, telemetry, and IDE plugin versions at `1.2.2`.

## [1.2.1] - 2026-11-09

### Security

- **Core Prototype Pollution Defense (`@siglo/core`)**: Blocked `__proto__`, `constructor`, and `prototype` in context resolution, POJO proxy serialization, and storage key assignment (`CORE_RESERVED_KEYS`). Initialized internal context storage maps with prototype-free `Object.create(null)`.
- **Network Perimeter DNS Rebinding & TOCTOU Defense (`@siglo/core`)**: Hardened low-level socket interception to actively validate destination IP addresses against private and cloud metadata subnets (`169.254.169.254`, RFC1918, loopback) even when requests are pre-validated at the HTTP transport layer.
- **Client-Controllable Durability Guardrail (`@siglo/express`)**: Added `allowClientDurableToggle` (default: `false`), preventing untrusted HTTP callers from arbitrarily forcing durable execution and storage write amplification via headers or query parameters.
- **Cryptographic Key Derivation Hardening (`@siglo/crypto`)**: Hardened AES-256-GCM cipher passphrase handling to use salted PBKDF2 (`HMAC-SHA256`, 10,000 iterations) instead of single-round unsalted SHA-256 for non-32-byte passphrases.
- **Monitor Origin Access Control & Security Warnings (`@siglo/monitor`)**: Restricted default CORS access in the monitoring server to loopback origins (`localhost` / `127.0.0.1`), returning `Access-Control-Allow-Origin: null` for untrusted origins unless explicitly configured, and added process security warnings when binding to `0.0.0.0` without authentication.

### Changed

- Synchronized package, CLI, telemetry, and IDE plugin versions at `1.2.1`.

## [1.2.0] - 2026-11-08

### Removed

- **Breaking Change**: Removed `Flow.prototype.execute` and `Flow.prototype.start` methods in favor of `Flow.prototype.run`. Workflows instantiated with `flow(...)` now solely expose `.run(input?, options?)` for execution. Note that individual `Step.prototype.execute` and `Step.prototype.run` remain supported.
- Removed documentation, guides, and test references to `flow.execute` and `flow.start`.

### Changed

- Standardized all core combinators (`branch`, `map`, `parallel`), durable resumption, and ecosystem integration tests on `flow(...).run(...)`.
- Synchronized package, CLI, telemetry, and IDE plugin versions at `1.2.0`.

### Fixed

- Fixed `@siglo/ai` telemetry completion failure tolerance branch coverage under multi-line formatting without propagating observability errors to inference outcomes.

## [1.1.0] - 2026-11-07

### Added

- Kafka order-routing tutorial with scenario publishing, live workflow monitoring, and an optional OpenTelemetry dashboard stack.
- Kafka recovery and transactional outbox integration coverage, including consumer crashes and rebalancing.
- Monitoring scenarios that export OTLP traces and expose workflow and retry metrics to Prometheus.

### Fixed

- Live monitor route visualization and step details beside the workflow graph.
- Graph metadata now links combinators to runtime step IDs without mutating reusable graph nodes.
- OpenTelemetry retry attempt counts now reset for each execution of a reused step.
- Standalone monitoring scenarios flush traces before exit and honor OTLP endpoint and header settings.

### Changed

- Run every example test file in the example test suite, including Kafka telemetry and durable checkout coverage.
- Align exploratory graph checks with runtime step metadata enrichment and verify graph immutability.
- Synchronize package, CLI, telemetry, and IDE plugin versions at `1.1.0`.

## [1.0.0] - 2026-10-27

### General Availability Release

This is the initial production release of **`Siglo`** (v1.0.0), marking the transition from pre-v1 (`0.6.1`) to a fully stabilized, enterprise-grade workflow orchestration ecosystem.

`Siglo` is a lightweight, zero-dependency in-process workflow orchestrator for TypeScript and Node.js. It combines functional composition with end-to-end accumulated context inference, deterministic test tooling, distributed ecosystem adapters, durable event-driven execution, and architecture visualization.

---

### Core Workflow Engine (`Siglo`)

#### Pipeline Composition & Execution

- **Functional Composition (`flow` / `Step`)**: Construct linear and branched workflows without global registries. Steps are pure, reusable execution units.
- **Clean POJO Parameters (Default)**: Direct object destructuring and frozen plain outputs by default without legacy accessor closures.
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
- **Standardized Error Hierarchy**: Rooted at `SigloError`, with typed exceptions for timeouts, cancellation, validation, saga compensation, and idempotency conflicts.
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

#### Developer Tools & CLI (`@siglo/cli`)

- Terminal executable (`Siglo`) and programmatic API:
    - `siglo init [dir]`: Scaffolds a complete TypeScript starter workflow project with test suite.
    - `siglo generate workflow <name>`: Scaffolds strongly-typed workflows with companion tests.
    - `siglo generate step <name>`: Scaffolds strongly-typed steps with unit tests.
    - `siglo export <file>`: Exports workflow diagrams to Mermaid, Graphviz DOT, or JSON with `--direction` and `--out`.
    - `siglo visualize <file>`: Renders interactive Mermaid or text diagrams in terminal.
    - `siglo validate <file>`: Statically validates workflow ASTs for cyclic dependencies.
    - `siglo inspect <file>`: Inspects AST topology and complexity metrics with field redaction.
    - `siglo checkpoint <file>`: Inspects serialized checkpoint state JSON files.
    - `siglo replay <fixture>`: Replays recorded test fixtures and reports output discrepancies.

#### Deterministic Testing Harness (`@siglo/testing`)

- **Virtual Clock (`FakeClock`)**: Deterministically advance time and timers without real-time delays.
- **`WorkflowHarness`**: Complete testing harness with step spies, mock implementations, trace history, and event injection.
- **Assertions**: Specialized assertions (`assertStepExecuted`, `assertStepRetried`, `assertStepFailed`).
- **`InMemoryStorageFake`**: In-memory storage adapter for zero-dependency testing.
- **Execution Replay (`replayExecution`)**: Replay execution records against workflow definitions with golden parity assertions.

#### Observability & Distributed Tracing (`@siglo/opentelemetry`)

- Automatic root workflow span and child step spans with retry attempt counters.
- Standardized semantic attributes (`siglo.workflow.name`, `siglo.step.name`, `siglo.step.attempt`, `siglo.stack.id`, `siglo.namespace`).
- W3C Trace Context propagation helpers (`injectTraceContext`, `extractTraceContext`, `getTraceHeaders`).
- Telemetry storage adapter streaming sanitized context attributes with configurable redaction.

#### Distributed Storage Adapters

- **PostgreSQL (`@siglo/postgres`)**:
    - ACID transactional checkpoint persistence (`ensureTables`, `saveCheckpoint`, `getCheckpoint`).
    - Audit event logging and automated retention cleanup policies.
    - Transactional idempotency store with claim locking.
- **Redis (`@siglo/redis`)**:
    - High-performance checkpointing and distributed step output caching.
    - Redis-backed idempotency store with automatic TTL expiration.
    - Distributed lock (`RedisLock`) for single-flight coordination.

#### Event Brokers & Queue Adapters

- **Kafka (`@siglo/kafka`)**: Consumer batch processor with header correlation and W3C trace context extraction.
- **BullMQ (`@siglo/bullmq`)**: Job processor with job progress tracking and idempotency deduplication.
- **AWS SQS (`@siglo/sqs`)**: Batch message consumer with partial batch item failure reporting (`batchItemFailures`).

#### HTTP Middleware & Route Handlers

- **Express (`@siglo/express`)**: Middleware and route handlers with status code mapping and error propagation.
- **Fastify (`@siglo/fastify`)**: Native Fastify route handler integration with header correlation.
- **Hono (`@siglo/hono`)**: Route handler supporting edge runtimes and Web Standards `Request`/`Response`.

---

### Documentation & Reference Guides

- **11 Dedicated Topic Guides** (`docs/01-` to `docs/11-`):
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
    11. Production Operations
- **Migration & Evolution Reference**: State and schema migrations documented in [Workflow Versioning](docs/workflow-versioning.md).
- **Ecosystem Adapter Documentation**: Complete guides in [`docs/adapters/`](docs/adapters/).
- **Formal Runtime Contracts**:
    - [Execution Semantics Contract](docs/execution-semantics.md)
    - [Error Model & Hierarchy](docs/error-model.md)
    - [Storage & Checkpoint Contract](docs/storage-contract.md)
    - [Idempotency & Deduplication](docs/idempotency.md)
    - [Compensation & Sagas](docs/compensation-and-sagas.md)
    - [Durable Waits Contract](docs/durable-waits.md)
