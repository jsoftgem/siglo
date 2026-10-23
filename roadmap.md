# fluid-func Product Roadmap

## Strategic Positioning

`fluid-func` should position itself as:

> A TypeScript-first workflow runtime that starts as an in-process pipeline and can grow into a durable, observable, multi-tenant workflow without requiring Temporal-scale infrastructure.

The strongest opportunity is not competing as another generic function-pipeline helper. The project should focus on resilient backend workflows, order/payment processing, background jobs, AI pipelines, and event-driven business processes.

## Current Differentiators

The project already combines capabilities that are rarely packaged together in a small JavaScript library:

- Direct `Step` and `flow` composition without a global string registry
- TypeScript generics and Standard Schema/Zod-style validation
- Step and workflow timeouts
- Retry policies with backoff and jitter
- `AbortSignal` propagation
- Tenant-aware execution metadata and cache partitioning
- `onBefore`, `onAfter`, `onSkip`, and `onFail` lifecycle hooks
- Pluggable storage for checkpoints, caching, and context events
- POJO execution mode
- Step history through `$steps` and `$history`
- State serialization and checkpoint APIs
- No runtime dependencies in the core package

## Priority Features

### 1. Branching, Parallelism, and Fan-In

The current model is primarily sequential. Production workflows need explicit control-flow primitives:

- `parallel(...)`
- `all(...)`
- `race(...)`
- `when(predicate, step)`
- `branch(...)`
- `retryUntil(...)`
- `foreach(...)` with concurrency limits
- Typed fan-out/fan-in results
- Partial-failure policies such as fail-fast, `allSettled`, and continue-on-error

Example:

```ts
flow(
  validate,
  parallel(reserveInventory, authorizePayment, calculateTax),
  join,
  fulfillOrder
);
```

### 2. Production-Grade Durable Execution

Checkpointing is one of the project’s strongest differentiators, but it needs explicit reliability semantics:

- Resume from the last completed step
- Caller-supplied workflow/execution IDs
- Persisted workflow status: `running`, `waiting`, `failed`, `completed`, and `cancelled`
- Pause/resume APIs
- Human approval and external-event waits
- Step versioning for workflows resumed after deployment
- Atomic checkpoint writes
- Idempotency keys
- Compensation and saga APIs
- Recovery after process or worker failure

The central promise should be that a workflow can safely resume after a crash or deployment.

### 3. OpenTelemetry and Structured Observability

Provide an official package such as `@fluid-func/opentelemetry`. Automatically expose:

- Trace and span IDs
- Workflow and step duration
- Retry and timeout counts
- Cache hits and misses
- Tenant and workflow IDs
- Step status
- Error type and sanitized metadata
- Queue and external-event correlation

Integrations should include OpenTelemetry, Prometheus, Pino, Sentry, and Datadog where practical.

### 4. Visual Workflow Debugging

A local CLI or developer UI would improve usability and differentiate the framework:

- View workflow graphs
- Inspect execution history
- See step inputs and outputs
- Display retries and failures
- Show timeout and latency data
- Replay failed workflows
- Inspect checkpoints
- Redact sensitive fields
- Export traces or execution reports

Potential commands:

```bash
fluid-func inspect execution-id
fluid-func replay execution-id
fluid-func visualize workflow.ts
```

### 5. Official Integration Packages

Keep the core dependency-light and publish integrations separately:

- `@fluid-func/express`
- `@fluid-func/fastify`
- `@fluid-func/hono`
- `@fluid-func/bullmq`
- `@fluid-func/kafka`
- `@fluid-func/sqs`
- `@fluid-func/cloudflare-queues`
- `@fluid-func/opentelemetry`
- `@fluid-func/redis`
- `@fluid-func/postgres`

Adapters should handle correlation IDs, queue acknowledgement, retries, dead-letter queues, idempotency, distributed cancellation, and graceful shutdown.

### 6. Stronger Type Inference

The public API should infer accumulated context and output types across a flow:

```ts
const workflow = flow(
  Step.create<{ userId: string }, { user: User }>(...),
  Step.create<{ user: User }, { account: Account }>(...)
);

// Desired result:
// Promise<{ user: User; account: Account }>
```

Improve:

- Typed context accumulation
- Typed `$steps`
- Typed named-step outputs
- Typed branch results
- Typed retry/failure results
- Composition errors for incompatible steps
- Clear separation between input context, working context, and final output

### 7. Deterministic Testing and Replay

Workflows involving retries, timers, signals, caches, and external services need first-class test support:

- Fake timers for retry and timeout tests
- Step-level mocks
- Recorded execution fixtures
- Checkpoint replay
- Workflow graph snapshot tests
- Cancellation and timeout test helpers
- Dependency injection for external clients

Example:

```ts
const result = await workflow.test(input, {
  fakeTimers: true,
  mock: {
    chargePayment: () => ({ status: 'approved' })
  }
});
```

### 8. Reliability and Security Semantics

Before positioning the project as an enterprise workflow runtime, document and harden:

- Strict, warning, and best-effort storage adapter error modes
- Cooperative cancellation limitations
- Cache stampede prevention and concurrent duplicate execution
- Checkpoint schema/version compatibility
- Sensitive-field redaction and encryption hooks
- Concurrent tenant-isolation tests
- Consistent error metadata including workflow ID, step name, attempt number, and cause

## Recommended Phases

### Phase 1: Product Clarity and Reliability

1. Stabilize the public API and select `Step` and `flow` as the primary vocabulary.
2. Resolve package/version inconsistencies. Package metadata currently reports `1.0.0`, while the changelog describes `2.0.0`.
3. Add consistent error types and error metadata.
4. Define timeout, retry, cancellation, caching, and checkpoint semantics.
5. Generate API documentation from typed examples.
6. Add concurrency, failure-injection, and multi-tenant integration tests.

### Phase 2: Core Workflow Power

1. Add parallel execution and fan-in/fan-out.
2. Add conditional branching.
3. Add concurrency limits.
4. Add idempotency keys.
5. Add compensation and saga support.
6. Add durable pause/resume and external-event waits.

### Phase 3: Ecosystem and Adoption

1. Release the OpenTelemetry package.
2. Release Hono, Fastify, and Express adapters.
3. Release BullMQ, Kafka, and SQS adapters.
4. Release Redis and PostgreSQL storage adapters.
5. Build a local CLI and execution inspector.
6. Publish production-grade examples for orders, background jobs, AI/RAG, and event processing.

### Phase 4: TypeScript and Developer Experience

1. Improve accumulated-context inference.
2. Add typed named-step outputs.
3. Add workflow visualization.
4. Add deterministic replay and testing utilities.
5. Add code generators and starter templates.

## Recommended Initial Niche

Focus first on:

> TypeScript teams building resilient API and background workflows that need retries, deadlines, cancellation, validation, and observability without adopting a heavyweight orchestration platform.

Suggested headline:

> Compose ordinary TypeScript functions into observable, resilient, and resumable workflows.

## Deprioritized Work

Defer the following until the core workflow model is mature:

- Additional API aliases beyond migration compatibility
- More custom parameter proxy behavior
- More lifecycle hooks without a clearly defined execution model
- Built-in database implementations in the core package
- A hosted cloud service before the local runtime is stable
- Storing executable step definitions remotely

The separation between application code and runtime state should remain a core architectural principle.
