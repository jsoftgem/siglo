# API Reference: Execution Options (`ExecutionOptions`)

The `ExecutionOptions` object configures runtime execution behavior across `flow.run()`, `flow.execute()`, `step.run()`, and `resumeWorkflow()`. It governs cancellation signals, deadlines, dependency injection, durable persistence, multi-tenant namespaces, schema migrations, and idempotency deduplication.

---

## Table of Contents

- [The `ExecutionOptions` Interface](#the-executionoptions-interface)
- [Option Details](#option-details)
  - [`pojo` and `mode`](#pojo-and-mode)
  - [`signal`](#signal)
  - [`timeout` / `timeoutMs`](#timeout--timeoutms)
  - [`services` / `dependencies`](#services--dependencies)
  - [`durable`](#durable)
  - [`workflowVersion`](#workflowversion)
  - [`migrations`](#migrations)
  - [`namespace`](#namespace)
  - [`idempotencyKey`](#idempotencykey)
  - [`idempotencyStore`](#idempotencystore)
  - [`idempotencyTtlMs`](#idempotencyttlms)
  - [`workflowId`](#workflowid)
  - [`stackId`](#stackid)
- [Comprehensive Production Example](#comprehensive-production-example)

---

## The `ExecutionOptions` Interface

```typescript
export interface ExecutionOptions {
    /** Strip internal proxy wrappers and return clean plain JavaScript objects (default: true). Output path always normalizes via toPOJO. */
    pojo?: boolean;

    /** Compatibility option for return format: 'pojo' (default) or 'wrapped'. */
    mode?: 'pojo' | 'wrapped';

    /** Cooperative cancellation signal aborting in-flight async steps and retry delays. */
    signal?: AbortSignal;

    /** Overall workflow SLA deadline in milliseconds. */
    timeout?: number;
    timeoutMs?: number;

    /** Dependency injection container accessible inside steps via param.$services. */
    services?: Record<string, any>;
    dependencies?: Record<string, any>;

    /** Enables durable checkpoint persistence upon wait/suspend. */
    durable?: boolean;

    /** Explicit checkpoint capture flag. */
    checkpoint?: boolean;

    /** Workflow schema version for migration verification upon resumption. */
    workflowVersion?: string | number;

    /** State migration map (e.g. { 'v1->v2': (from, to, state) => newState }) or single migration function. */
    migrations?: Record<string, (fromVersion: any, toVersion: any, state: any) => any> | ((fromVersion: any, toVersion: any, state: any) => any);

    /** Multi-tenant partition namespace scoping checkpoints, caches, and idempotency keys. */
    namespace?: string;

    /** Workflow-level idempotency deduplication key or generator function. */
    idempotencyKey?: string | ((ctx: any) => string);

    /** Custom idempotency store adapter. */
    idempotencyStore?: IdempotencyStore;

    /** Retention TTL for idempotency records in milliseconds (Postgres/Redis default: 24h; InMemory: no expiry unless set). */
    idempotencyTtlMs?: number;

    /** Settle polling timeout and interval for concurrent in-progress idempotency claims. */
    settleTimeoutMs?: number;
    pollIntervalMs?: number;

    /** Custom predicate for classifying permanent non-retryable business errors. */
    isPermanentError?: (err: any) => boolean;

    /** Custom workflow identifier attached to telemetry, logs, and checkpoints. */
    workflowId?: string;

    /** Explicit caller-supplied execution stack ID. */
    stackId?: string;

    /** Internal flag indicating resumption execution. */
    isResume?: boolean;

    /** Dynamic network egress policy config for this run. */
    networkPolicy?: NetworkPolicyConfig;

    /** Live monitoring event emitter or callback. */
    monitor?: WorkflowEventEmitter | ((event: WorkflowExecutionEvent) => void);

    /** Optional pre-compiled workflow AST. */
    ast?: WorkflowNode;
}
```

---

## Option Details

### `pojo` and `mode`

Controls output normalization for the workflow result:

- `pojo: true` *(default in v1.0)*: Automatically strips internal proxy wrappers and execution internals, returning clean plain objects. The runtime output path always applies `toPOJO` normalization.
- `mode: 'pojo' | 'wrapped'`: Compatibility configuration. Note that reserved context history accessors remain getter functions, and native types like `BigInt` are not automatically JSON-serializable.

```typescript
const result = await myFlow.run(input, { pojo: true });
console.log(result); // Clean plain object
```

---

### `signal`

An `AbortSignal` instance used for cooperative cancellation.

- **Propagation**: Passed to every step action via `param.signal` (native `AbortSignal`) and `param.$signal()` (callable compatibility accessor).
- **In-Flight Cancellation**: When aborted, pending retry backoff delays and parallel sibling branches are aborted. Note that asynchronous work inside step actions must cooperate with `param.signal` (e.g. passing it to `fetch({ signal })`).
- **Exception**: Throws `CancellationException` with the abort reason.

```typescript
const controller = new AbortController();

setTimeout(() => {
    controller.abort(new Error('User cancelled the operation'));
}, 5000);

try {
    await myFlow.run(input, { signal: controller.signal });
} catch (err) {
    if (err instanceof CancellationException) {
        console.log('Workflow successfully aborted:', err.message);
    }
}
```

---

### `timeout` / `timeoutMs`

Workflow-level SLA deadline in milliseconds.

- If the total execution time of the entire workflow exceeds this limit, execution is immediately aborted.
- Throws `FlowTimeoutException` containing `timeoutMs`, `stackId`, and `completedSteps`.

```typescript
await myFlow.run(input, { timeout: 10000 }); // 10-second deadline
```

---

### `services` / `dependencies`

Dependency injection container for injecting repositories, external clients, database connections, and configurations into steps without coupling step implementations to global singletons.

- Accessible inside step actions via `param.$services` or `step.requireDependency()`.
- Both `services` and `dependencies` are accepted as synonyms.

```typescript
const myFlow = flow(
    Step.create('charge', async (param: any) => {
        const paymentGateway = param.$services.paymentGateway;
        return await paymentGateway.charge(param.amount);
    })
);

await myFlow.run({ amount: 50 }, {
    services: {
        paymentGateway: new StripePaymentGateway(apiKey)
    }
});
```

---

### `durable`

When set to `true`, enables durable workflow state management:
- When a workflow encounters `waitForEvent()` or `wait()`, Siglo suspends the workflow, serializes the current execution context into a checkpoint, persists it to the configured `StorageAdapter`, and resolves with an execution descriptor containing `{ status: 'waiting', stackId, waitKey }`.
- Allows workflows to pause for hours, days, or months and resume safely upon external event delivery via `resumeWorkflow()`.

```typescript
const result = await myFlow.run({ orderId: 'ord_123' }, { durable: true });
if (result.status === 'waiting') {
    console.log(`Workflow suspended with stackId: ${result.stackId}`);
}
```

---

### `workflowVersion`

Declares the schema version of the workflow definition (e.g. `'v1'`, `'v2'`).

- Used during durable workflow resumption to detect code changes between when the checkpoint was created and when it was resumed.
- When resuming via `resumeWorkflow(targetFlow, key, payload, options)`, the target version is selected from `options.targetVersion`, falling back to `targetFlow.workflowVersion`, then the checkpoint's recorded version.
- If the checkpoint's version differs from the target version and no matching migration is provided in `migrations`, `WorkflowVersionMismatchException` is thrown.

---

### `migrations`

A migration map or migration function for upgrading suspended checkpoint state when workflow definitions evolve. Transition keys use `'fromVersion->toVersion'` format and receive `(fromVersion, toVersion, state) => newState`:

```typescript
const migrations = {
    // Migrates checkpoint created under v1 to v2 schema
    'v1->v2': (fromVersion: string, toVersion: string, oldState: any) => ({
        ...oldState,
        customerFullName: `${oldState.firstName} ${oldState.lastName}`
    })
};

await resumeWorkflow(orderWorkflowV2, correlationKey, eventPayload, {
    targetVersion: 'v2',
    migrations
});
```

---

### `namespace`

A string partition key used for multi-tenant metadata scoping and storage key partitioning.

- Partitions checkpoint keys, cached step outputs, and wait records to prevent key collisions across tenants.
- `restoreCheckpoint` checks an explicitly supplied expected namespace when both values exist.
- **Security Note**: Namespace scoping is logical key partitioning, not an enforced authenticated tenant boundary. Application-level tenant authentication and explicit validation are still required.

```typescript
await tenantFlow.run(tenantPayload, {
    namespace: 'org_enterprise_tenant_99'
});
```

---

### `idempotencyKey`

A string or generator function providing workflow-level deduplication.

- Prevents concurrent duplicate runs (e.g. double-submitted webhooks or duplicate HTTP requests).
- If an execution with this key is already running, throws `IdempotencyConflictException`.
- If already completed within `idempotencyTtlMs`, returns the cached result.

```typescript
await orderFlow.run(payload, {
    idempotencyKey: (ctx) => `checkout:${ctx.orderId}`
});
```

---

### `idempotencyStore`

Custom adapter implementing the `IdempotencyStore` interface (e.g. `PostgresIdempotencyStore`, `RedisIdempotencyStore`, or `InMemoryIdempotencyStore`).

---

### `idempotencyTtlMs`

Retention window for idempotency records in milliseconds:
- **Redis / PostgreSQL stores**: Default to `86400000` (24 hours).
- **In-Memory store**: No expiration by default (`expiresAt` remains undefined unless `ttlMs` is explicitly supplied; TTL starts at claim time).
- **Queue adapters** (Kafka, BullMQ, SQS): Pass `undefined` through to the store when `idempotencyTtlMs` is omitted.

---

### `workflowId`

Human-readable workflow identifier attached to telemetry, logs, and checkpoints.

---

### `stackId`

Explicit caller-provided execution stack ID. If omitted, Siglo automatically generates a unique UUID.

---

## Comprehensive Production Example

```typescript
import { Step, flow } from '@siglo/core';
import { RedisStorageAdapter } from '@siglo/redis';
import { PostgresIdempotencyStore } from '@siglo/postgres';

const checkoutFlow = flow(
    Step.create('reserveInventory', async (ctx: { sku: string; qty: number }) => {
        return { reserved: true };
    }),
    Step.create('processPayment', async (ctx: { amount: number }) => {
        return { paymentId: 'pay_999' };
    })
);

async function handleOrderWebhook(request: any) {
    const abortController = new AbortController();

    const options = {
        pojo: true,
        signal: abortController.signal,
        timeout: 15000, // 15s SLA
        namespace: request.tenantId,
        workflowId: 'order-checkout',
        workflowVersion: 'v2.0',
        durable: true,
        idempotencyKey: `order:${request.body.orderId}`,
        idempotencyTtlMs: 24 * 60 * 60 * 1000,
        services: {
            db: request.dbClient,
            metrics: request.metricsReporter
        }
    };

    return await checkoutFlow.run(request.body, options);
}
```

---

## Related Topic Guides

- [02. Core Concepts](../02-core-concepts.md)
- [05. Retries, Timeouts, and Cancellation](../05-retries-timeouts-and-cancellation.md)
- [06. Durable Workflows](../06-durable-workflows.md)
- [07. Storage & Adapters](../07-storage-and-adapters.md)
- [Idempotency Contract](../idempotency.md)
