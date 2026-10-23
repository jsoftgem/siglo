# fluid-func
> A modern, type-safe, and composable workflow orchestrator for TypeScript and JavaScript.

[![NPM Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://www.npmjs.com/package/fluid-func)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)]()

`fluid-func` allows you to break complex business logic into clean, reusable, and resilient steps. It combines functional composition with out-of-the-box parameter contracts, deterministic caching, lifecycle hooks, structured retry strategies, and isolated storage.

---

## Positioning: In-Process Orchestration vs Distributed Engines

| Dimension | `fluid-func` | Distributed Engines (Temporal, Inngest) |
|---|---|---|
| **Architecture** | Lightweight, zero-infrastructure in-process library | Heavy multi-cluster / external orchestrator daemon |
| **Latency** | Microsecond direct async function invocation | Millisecond-to-second RPC / polling overhead |
| **Footprint** | Zero external dependencies, pure TypeScript | Requires persistent workers, queue servers, and databases |
| **Primary Focus** | Step-by-step modular pipelines, resilient HTTP/DB actions, request-scoped sagas, retry backoff with jitter, OCC checkpointing | Months-long durable human-in-the-loop workflows |

---

## Formal Contracts & Documentation

- 📜 [Execution Semantics Contract](docs/execution-semantics.md) &mdash; Formal semantics answering all 9 runtime execution contract questions.
- 🚨 [Error Model & Exception Hierarchy](docs/error-model.md) &mdash; Complete exception hierarchy (`FluidFuncError`), metadata fields, cause preservation, and JSON serialization.
- 💾 [Storage & Checkpoint Contract](docs/storage-contract.md) &mdash; Checkpoint schema v2.0.0, optimistic concurrency (`expectedRevision`), namespace isolation, and error modes (`strict`, `warn`, `best-effort`).

---

## Key Features

- ⚡ **Composable Flows (`flow`)** &mdash; Compose steps directly into workflows without mandatory global string registries; steps are pure execution units.
- 🛡️ **TypeScript First & End-to-End Generics** &mdash; Comprehensive type definitions, input/output generic inference, IntelliSense autocompletion, and robust error contracts.
- ⏱️ **Resilient Deadlines & Two-Tier Timeouts** &mdash; Enforce per-step SLA (`step.timeout(ms)`) with typed `StepTimeoutException` and workflow-level deadlines (`flow.timeout(ms)`, `options.timeout`) with `FlowTimeoutException`.
- 🌐 **Runtime Namespaces & Isolation (`namespace`)** &mdash; Native data isolation at runtime (`{ namespace: "tenant_123" }`); namespace-scoped stacks, context metadata, isolated checkpoints, and auto-partitioned cache keys (`namespace:stepId:hash`).
- 🔌 **Unified Distributed `StorageAdapter`** &mdash; Enterprise distributed storage interface for real-time telemetry streaming (`onContextChange`), durable saga pause/resume (`saveCheckpoint` / `getCheckpoint`), and distributed caching (`getCachedStep` / `setCachedStep`).
- 🔀 **Modern Parameter Access & Native Destructuring** &mdash; Access values directly using modern object destructuring (`.modern()`), property getters (`param.prop.val`, `param.props`), type coercion, and clean POJO execution (`{ pojo: true }`).
- 📜 **Step-Namespaced History (`$steps` / `$history`)** &mdash; Retain intermediate step outputs across flow execution without key collisions; inspect prior outputs by step name (`param.$steps.stepName`), numeric index (`param.$steps[0]`), or chronological timeline (`param.$history[0]`).
- 🔒 **Pure Functional Immutability** &mdash; Zero in-place mutations of caller-supplied input parameters (`defaultParam`), preventing cross-flow state pollution.
- 🚀 **Lightweight / POJO Execution Mode** &mdash; Run steps and flows with `{ pojo: true }` or `{ mode: 'pojo' }` to bypass proxies and closures, returning clean, deep-frozen plain JavaScript objects directly.
- 💾 **State Serialization & Checkpointing (Durable Workflows)** &mdash; Snapshot, serialize (`serializeState`), persist to disk or database, and restore (`hydrateState`, `restoreCheckpoint`) execution stacks across process restarts.
- 🔁 **Structured Retry Strategies** &mdash; Automatic retries with exponential, linear, or fixed backoff, jitter, and `onRetry` hooks right in `onFail`.
- 📦 **Declarative Contracts & Standard Schema (`spec` / `schema`)** &mdash; Field requirements, defaults, validators, async transformers, context translators, and native Standard Schema / Zod / Valibot integration.
- 🛑 **Graceful Cancellation & AbortSignals** &mdash; Cancel flows, in-flight async steps, and retry timers seamlessly using standard `AbortSignal` (`param.$signal?.()`).
- ⚡ **Deterministic & Namespace-Partitioned Caching** &mdash; Stable-key hashing with circular reference protection, namespaces, and per-step TTL caching.

---

## Installation

```bash
npm install fluid-func
```

### Import

```typescript
// TypeScript & ES Modules (Option B: Step & flow)
import { Step, flow, Flow, isFlow, StorageManager, toPOJO, checkpoint, restoreCheckpoint, serializeState, hydrateState } from 'fluid-func';
// Or default import:
import FluidFunc from 'fluid-func';

// Backward-compatible aliases (Chain = Step, pipe = flow, Pipeline = Flow, isPipeline = isFlow)
import { Chain, pipe, isPipeline } from 'fluid-func';

// CommonJS
const { Step, flow, StorageManager, toPOJO, checkpoint, restoreCheckpoint, serializeState, hydrateState } = require('fluid-func');
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

## End-to-End TypeScript Generics

`fluid-func` provides full type safety across step definitions and flows. Type parameters flow from input to output:

```typescript
import { Step, flow } from 'fluid-func';

interface OrderInput {
    orderId: string;
    amount: number;
}

interface PaymentOutput {
    transactionId: string;
    status: 'paid' | 'declined';
}

// 1. Type a single Step: Step<TInput, TOutput>
const processPayment = Step.create<OrderInput, PaymentOutput>(async (param) => {
    const { orderId, amount } = param.props;
    return {
        transactionId: `tx_${orderId}`,
        status: amount > 0 ? 'paid' : 'declined'
    };
});

// Result is strictly typed as Promise<PaymentOutput>
const payment = await processPayment.run({ orderId: 'ord_101', amount: 250 });
console.log(payment.status); // 'paid'

// 2. Type an entire flow: flow<TInput, TOutput>(...)
const checkout = flow<OrderInput, PaymentOutput>(
    validateStep,
    processPayment
);

const receipt = await checkout.run({ orderId: 'ord_102', amount: 99 });
```

---

## Composition: Workflows & Step Orchestration

`fluid-func` gives you multiple intuitive ways to compose workflow steps:

### 1. Functional Flows (`flow`)

Recommended for modern functional composition. Avoids global namespace collisions and supports nested arrays and flows:

```typescript
import { Step, flow } from 'fluid-func';

const validate = Step.create(async (p) => ({ valid: true }));
const charge = Step.create(async (p) => ({ charged: true }));
const notify = Step.create(async (p) => ({ notified: true }));

// Flow steps sequentially
const checkoutFlow = flow(validate, charge, notify);

// Flows can also nest arrays of steps
const fullWorkflow = flow(validate, [charge, notify]);
await fullWorkflow.run({ customerId: 'cust_1' });

// Flows can also nest other flows directly as arguments
const authFlow = flow(validateToken, checkPermissions);
const billingFlow = flow(calculateTaxes, chargeCard);
const masterFlow = flow(authFlow, billingFlow, notify);
await masterFlow.run({ customerId: 'cust_1' });
```

### 2. Direct Step Orchestration (`Step.start`)

Execute direct step instances individually or in arrays without global string registries:

```typescript
const fetchData = Step.create('fetchData', async () => ({ data: [1, 2, 3] }));
const processData = Step.create('processData', async (param) => ({ count: param.data.val.length }));

const result = await Step.start([fetchData, processData], { initial: true });
```

---

## Modern Parameter Access

`fluid-func` provides clean, idiomatic parameter access through native object destructuring, direct property getters, and type coercion.

### 1. Native Object Destructuring (`.modern()`)

Step actions configured with `.modern()` receive clean, unwrapped plain JavaScript objects directly, making parameter extraction effortless:

```typescript
const addStep = Step.create(async ({ a, b }) => {
    return { sum: a + b };
}).modern();

const res = await addStep.run({ a: 15, b: 25 });
console.log(res.sum.val); // 40
```

### 2. Property Value Getters (`.val` / `.value`)

Access field values cleanly via property getters without invoking functions:

```typescript
const processUser = Step.create((param) => {
    // Value getter (.val or .value)
    const id = param.userId.val;
    const sameId = param.userId.value;

    // Direct object traversal
    const name = param.user.name;

    // Type coercion (Symbol.toPrimitive)
    const amount = +param.amount;       // number
    const label = `${param.greeting}`; // string

    // Unwrapped objects (.props or .raw)
    const { userId, amount: rawAmount } = param.props;

    return { processed: true };
});
```

### 3. Pure POJO Mode (`{ pojo: true }`)

For maximum performance and clean JSON objects without Proxies or getters, run flows in POJO mode:

```typescript
const result = await myFlow.run({ userId: 'u_123' }, { pojo: true });
console.log(result.userId); // 'u_123' (plain object)
```

---

## Execution State & Step History (`$steps` & `$history`)

In complex multi-step flows, different steps might return fields with the same name (e.g. `status` or `data`). `fluid-func` preserves intermediate step outputs by recording step-namespaced history accessible on the execution context:

```typescript
const step1 = Step.create('step1', async () => ({ status: 'step1_done', code: 100 }));
const step2 = Step.create('step2', async (param) => {
    // 1. Access previous step by name
    const step1Status = param.$steps.step1.status.val; // or param.$steps.step1.status.value

    // 2. Access previous step by numeric index
    const firstStepCode = param.$steps[0].code.val;

    // 3. Inspect full chronological execution timeline
    const history = param.$history;
    // history => [{ step: 'step1', index: 0, output: { status: 'step1_done', code: 100 } }]

    return { status: 'step2_done' };
});

const result = await flow(step1, step2).run();
console.log(result.status.val);               // 'step2_done' (latest)
console.log(result.$steps.step1.status.val);   // 'step1_done' (preserved!)
```

---

## Pure Functional Immutability

`fluid-func` treats caller inputs as strictly immutable:

```typescript
const initialInput = { userId: '123', count: 1 };
Object.freeze(initialInput); // Enforce runtime immutability

const myFlow = flow(
    Step.create(async (p) => ({ count: p.count.val + 1 })),
    Step.create(async (p) => ({ count: p.count.val * 10 }))
);

const res = await myFlow.run(initialInput);

// initialInput is untouched!
console.log(initialInput.count); // 1
console.log(res.count.val);      // 20
```

---

## Lightweight / POJO Execution Mode

For microservices, high-throughput loops, or JSON serialization without Proxies or getter closures, execute steps with `{ pojo: true }` or `{ mode: 'pojo' }`:

```typescript
const result = await myFlow.run(
    { query: 'test' },
    { pojo: true } // or { mode: 'pojo' }
);

// Returns a clean, deep-frozen Plain Old JavaScript Object
console.log(result);
// { query: 'test', result: 'ok', $steps: { ... }, $history: [ ... ] }

// You can also convert any existing context output to a POJO at any time:
import { toPOJO } from 'fluid-func';
const pojo = toPOJO(result);
```

---

## State Checkpointing & Durable Execution

`fluid-func` includes built-in snapshotting and serialization of execution stacks. This enables pausing flows, logging full execution checkpoints to disk or databases (MongoDB/Redis), and resuming or debugging workflows:

```typescript
import { Step, StorageManager } from 'fluid-func';

// 1. Snapshot or serialize a running or completed stack
const storage = new StorageManager();
const snapshot = storage.checkpoint(stackId);
const jsonString = storage.serializeState(stackId);

// 2. Hydrate or restore state into another process or storage instance
const restoredStorage = new StorageManager();
restoredStorage.hydrateState(jsonString);

// Working getter closures and context fields are fully reconstructed!
const restoredGetter = restoredStorage.getChainContext(stepId, 'field');
console.log(restoredGetter());
```

Static helper methods are also directly accessible via `Step`:
```typescript
Step.checkpoint(stackId);
Step.restoreCheckpoint(checkpointData);
Step.serializeState(stackId);
Step.hydrateState(serializedState);
```

---

## Structured Retry Strategies (`onFail`)

Handle transient failures reliably with configurable retry policies (exponential backoff, linear backoff, jitter, and callbacks) out of the box:

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

await resilientStep.run();
```

### Manual Callback Handling

You can also use custom retry/reject logic using a callback:

```typescript
step.onFail((error, retry, reject) => {
    if (error.code === 'NETWORK_TIMEOUT') {
        retry(); // Retry step execution
    } else {
        reject(); // Terminate flow with error
    }
});
```

---

## Parameter Contracts with `.spec()` & `.schema()`

Enforce contracts on input parameters per step using declarative rules:

```typescript
const registerUser = Step.create(async (param) => {
    return { registered: true };
})
    // Require field with custom message
    .spec('email', {
        require: true,
        requireMessage: 'A valid email address is required.'
    })
    // Validate value asynchronously
    .spec('email', {
        validate: async (val) => {
            if (!val.includes('@')) throw new Error('Invalid email format');
        }
    })
    // Provide default fallback value
    .spec('role', {
        default: 'member'
    })
    // Transform input asynchronously
    .spec('username', {
        transform: async (val) => val.trim().toLowerCase()
    })
    // Translate a single field into multiple context fields
    .spec('fullName', {
        translate: async (val, context) => {
            const [first, ...rest] = val.split(' ');
            context.set('firstName', first);
            context.set('lastName', rest.join(' '));
        }
    });
```

### Standard Schema & Zod Support (`.schema()` & `.spec()`)

`fluid-func` has first-class support for the [Standard Schema](https://github.com/standard-schema/standard-schema) specification (`~standard`), as well as [Zod](https://zod.dev), [Valibot](https://valibot.dev), and schema parsers exposing `safeParse()` or `parse()`:

```typescript
import { z } from 'zod';
import { Step } from 'fluid-func';

// 1. Root context schema validation via .schema()
const createUser = Step.create('createUser')
    .schema(z.object({
        email: z.string().email(),
        age: z.number().min(18)
    }));

// 2. Field-level schema validation via .spec()
const validateOrder = Step.create('validateOrder')
    .spec('amount', z.number().positive())
    .spec('items', z.array(z.string()).min(1));
```

### Strict Parameter Isolation (`.strict()`)

Use `.strict()` to isolate the step and strip unspec'd parameters:

```typescript
const secureStep = Step.create((param) => {
    // param.sensitiveToken will be undefined
    return { sanitized: param.cleanField.val };
})
    .strict()
    .spec('cleanField', { require: true });
```

### Validation Error Handling

When validation fails, `fluid-func` rejects with a `SpecFailedException` containing the offending field name and validation error:

```typescript
try {
    await registerUser.run({ email: 'invalid-email' });
} catch (err) {
    // err is an array of errors or SpecFailedException: [{ field: 'email', error: ... }]
    console.error('Validation failed:', err);
}
```

---

## Graceful Cancellation (`AbortSignal`)

Cancel long-running steps, flows, in-flight async operations, and retry timers cleanly using standard `AbortController`:

```typescript
const controller = new AbortController();

// Cancel execution if it exceeds 3 seconds
setTimeout(() => controller.abort(new Error('Timeout exceeded')), 3000);

try {
    const res = await myFlow.run(
        { orderId: 'ord_123' },
        { signal: controller.signal }
    );
} catch (err) {
    console.error('Flow aborted:', err.message);
}
```

### Inside Step Actions

Step actions can read the active `AbortSignal` directly from parameters and forward it to downstream async operations (e.g., `fetch` or database queries):

```typescript
Step.create(async (param) => {
    // Retrieve AbortSignal via param.$signal.val or param.signal.val
    const signal = param.$signal.val || param.signal.val;
    const response = await fetch('https://api.example.com/data', { signal });
    return { data: await response.json() };
});
```

When an `AbortSignal` is aborted during a retry backoff delay, the sleep timer aborts immediately without hanging.

---

## Execution Resilience & Deadlines (Two-Tier Timeouts)

Production workflow orchestrators require strict failure boundaries. Long-running or hanging asynchronous operations (e.g. stalled database queries, unresponsive 3rd-party APIs, LLM stream deadlocks) must not hold system resources and execution stacks indefinitely.

`fluid-func` establishes a **two-tier timeout architecture**:

| Dimension | **Step-Level Timeout (`step.timeout(ms)`)** | **Flow-Level Timeout (`flow.timeout(ms)` / `options.timeout`)** |
| :--- | :--- | :--- |
| **Primary Purpose** | **Per-operation SLA** (e.g. HTTP request, LLM generation, DB query) | **End-to-end workflow budget** (e.g. API gateway deadline, queue SLA) |
| **Scope** | Confined to a single step's execution lifecycle | Cumulative across all steps, retries, and delays combined |
| **Failure Handling** | Triggers step's **`onFail`** (retries, backoff, or fallback) | Immediately aborts whole workflow; terminates stack and rejects |
| **Exception Type** | `StepTimeoutException` (`stepName`, `timeoutMs`, `elapsedMs`) | `FlowTimeoutException` (`stackId`, `timeoutMs`, `completedSteps`) |

### 1. Step-Level SLA (`step.timeout(ms)`) with Retries

When a step defines `.timeout(ms)`, it races the action against a timer. If it times out, a `StepTimeoutException` is thrown, which seamlessly feeds into `.onFail()` for retries:

```typescript
import { Step, StepTimeoutException } from 'fluid-func';

const callPaymentGateway = Step.create('processPayment', async (param) => {
    return await httpClient.post('/charge', param.props, {
        signal: param.$signal?.()
    });
})
    .timeout(3000) // Rejects with StepTimeoutException if action takes > 3s
    .onFail({
        maxRetries: 2,
        delay: 500,
        onRetry: (err, attempt) => {
            if (err instanceof StepTimeoutException) {
                console.warn(`Payment timed out after ${err.timeoutMs}ms; retrying attempt #${attempt}...`);
            }
        }
    });
```

### 2. Flow-Level SLA (`flow.timeout(ms)` or `options.timeout`)

Set an end-to-end deadline on a flow, or pass it dynamically per execution:

```typescript
import { Step, flow, FlowTimeoutException } from 'fluid-func';

// Static flow deadline
const orderPipeline = flow(validateStep, chargeStep, invoiceStep).timeout(10000); // 10s budget

// Or dynamic runtime deadline
try {
    const result = await orderPipeline.run(orderData, {
        timeout: 8000,
        namespace: 'tenant_acme'
    });
} catch (err) {
    if (err instanceof FlowTimeoutException) {
        console.error(`Workflow timed out after ${err.timeoutMs}ms; completed steps: ${err.completedSteps.join(' -> ')}`);
    }
}
```

### 3. Cooperative Cancellation via `param.$signal()`

All timeouts and external signals are merged using `AbortSignal`. Step actions can pass this signal to native APIs (`fetch`, database drivers, Axios):

```typescript
const fetchDocs = Step.create(async (param) => {
    const res = await fetch('https://api.example.com/docs', {
        signal: param.$signal?.() // Automatically aborted if step SLA or flow deadline expires
    });
    return await res.json();
});
```

---

## Lifecycle Hooks & Optimization

### Pre-execution Guard (`onBefore`)

Intercept execution before a step starts. Returning `false` gracefully skips the step:

```typescript
step.onBefore(async (param) => {
    const hasPermission = await checkUserPermission(param.userId.val);
    return hasPermission; // false skips this step
});
```

### Deterministic Caching (`.cache()`)

Cache results based on step inputs. `fluid-func` sorts keys and handles circular references safely:

```typescript
// Cache result for 5,000 milliseconds (default is 1,500ms)
const cachedQuery = Step.create(async (param) => {
    return await queryHeavyDatabase(param.filter.val);
}).cache(5000);
```

### Reducer Steps (`.reduce()`)

Process array inputs iteratively through an accumulator:

```typescript
const sumStep = Step.create((param, current = 0) => {
    return current + param.num.val;
}).reduce('numbers');

const res = await sumStep.run({ numbers: [10, 20, 30] });
console.log(res.value.val); // 60
```

---

## Runtime Namespaces & Isolation (`namespace`)

In multi-tenant systems, workflow definitions are **pure, shared application code** executed concurrently across many tenants. Tenants require **runtime data isolation** &mdash; isolated parameters, execution stacks, caches, and checkpoints &mdash; rather than separate code registries.

### 1. Passing `namespace` at Execution Time

Provide `namespace` in `ExecutionOptions` when running any step or flow:

```typescript
import { Step, flow } from "fluid-func";

const orderPipeline = flow(validateStep, calculateTaxStep, chargeStep);

// Concurrent executions for different tenants in the same Node.js process:
const [resA, resB] = await Promise.all([
    orderPipeline.run({ amount: 100 }, { namespace: "tenant_acme" }),
    orderPipeline.run({ amount: 250 }, { namespace: "tenant_globex" })
]);
```

### 2. Accessing `$namespace` Inside Step Actions

Step actions can read the active tenant ID directly via `param.$namespace()` or property getter `param.$namespace.val`:

```typescript
const applyTenantPolicy = Step.create(async (param) => {
    const tenant = param.$namespace?.();
    console.log(`Applying custom business rules for ${tenant}...`);
    return { policyApplied: true };
});
```

### 3. Namespace Cache Partitioning

When a step uses `.cache(ttlMs)`, cache keys are automatically partitioned by `namespace`:
```
cacheKey = `${namespace}:${stepId}:${inputHash}`
```
Executions in different namespaces with identical input arguments will **never** collide or leak cached data across namespace boundaries.

### 4. Namespace Checkpoint Scoping

When checkpointing stacks (`Step.checkpoint(stackId)` or `saveCheckpoint`), the active `namespace` is saved with the checkpoint data, ensuring cross-namespace state restoration cannot occur.

---

## Pluggable Distributed Storage (`StorageAdapter`)

`fluid-func` provides a unified, enterprise-grade `StorageAdapter` interface to connect external infrastructure (Redis, MongoDB, Kafka, Postgres).

> **Architectural Note:** Step code closures belong in versioned application bundles, **not** in Redis or MongoDB. Distributed storage manages **State, Telemetry, and Durability only**:
> 1. **Telemetry & Tracing**: Real-time context change events (`onContextChange`).
> 2. **Durable Checkpoints**: Saga pause/resume across worker nodes (`saveCheckpoint` / `getCheckpoint`).
> 3. **Distributed Step Caching**: Memoized step results across cluster instances (`getCachedStep` / `setCachedStep`).

### The `StorageAdapter` Interface

```typescript
export interface ContextChangeEvent {
    namespace?: string;
    stackId: string;
    stepId: string;
    field: string;
    value: any;
    timestamp: number;
}

export interface StorageAdapter {
    name: string;

    // 1. Context & Event Streaming (Telemetry, Audit Logs, Tracing)
    onContextChange?(entry: ContextChangeEvent): Promise<void> | void;

    // 2. Checkpointing & Durability (Sagas, Pause/Resume, Approval workflows)
    saveCheckpoint?(checkpoint: SerializedExecutionStack): Promise<void>;
    getCheckpoint?(stackId: string): Promise<SerializedExecutionStack | undefined>;

    // 3. Distributed Caching (Cluster-wide step memoization)
    getCachedStep?(key: string): Promise<any | undefined>;
    setCachedStep?(key: string, value: any, ttlMs: number): Promise<void>;
}
```

### Registering an Adapter via `Step.useStorage`

```typescript
import { Step, StorageAdapter, ContextChangeEvent, SerializedExecutionStack } from "fluid-func";

class RedisMongoStorageAdapter implements StorageAdapter {
    name = "RedisMongoStorageAdapter";

    async onContextChange(e: ContextChangeEvent) {
        // Stream telemetry to Kafka / MongoDB audit collection
        await mongoLogs.insertOne({
            namespace: e.namespace,
            stackId: e.stackId,
            stepId: e.stepId,
            field: e.field,
            value: e.value,
            timestamp: e.timestamp
        });
    }

    async saveCheckpoint(checkpoint: SerializedExecutionStack) {
        // Save durable saga state to MongoDB / Redis
        await mongoCheckpoints.updateOne({ stackId: checkpoint.stackId }, { $set: checkpoint }, { upsert: true });
        await redis.set(`checkpoint:${checkpoint.stackId}`, JSON.stringify(checkpoint));
    }

    async getCheckpoint(stackId: string) {
        const cached = await redis.get(`checkpoint:${stackId}`);
        if (cached) return JSON.parse(cached);
        return await mongoCheckpoints.findOne({ stackId });
    }

    async getCachedStep(key: string) {
        const val = await redis.get(`cache:${key}`);
        return val ? JSON.parse(val) : undefined;
    }

    async setCachedStep(key: string, value: any, ttlMs: number) {
        await redis.set(`cache:${key}`, JSON.stringify(value), "PX", ttlMs);
    }
}

// Register globally in a single call
Step.useStorage(new RedisMongoStorageAdapter());
```

### Saga Checkpointing & Worker Handoff Example

```typescript
// Worker 1: Run steps up to an external webhook or human approval
const approvalFlow = flow(submitRequestStep, validateDocumentsStep);
const partialResult = await approvalFlow.run(input, { namespace: "tenant_01" });
const stackId = partialResult.$stackId();

// Automatic or manual checkpointing:
const checkpoint = await Step.checkpoint(stackId);
// Checkpoint is automatically written to your StorageAdapter!

// Worker 2 (Hours later, upon webhook arrival):
const restoredStack = await Step.getCheckpoint(stackId);
const resumeStorage = new StorageManager();
resumeStorage.restoreCheckpoint(restoredStack);

// Seamlessly resume downstream flow execution from saved state
```

> 📁 A complete, runnable test project demonstrating Redis + MongoDB storage integration with the unified `StorageAdapter` is available in [`test-project/`](test-project/README.md).
> Run it directly with:
> ```bash
> cd test-project && npm test
> ```

> 💡 **Notice on Legacy Code Registry APIs:** Legacy string-based code registry APIs (`putChain`, `getChain`, `setPutChainPlugin`, `setGetChainPlugin`, `Step.exists`, `isExists`) are deprecated and will be removed in v3.0. Use direct step composition with `flow()` and the unified `StorageAdapter` interface.

---

## Global Monitoring & Plugins

Configure global plugins and log monitors across workflow lifecycles:

```typescript
Step.config({
    logMonitor: (entry) => {
        console.log(`[${entry.source}]`, entry.message);
    },
    plugins: [
        {
            name: 'auditLogger',
            action: async (context) => {
                return { auditedAt: Date.now() };
            },
            before: ['checkoutStep'],
            after: ['confirmationStep']
        }
    ]
});
```

---

## API Reference

### Flow & Step Functions (Option B)

| Method / Function | Description |
| :--- | :--- |
| `flow<TIn, TOut>(...steps)` | Primary orchestrator creating a composable `Flow` instance supporting `.run()`, `.execute()`, `.start()`, and `.steps`. *(Alias: `pipe`)* |
| `Step.create<TIn, TOut>(action)` | Instantiates a new `Step` execution unit with optional input/output types. *(Alias: `Chain.create`)* |
| `Step.start<TOut>(steps, param, options?)` | Static runner executing a step, flow, or array of steps with optional `ExecutionOptions`. |
| `Step.flow(...steps)` | Static flow orchestrator on `Step`. |
| `isFlow(item)` | Type-guard predicate verifying if an object conforms to the `Flow` interface. *(Alias: `isPipeline`)* |
| `Step.toPOJO<T>(data)` | Recursively converts Proxy / context object to frozen plain JavaScript object. |
| `Step.checkpoint(stackId)` | Creates a snapshot checkpoint of the specified execution stack. |
| `Step.restoreCheckpoint(checkpoint)` | Restores stack execution state from a checkpoint. |
| `Step.serializeState(stackId?)` | Serializes execution stacks and state to a JSON string. |
| `Step.hydrateState(serializedState)` | Restores stacks and state from a JSON string or checkpoint. |
| `step.modern()` | Sets modern execution mode passing unwrapped objects directly to action. |
| `step.schema(schema)` | Validates root context against Standard Schema, Zod, Valibot, or custom validators. |
| `step.spec(field, options \| schema)` | Attaches parameter validation, default, transform, translate, or schema rules to a field. |
| `step.strict()` | Restricts step parameters only to fields declared via `.spec()`. |
| `step.onBefore(hook)` | Guard hook; return `false` or a rejecting Promise to skip step. |
| `step.onSkip(hook)` | Skip hook; executed when `onBefore` returns false to provide fallback values. |
| `step.onAfter(hook)` | Post-execution hook enriching the output context with additional properties. |
| `step.onFail(strategy \| callback)` | Configures structured `RetryConfig` or manual error callback. |
| `step.timeout(ms)` | Sets a per-step execution SLA deadline (in milliseconds); throws `StepTimeoutException` and triggers `onFail` retries. |
| `flow.timeout(ms)` | Sets a cumulative end-to-end workflow SLA deadline (in milliseconds); throws `FlowTimeoutException`. |
| `Step.useStorage(adapter)` | Registers a unified distributed `StorageAdapter` provider globally. |
| `Step.getStorageAdapter()` | Retrieves the active `StorageAdapter` instance if registered. |
| `Step.getCheckpoint(stackId)` | Asynchronously retrieves a saved checkpoint from the active storage adapter or local memory. |
| `step.cache(ms)` | Caches step results for specified duration (in milliseconds); auto-partitioned by `namespace`. |
| `step.reduce(arrayField)` | Turns the step into an iterative array reducer over the specified array field. |
| `step.run(param?, options?)` | Executes the step with modern async/await resolution and optional `ExecutionOptions`. |
| `step.execute(param?, options?)` | Executes the step (supports callback or returns Promise). |

### ExecutionOptions Interface

| Property | Type | Description |
| :--- | :--- | :--- |
| `signal` | `AbortSignal` | Optional cancellation signal to abort in-flight execution and retry backoff delays. |
| `pojo` | `boolean` | When `true`, resolves the final flow output as a clean, frozen Plain Old JavaScript Object. |
| `mode` | `'pojo' \| 'wrapped'` | Explicitly selects `'pojo'` (plain object) or `'wrapped'` (Proxy getters) output format. |

### RetryConfig Interface

| Property | Type | Description | Default |
| :--- | :--- | :--- | :--- |
| `maxRetries` | `number` | Maximum retry attempts before rejecting | `3` |
| `backoff` | `'fixed' \| 'linear' \| 'exponential' \| ((attempt) => number)` | Delay backoff strategy | `'fixed'` |
| `delay` | `number` | Base delay in milliseconds | `100` |
| `maxDelay` | `number` | Maximum upper cap for backoff delay | `10000` |
| `jitter` | `boolean` | Adds randomized jitter to delay interval | `false` |
| `onRetry` | `(error, attempt) => void` | Callback invoked before each retry attempt | `undefined` |

### StorageManager & State Serialization APIs

| Class / Function | Description |
| :--- | :--- |
| `new StorageManager()` | Creates an isolated storage container with private `Map` instances for steps, contexts, plugins, configs, and stacks. |
| `storage.checkpoint(stackId)` | Captures a snapshot of the stack's execution state, contexts, and results. |
| `storage.restoreCheckpoint(checkpoint)` | Reconstructs the stack and its getter closures in storage from a checkpoint. |
| `storage.serializeState(stackId?)` | Serializes stack(s) or entire storage state into a JSON string. |
| `storage.hydrateState(serializedState)` | Reconstitutes execution stacks from serialized state or checkpoint object. |
| `toPOJO<T>(data)` | Standalone utility to convert wrapped Proxy contexts into plain frozen objects. |
| `storage.useStorage(adapter)` | Registers an enterprise `StorageAdapter` with this storage manager instance. |
| `storage.getStorageAdapter()` | Retrieves the registered `StorageAdapter` or `undefined`. |
| `storage.getCheckpoint(stackId)` | Queries adapter or memory for a saved checkpoint. |
| `setPutChainPlugin(plugin)` | *(Deprecated)* Legacy external storage plugin for persisting step code. Use `StorageAdapter`. |
| `setGetChainPlugin(plugin)` | *(Deprecated)* Legacy external storage plugin for retrieving step code. Use `StorageAdapter`. |
| `setPutChainContextPlugin(plugin)` | *(Deprecated)* Legacy storage plugin for context fields. Use `StorageAdapter.onContextChange`. |
| `setGetChainContextPlugin(plugin)` | *(Deprecated)* Legacy storage plugin for retrieving context fields. |
| `clearStorage()` | Clears internal storage caches and stacks. |
| `getStorage()` | Returns an immutable snapshot of internal storage state. |

---

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.

### Author

**Jerico de Guzman** &mdash; [LinkedIn](https://www.linkedin.com/in/jerico-de-guzman-35126657)
PROVENANCE


---

## Migration Guide: v0.6.1 to v1.0.0

`fluid-func` v1.0.0 unifies its public API around `Step` and `flow` as the primary primitives while maintaining **100% backward compatibility** for all v1.x constructs:

| v0.6.1 (Deprecated Alias) | v1.0.0 (Primary API) | Status |
|---|---|---|
| `Chain` | `Step` | Deprecated (supported until v2.0) |
| `pipe(...)` | `flow(...)` | Deprecated (supported until v2.0) |
| `Pipeline` | `Flow` | Deprecated (supported until v2.0) |
| `isPipeline(...)` | `isFlow(...)` | Deprecated (supported until v1.0) |

### Deprecation Policy
- Deprecated aliases emit zero runtime overhead and delegate directly to primary implementations.
- All deprecated aliases will remain fully operational throughout the entire 1.x release cycle and will not be removed until v2.0.0.
