# Phase 3: Ecosystem and Adoption

## Goal

Make `fluid-func` easy to introduce into existing TypeScript services by providing integrations, observability, storage adapters, examples, and operational tooling without bloating the core package.

## Outcomes

- Users can integrate workflows with common HTTP, queue, and event systems.
- Workflow execution is visible in standard observability platforms.
- Persistent storage adapters are maintained independently from the runtime.
- Examples demonstrate realistic production patterns.

## Package Structure

Use a monorepo or coordinated repositories with independently versioned packages:

```text
packages/
  core/
  opentelemetry/
  hono/
  fastify/
  express/
  bullmq/
  kafka/
  sqs/
  redis/
  postgres/
  cli/
```

Keep integrations optional so installing `fluid-func` does not install database, web framework, or telemetry dependencies.

## Workstreams

### 1. OpenTelemetry Integration

Create `@fluid-func/opentelemetry`.

#### Spans

- One workflow span per execution
- One span per step
- Child spans for retries and external waits
- Nested flow spans with clear parent-child relationships

#### Attributes

- `fluid.workflow.name`
- `fluid.workflow.version`
- `fluid.workflow.id`
- `fluid.stack.id`
- `fluid.step.name`
- `fluid.step.id`
- `fluid.step.attempt`
- `fluid.tenant.id` only when explicitly permitted
- `fluid.cache.hit`
- `fluid.timeout`

#### Requirements

1. Never record raw secrets or full context by default.
2. Provide field allowlists and redaction hooks.
3. Propagate W3C trace context through queue adapters.
4. Record retries, errors, and cancellation status.
5. Avoid making OpenTelemetry a core dependency.

### 2. HTTP Adapters

Provide adapters for Hono, Fastify, and Express.

```ts
app.post('/checkout', fluidMiddleware(checkoutFlow, {
  input: requestToOrder,
  output: resultToResponse
}));
```

#### Adapter Responsibilities

- Convert request data into typed workflow input
- Propagate request abort signals
- Apply request deadlines as flow timeouts
- Map typed workflow errors to HTTP responses
- Add correlation and workflow IDs to responses
- Redact sensitive error details
- Support streaming or asynchronous handoff where appropriate

Do not hide business behavior inside adapters; they should remain thin integration layers.

### 3. Queue and Event Adapters

Prioritize BullMQ, Kafka, and SQS.

#### Common Features

- Message-to-workflow input mapping
- Message correlation IDs
- Ack only after successful completion
- Retry and dead-letter behavior
- Idempotency integration
- Graceful shutdown
- In-flight cancellation
- Backpressure and concurrency limits
- Workflow status reporting

#### Kafka-Specific Features

- Partition-key mapping
- Offset commit strategy
- At-least-once documentation
- Trace context propagation
- Replay-safe workflow IDs

### 4. Storage Adapters

Prioritize Redis and PostgreSQL.

#### Redis

Support:

- Distributed cache
- Checkpoints
- Idempotency claims
- Locks or single-flight coordination
- Optional execution events

#### PostgreSQL

Support:

- Durable checkpoints
- Execution metadata
- Idempotency records
- Event history
- Retention and cleanup policies

Each adapter should document consistency, transaction, TTL, and failure behavior.

### 5. CLI and Local Inspector

Create `@fluid-func/cli` with commands such as:

```bash
fluid-func init
fluid-func visualize src/workflows/order.ts
fluid-func inspect <workflow-id>
fluid-func replay <workflow-id>
fluid-func checkpoint <workflow-id>
```

#### Initial Scope

1. Print workflow graph as text or Mermaid.
2. Inspect local execution reports.
3. Validate workflow definitions.
4. Replay recorded fixtures.
5. Redact configured fields.

Defer a hosted dashboard until local execution and event formats are stable.

### 6. Examples and Templates

Publish complete examples with tests:

- HTTP checkout workflow
- Background email processing
- BullMQ image processing
- Kafka event enrichment
- AI/RAG ingestion with structured output validation
- Durable human approval workflow
- Saga with compensation
- Multi-tenant SaaS billing

Each example should include:

- Failure behavior
- Retry policy
- Cancellation behavior
- Observability setup
- Storage configuration
- Local run instructions
- Production caveats

### 7. Compatibility and Release Automation

#### Tasks

1. Add CI for Node.js LTS versions.
2. Test ESM and CommonJS consumers.
3. Publish packages with provenance.
4. Generate API docs during release.
5. Use semantic versioning and changelog automation.
6. Add integration tests against supported external services.
7. Publish migration notes for every breaking change.

## Suggested Deliverables

- `@fluid-func/opentelemetry`
- HTTP adapter packages
- Queue adapter packages
- Redis and PostgreSQL adapters
- CLI validation and inspection tools
- Production examples and templates
- Automated release pipeline

## Dependencies

Phase 3 depends on stable public APIs and execution semantics from Phases 1 and 2. Adapter packages should not compensate for ambiguous retry, checkpoint, or cancellation behavior.

