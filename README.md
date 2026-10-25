# fluid-func
> A modern, type-safe, and composable workflow orchestrator for TypeScript and JavaScript.

[![NPM Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](https://www.npmjs.com/package/fluid-func)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)]()

`fluid-func` allows you to break complex business logic into clean, reusable, and resilient steps. It combines functional composition with parameter contracts, deterministic caching, lifecycle hooks, structured retry strategies, isolated storage, parallel combinators, sagas with LIFO compensations, scoped idempotency, and durable event-driven waits.

---

## Positioning: In-Process Orchestration vs Distributed Engines

| Dimension | `fluid-func` | Distributed Engines (Temporal, Inngest) |
|---|---|---|
| **Architecture** | Lightweight, zero-infrastructure in-process library | Heavy multi-cluster / external orchestrator daemon |
| **Latency** | Microsecond direct async function invocation | Millisecond-to-second RPC / polling overhead |
| **Footprint** | Zero external dependencies, pure TypeScript | Requires persistent workers, queue servers, and databases |
| **Primary Focus** | Modular workflows, parallel fan-out/fan-in, bounded worker mapping, request-scoped sagas, idempotency, durable event waits, retry backoff with jitter, OCC checkpointing | Months-long durable human-in-the-loop workflows |

---

## Formal Contracts & Documentation

- 📜 [Execution Semantics Contract](docs/execution-semantics.md) &mdash; Formal semantics answering all 9 runtime execution contract questions.
- 🚨 [Error Model & Exception Hierarchy](docs/error-model.md) &mdash; Complete exception hierarchy (`FluidFuncError`), metadata fields, cause preservation, and JSON serialization.
- 💾 [Storage & Checkpoint Contract](docs/storage-contract.md) &mdash; Checkpoint schema v2.0.0, optimistic concurrency (`expectedRevision`), namespace isolation, and error modes (`strict`, `warn`, `best-effort`).
- 🗺️ [Workflow Graph Model](docs/workflow-graph.md) &mdash; AST representations (`toGraph`), acyclic validation, structural inspection (`inspectGraph`), and telemetry.
- ⚡ [Concurrency & Parallelism](docs/concurrency-and-parallelism.md) &mdash; Parallel combinators (`parallel`, `all`, `allSettled`, `race`), branch context isolation, merge strategies, and field collisions.
- 🔑 [Idempotency & Deduplication](docs/idempotency.md) &mdash; Scoped idempotency keys (`buildIdempotencyKey`), claim locking, stores (`InMemoryIdempotencyStore`), and deduplication.
- 🔄 [Compensation & Sagas](docs/compensation-and-sagas.md) &mdash; LIFO rollback sagas (`step.compensate`), retry policies, manual triggers, and failure aggregation.
- ⏳ [Durable Waits & Resumption](docs/durable-waits.md) &mdash; Event waiting (`waitForEvent`), duration parsing (`wait`), durable suspension checkpoints, and resumption (`resumeWorkflow`).
- 🏷️ [Workflow Versioning & Migrations](docs/workflow-versioning.md) &mdash; Version tracking, mismatch detection, and registered state migrations.

---

## Key Features

- ⚡ **Composable Flows (`flow`)** &mdash; Compose steps directly into workflows without global registries; steps are pure execution units.
- 🗺️ **Workflow Graph Model & Inspection** &mdash; Compile flows into pure, JSON-serializable AST nodes (`WorkflowNode`), validate connectivity and cycle freedom (`validateGraph`), and calculate topology metrics (`inspectGraph`).
- 🔀 **Parallel Execution Combinators** &mdash; Run branches concurrently with `parallel`, `all`, `allSettled`, and `race`, equipped with branch context isolation, configurable merge strategies (`'shallow'`, `'deep'`, `'error'`), and fail-fast cancellation.
- 🌿 **Conditional Branching & Routing** &mdash; Dynamic decision routing via `when(predicate, thenStep).otherwise(elseStep)` and multi-branch selectors via `branch({...})`, with skipped step telemetry.
- 🔄 **Dynamic Mapping & Bounded Concurrency** &mdash; Process arrays and `AsyncIterable` collections with `map(items, step, { concurrency })`, order preservation, and configurable error policies (`stopOnError`).
- 🔑 **Scoped Idempotency & Deduplication** &mdash; Protect workflows and individual steps (`step.idempotent()`) with deterministic hash keys (`buildIdempotencyKey`), claim locking, and TTL stores (`InMemoryIdempotencyStore`).
- ⏪ **Sagas & LIFO Compensations** &mdash; Attach rollback handlers (`step.compensate(handler)`) that run automatically in reverse execution order upon workflow failure with structured retries.
- ⏳ **Durable Waits & Event Resumption** &mdash; Pause execution with `waitForEvent(eventName)` or `wait('30m')`, persist suspended checkpoints, and safely resume workflows (`resumeWorkflow`) with event deduplication.
- 🏷️ **Workflow Versioning & State Migrations** &mdash; Declare workflow versions (`flow.version('v2')`), detect version mismatches upon resumption, and run registered state transformation functions.
- 🛡️ **TypeScript First & End-to-End Generics** &mdash; Comprehensive type definitions, input/output generic inference, IntelliSense autocompletion, and robust error contracts.
- ⏱️ **Resilient Deadlines & Two-Tier Timeouts** &mdash; Enforce per-step SLA (`step.timeout(ms)`) with typed `StepTimeoutException` and workflow-level deadlines (`flow.timeout(ms)`, `options.timeout`) with `FlowTimeoutException`.
- 🌐 **Runtime Namespaces & Isolation (`namespace`)** &mdash; Native multi-tenant isolation (`{ namespace: "tenant_123" }`); isolated stacks, context metadata, checkpoints, and cache keys.
- 🔌 **Unified Distributed `StorageAdapter`** &mdash; Interface for real-time telemetry streaming (`onContextChange`), durable checkpoints (`saveCheckpoint` / `getCheckpoint`), and distributed caching.
- 🔀 **Modern Parameter Access & Native Destructuring** &mdash; Access values using native destructuring (`.modern()`), property getters (`param.prop.val`), type coercion, and clean POJO execution (`{ pojo: true }`).
- 📜 **Step-Namespaced History (`$steps` / `$history`)** &mdash; Retain intermediate step outputs across flow execution without collisions; inspect outputs by name, index, or timeline.
- 🔒 **Pure Functional Immutability** &mdash; Zero in-place mutations of caller-supplied input parameters, preventing state contamination.
- 🔁 **Structured Retry Strategies** &mdash; Automatic retries with exponential, linear, or fixed backoff, jitter, and `onRetry` hooks right in `onFail`.
- 📦 **Declarative Contracts & Standard Schema (`spec` / `schema`)** &mdash; Field requirements, defaults, validators, async transformers, translators, and native Standard Schema / Zod / Valibot integration.
- 🛑 **Graceful Cancellation & AbortSignals** &mdash; Cancel flows, in-flight async steps, and retry timers seamlessly using standard `AbortSignal`.
- ⚡ **Deterministic Caching** &mdash; Stable-key hashing with circular reference protection, namespaces, and per-step TTL caching.

---

## Installation

```bash
npm install fluid-func
```

### Import

```typescript
// Core imports
import {
    Step,
    flow,
    parallel,
    all,
    allSettled,
    race,
    when,
    branch,
    map,
    waitForEvent,
    wait,
    resumeWorkflow,
    toGraph,
    inspectGraph,
    validateGraph
} from 'fluid-func';

// Storage, Checkpointing & Serialization
import {
    StorageManager,
    toPOJO,
    checkpoint,
    restoreCheckpoint,
    serializeState,
    hydrateState
} from 'fluid-func';

// Exceptions
import {
    StepTimeoutException,
    FlowTimeoutException,
    CancellationException,
    ValidationException,
    FieldCollisionException,
    IdempotencyConflictException,
    CompensationException,
    WorkflowSuspendedException,
    DuplicateEventException,
    ExpiredWaitException,
    WorkflowVersionMismatchException
} from 'fluid-func';
```

---

## Quickstart: Composable Flows

Build composable workflows with `flow(...)` and execute with modern `async/await`:

```typescript
import { Step, flow } from 'fluid-func';

// 1. Define modular steps
const fetchUser = Step.create(async (param) => {
    return {
        user: { id: param.userId.val, name: 'Alex' }
    };
});

const calculateTax = Step.create(async (param) => {
    const rate = 0.08;
    const tax = param.amount.val * rate;
    return { tax, total: param.amount.val + tax };
});

// 2. Compose into an executable flow
const orderFlow = flow(fetchUser, calculateTax);

// 3. Run the flow
const result = await orderFlow.run({
    userId: 'u_123',
    amount: 100
});

console.log(result.props);
// { userId: 'u_123', amount: 100, user: { id: 'u_123', name: 'Alex' }, tax: 8, total: 108 }
```

---

## Concurrency & Parallel Execution (`parallel`, `all`, `allSettled`, `race`)

`fluid-func` provides built-in combinators for concurrent execution, isolating branch state and preventing race conditions.

```typescript
import { Step, flow, parallel, allSettled, race } from 'fluid-func';

const checkInventory = Step.create('inventory', async () => ({ inStock: true }));
const checkFraud = Step.create('fraud', async () => ({ fraudScore: 0.02 }));
const fetchExchangeRates = Step.create('rates', async () => ({ usdToEur: 0.92 }));

// 1. Parallel execution (fails fast and aborts siblings on error)
const orderPreparation = flow(
    parallel(checkInventory, checkFraud, fetchExchangeRates)
);

const res = await orderPreparation.run({ orderId: 'ord_123' });
console.log(res.inventory.inStock); // true
console.log(res.fraudScore);        // 0.02

// 2. Custom Merge Strategy & Collision Detection
const parallelWithMerge = parallel(
    branchA,
    branchB,
    {
        mergeStrategy: 'error' // Throws FieldCollisionException if branches write the same key
        // Options: 'shallow' (default) | 'deep' | 'error'
    }
);

// 3. allSettled: Collect all results and errors without failing fast
const auditFlow = flow(
    allSettled(serviceA, serviceB, serviceC)
);

// 4. race: First branch to settle wins; losing branches are aborted
const fastestResult = flow(
    race(primaryApiStep, secondaryFallbackStep)
);
```

---

## Conditional Execution & Dynamic Branching (`when`, `branch`)

Route execution conditionally based on context without writing custom workflow wrappers.

### `when` (If-Then-Else)

```typescript
import { Step, flow, when } from 'fluid-func';

const applyVIPDiscount = Step.create(async (p) => ({ discount: 0.20 }));
const applyStandardDiscount = Step.create(async (p) => ({ discount: 0.05 }));

const discountFlow = flow(
    when((ctx) => ctx.isVIP?.val === true, applyVIPDiscount)
        .otherwise(applyStandardDiscount)
);

const result = await discountFlow.run({ isVIP: true });
console.log(result.discount.val); // 0.20
```

### `branch` (Multi-Path Routing)

```typescript
import { Step, flow, branch } from 'fluid-func';

const routingFlow = flow(
    branch({
        selector: (ctx) => ctx.tier.val, // 'gold' | 'silver' | 'bronze'
        branches: {
            gold: goldPipeline,
            silver: silverPipeline,
            bronze: bronzePipeline
        },
        defaultBranch: standardPipeline
    })
);
```

---

## Dynamic Mapping & Bounded Concurrency (`map`)

Process collections or `AsyncIterable` streams through a step or subflow with bounded worker pools:

```typescript
import { Step, flow, map } from 'fluid-func';

const processItem = Step.create(async (item) => {
    return { processedId: item.id, status: 'ok' };
});

const batchFlow = flow(
    map('items', processItem, {
        concurrency: 5,     // Maximum 5 workers in flight simultaneously
        stopOnError: true,  // Abort remaining workers immediately if any item throws
        targetField: 'processedItems' // Field name to store the mapped output array
    })
);

const output = await batchFlow.run({
    items: [{ id: 1 }, { id: 2 }, { id: 3 }]
});

console.log(output.processedItems.val);
// [{ processedId: 1, status: 'ok' }, ...]
```

---

## Scoped Idempotency & Deduplication

Prevent duplicate side effects across retries, re-deliveries, and concurrent requests.

```typescript
import { Step, flow, InMemoryIdempotencyStore } from 'fluid-func';

const customStore = new InMemoryIdempotencyStore();

// Attach idempotency rules to critical steps
const chargeCustomer = Step.create('charge', async (param) => {
    return await stripe.charges.create({ amount: param.amount.val });
}).idempotent((ctx) => `charge:${ctx.orderId.val}`, {
    ttlMs: 60000,
    store: customStore
});

// Or declare idempotency workflow-wide via ExecutionOptions:
const result = await orderFlow.run(orderInput, {
    idempotencyKey: 'order_12345',
    idempotencyTtlMs: 300000
});
```

---

## Sagas & LIFO Compensations (`step.compensate`)

Implement the Saga pattern with automatic backward rollback when any step fails:

```typescript
import { Step, flow, CompensationException } from 'fluid-func';

const reserveSeat = Step.create('reserveSeat', async (p) => {
    const reservation = await bookingApi.reserve(p.seatId.val);
    return { reservationId: reservation.id };
}).compensate(async (ctx) => {
    // Undo action: runs only if subsequent steps fail
    await bookingApi.cancelReservation(ctx.reservationId.val);
});

const chargeCard = Step.create('chargeCard', async (p) => {
    throw new Error('Payment declined');
});

const bookingFlow = flow(reserveSeat, chargeCard);

try {
    await bookingFlow.run({ seatId: '12A' });
} catch (err) {
    if (err instanceof CompensationException) {
        console.error('Workflow failed and compensations were executed:', err.compensationErrors);
    }
}
```

---

## Durable Waits & External Event Resumption

Pause workflows for human approvals, webhooks, or delays, and persist execution state durably:

```typescript
import { Step, flow, waitForEvent, wait, WorkflowSuspendedException } from 'fluid-func';

const orderWorkflow = flow(
    createOrderStep,
    // 1. Suspend workflow until external event arrives or timeout expires
    waitForEvent('payment.received', {
        correlationKey: (ctx) => ctx.orderId.val,
        timeout: '24h' // Supported: '30s', '15m', '2h', '7d', or milliseconds
    }),
    fulfillOrderStep
);

// Worker A: Run until suspension
try {
    await orderWorkflow.run({ orderId: 'ord_999' }, { durable: true });
} catch (err) {
    if (err instanceof WorkflowSuspendedException) {
        console.log(`Workflow suspended waiting for: ${err.eventName} (Key: ${err.correlationKey})`);
        // Checkpoint is automatically written to active StorageAdapter
    }
}

// Worker B: Resume when webhook arrives hours later
const finalResult = await orderWorkflow.resume('ord_999', { paymentId: 'pay_777' });
console.log(finalResult.props);
```

You can also use static duration waits:
```typescript
const delayFlow = flow(
    stepA,
    wait('10m'), // Wait 10 minutes
    stepB
);
```

---

## Workflow Graph Model & Structural Inspection

`fluid-func` workflows compile into pure AST representations (`WorkflowNode`) that can be validated, visualized, and statically analyzed before execution:

```typescript
import { flow, Step, toGraph, validateGraph, inspectGraph } from 'fluid-func';

const myWorkflow = flow(
    stepA,
    Step.parallel(stepB, stepC),
    stepD
);

// 1. Compile to pure AST graph
const graph = myWorkflow.toGraph(); // or toGraph(myWorkflow)
console.log(graph.type); // 'sequence'

// 2. Validate structural integrity & detect cycles
const validation = validateGraph(graph);
if (!validation.isValid) {
    console.error('Graph has cycles or disconnected nodes:', validation.errors);
}

// 3. Inspect topology & metrics
const report = myWorkflow.inspect();
console.log(`Total nodes: ${report.nodeCount}, Max depth: ${report.maxDepth}`);
```

---

## Workflow Versioning & State Migrations

Safely evolve long-running workflow schemas while handling in-flight suspended state:

```typescript
import { flow, Step } from 'fluid-func';

const checkoutV2 = flow(stepA, stepB)
    .version('v2.0.0');

// Resume with state migration for workflows suspended on v1:
const res = await checkoutV2.resume('correlation_key', eventPayload, {
    migrations: {
        'v1.0.0': (oldState) => {
            return {
                ...oldState,
                upgradedField: true
            };
        }
    }
});
```

---

## Execution Resilience & Deadlines (Two-Tier Timeouts)

`fluid-func` establishes a **two-tier timeout architecture**:

| Dimension | **Step-Level Timeout (`step.timeout(ms)`)** | **Flow-Level Timeout (`flow.timeout(ms)` / `options.timeout`)** |
| :--- | :--- | :--- |
| **Primary Purpose** | **Per-operation SLA** (e.g. HTTP request, LLM generation, DB query) | **End-to-end workflow budget** (e.g. API gateway deadline, queue SLA) |
| **Scope** | Confined to a single step's execution lifecycle | Cumulative across all steps, retries, and delays combined |
| **Failure Handling** | Triggers step's **`onFail`** (retries, backoff, or fallback) | Immediately aborts whole workflow; terminates stack and rejects |
| **Exception Type** | `StepTimeoutException` (`stepName`, `timeoutMs`, `elapsedMs`) | `FlowTimeoutException` (`stackId`, `timeoutMs`, `completedSteps`) |

---

## Structured Retry Strategies (`onFail`)

Handle transient failures reliably with configurable retry policies:

```typescript
const resilientStep = Step.create(async () => {
    return await fetchExternalService();
}).onFail({
    maxRetries: 3,
    backoff: 'exponential', // 'fixed' | 'linear' | 'exponential' | ((attempt) => ms)
    delay: 200,            // Base delay in ms
    maxDelay: 2000,        // Max delay cap
    jitter: true,          // Adds randomized jitter to delay
    onRetry: (err, attempt) => {
        console.warn(`Retry attempt #${attempt} due to: ${err.message}`);
    }
});
```

---

## Parameter Contracts with `.spec()` & `.schema()`

Enforce contracts on input parameters per step using declarative rules:

```typescript
import { z } from 'zod';
import { Step } from 'fluid-func';

const registerUser = Step.create(async (param) => ({ registered: true }))
    .spec('email', {
        require: true,
        requireMessage: 'A valid email address is required.',
        validate: async (val) => { if (!val.includes('@')) throw new Error('Invalid email'); }
    })
    .spec('role', { default: 'member' })
    .spec('username', { transform: async (val) => val.trim().toLowerCase() })
    // Standard Schema / Zod validation
    .schema(z.object({
        email: z.string().email()
    }));
```

---

## Pluggable Distributed Storage (`StorageAdapter`)

Connect external persistence (Redis, MongoDB, Kafka, Postgres) for durability, real-time telemetry, and caching:

```typescript
import { Step, StorageAdapter, ContextChangeEvent, SerializedExecutionStack } from 'fluid-func';

class CustomStorageAdapter implements StorageAdapter {
    name = 'CustomStorageAdapter';

    async onContextChange(e: ContextChangeEvent) {
        // Stream telemetry to Kafka or MongoDB
    }

    async saveCheckpoint(checkpoint: SerializedExecutionStack) {
        // Save durable workflow state to Redis or Postgres
    }

    async getCheckpoint(stackId: string) {
        // Restore checkpoint data
    }
}

// Register globally
Step.useStorage(new CustomStorageAdapter());
```

---

## API Reference

### Orchestration & Combinators

| Function / Helper | Description |
| :--- | :--- |
| `flow<TIn, TOut>(...steps)` | Primary workflow orchestrator creating a composable `Flow` instance. |
| `parallel(...steps, options?)` | Runs branches concurrently, failing fast on error and isolating branch contexts. |
| `all(steps, options?)` | Alias for `parallel`. Runs an array or list of branches concurrently. |
| `allSettled(steps, options?)` | Runs branches concurrently and collects all outcomes (values and errors) without failing fast. |
| `race(...steps, options?)` | Settles as soon as the first branch completes; cancels losing branches. |
| `when(predicate, thenStep)` | Conditional execution combinator supporting `.otherwise(elseStep)`. |
| `branch({ selector, branches, defaultBranch? })` | Multi-path dynamic branch router based on selector result. |
| `map(items, step, options?)` | Maps an array or `AsyncIterable` collection through a step with bounded concurrency. |
| `waitForEvent(eventName, options)` | Suspends workflow until the specified external event arrives or timeout occurs. |
| `wait(duration)` | Pauses workflow execution for a duration string (`'10m'`, `'1h'`) or milliseconds. |
| `resumeWorkflow(flow, key, payload?, options?)` | Restores and resumes a suspended workflow from storage. |
| `toGraph(item)` | Compiles any step, flow, or combinator into a JSON-serializable `WorkflowNode` AST. |
| `validateGraph(node)` | Validates graph structure, checking for cycles and disconnected nodes. |
| `assertValidGraph(node)` | Asserts graph validity; throws `GraphValidationException` if invalid. |
| `inspectGraph(item)` | Analyzes workflow AST and returns topographical metrics (node count, depth, edges). |
| `buildIdempotencyKey(scope, params, options?)` | Generates a deterministic hash key for workflow or step idempotency. |

### Step Methods

| Method | Description |
| :--- | :--- |
| `Step.create<TIn, TOut>(action)` | Instantiates a new `Step` execution unit. |
| `step.compensate(handler, options?)` | Registers a compensation rollback handler to run if downstream steps fail. |
| `step.idempotent(keyOrFn?, options?)` | Attaches idempotency deduplication and claim locking to the step. |
| `step.modern()` | Passes unwrapped plain objects directly to step action. |
| `step.schema(schema)` | Validates root context against Standard Schema, Zod, or Valibot. |
| `step.spec(field, options)` | Declares parameter validation, default values, transforms, and translations. |
| `step.strict()` | Isolates step parameters strictly to fields declared via `.spec()`. |
| `step.onBefore(hook)` | Pre-execution guard hook; returning `false` skips the step. |
| `step.onSkip(hook)` | Fallback hook executed when `onBefore` skips the step. |
| `step.onAfter(hook)` | Post-execution hook enriching the output context. |
| `step.onFail(strategy \| callback)` | Configures retry policies (`RetryConfig`) or manual error handler. |
| `step.timeout(ms)` | Sets per-step SLA deadline (throws `StepTimeoutException`). |
| `step.cache(ms)` | Caches step results with namespace-aware partition keys. |
| `step.reduce(arrayField)` | Turns step into an accumulator reducer over an array field. |
| `step.toGraph()` | Generates AST representation of the step. |
| `step.inspect()` | Returns structural metrics of the step graph. |
| `step.run(param?, options?)` | Executes step returning a Promise. |

### Flow Methods

| Method | Description |
| :--- | :--- |
| `flow.run(param?, options?)` | Executes the flow with optional `ExecutionOptions`. |
| `flow.timeout(ms)` | Sets workflow-wide end-to-end deadline (throws `FlowTimeoutException`). |
| `flow.version(v)` | Declares the semantic version of the workflow. |
| `flow.toGraph()` | Compiles the flow into an inspectable `WorkflowNode` AST. |
| `flow.inspect()` | Inspects workflow AST and returns topographical statistics. |
| `flow.resume(key, payload?, options?)` | Resumes a suspended durable flow instance from storage. |
| `flow.compensate(stackId, options?)` | Manually triggers saga compensations for a completed or failed flow stack. |

### ExecutionOptions Interface

| Property | Type | Description |
| :--- | :--- | :--- |
| `signal` | `AbortSignal` | Cancellation signal to abort execution and retry delays. |
| `pojo` | `boolean` | When `true`, resolves output as a plain, frozen JavaScript object. |
| `mode` | `'pojo' \| 'wrapped'` | Explicitly selects `'pojo'` or `'wrapped'` context output. |
| `namespace` | `string` | Tenant/domain identifier for multi-tenant isolation. |
| `timeout` | `number` | Workflow-level deadline in milliseconds. |
| `durable` | `boolean` | Enables durable execution mode for suspensions and resumes. |
| `workflowVersion` | `string \| number` | Semantic version of the running workflow. |
| `idempotencyKey` | `string \| Function` | Key for workflow-level deduplication. |
| `idempotencyStore` | `IdempotencyStore` | Store instance for idempotency claims (defaults to memory). |
| `idempotencyTtlMs` | `number` | Time-to-live for idempotency records. |
| `migrations` | `Record<string, Function>` | Version migration functions for state transformation upon resume. |

### Exceptions Hierarchy (`FluidFuncError`)

All exceptions inherit from `FluidFuncError` and include ISO timestamps, execution metadata, and error causes:

- `StepTimeoutException` &mdash; Thrown when a step exceeds `step.timeout(ms)`.
- `FlowTimeoutException` &mdash; Thrown when a workflow exceeds `flow.timeout(ms)`.
- `CancellationException` &mdash; Thrown when an `AbortSignal` cancels execution.
- `ValidationException` &mdash; Thrown when `.spec()` or `.schema()` validation fails.
- `FieldCollisionException` &mdash; Thrown when parallel branches write conflicting context keys under `mergeStrategy: 'error'`.
- `IdempotencyConflictException` &mdash; Thrown when an in-progress duplicate request is detected.
- `CompensationException` &mdash; Thrown when one or more compensation saga handlers fail during rollback.
- `WorkflowSuspendedException` &mdash; Thrown to pause execution at durable wait points (`waitForEvent`, `wait`).
- `DuplicateEventException` &mdash; Thrown when attempting to resume with an already consumed event.
- `ExpiredWaitException` &mdash; Thrown when resuming an event wait after its deadline has expired.
- `WorkflowVersionMismatchException` &mdash; Thrown when resuming a workflow with an incompatible version and no migration.
- `GraphValidationException` &mdash; Thrown when a workflow graph fails acyclic or structural validation.

---

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.

### Author

**Jerico de Guzman** &mdash; [LinkedIn](https://www.linkedin.com/in/jerico-de-guzman-35126657)
