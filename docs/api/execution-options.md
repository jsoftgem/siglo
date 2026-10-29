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
    /** Strip internal proxy wrappers and return clean plain JavaScript objects (default: true). */
    pojo?: boolean;

    /** Execution return mode: 'pojo' (recommended) or 'wrapped' (legacy context). */
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

    /** Workflow schema version for migration verification upon resumption. */
    workflowVersion?: string | number;

    /** State migration functions keyed by target version for upgrading suspended checkpoints. */
    migrations?: Record<string, (state: any) => any>;

    /** Multi-tenant partition namespace isolating checkpoints, caches, and idempotency keys. */
    namespace?: string;

    /** Workflow-level idempotency deduplication key or generator function. */
    idempotencyKey?: string | ((ctx: any) => string);

    /** Custom idempotency store adapter. */
    idempotencyStore?: IdempotencyStore;

    /** Retention TTL for idempotency records in milliseconds (default: 86400000 / 24h). */
    idempotencyTtlMs?: number;

    /** Custom workflow identifier attached to telemetry, logs, and checkpoints. */
    workflowId?: string;

    /** Explicit caller-supplied execution stack ID. */
    stackId?: string;
}
```

---

## Option Details

### `pojo` and `mode`

Controls whether the workflow output returns clean, plain JavaScript objects (POJOs) or legacy tracked context wrappers.

- `pojo: true` *(default in v1.0)*: Automatically strips internal proxy wrappers, getters, and execution internals, returning clean JSON-serializable objects.
- `mode: 'pojo' | 'wrapped'`: Explicitly configures POJO output mode (`'pojo'`) or legacy wrapped mode (`'wrapped'`).

```typescript
const result = await myFlow.run(input, { pojo: true });
console.log(result); // Clean plain object
```

---

### `signal`

An `AbortSignal` instance used for cooperative cancellation.

- **Propagation**: Passed to every step action via `param.$signal`.
- **In-Flight Cancellation**: When aborted, pending retry backoff delays and parallel sibling branches are aborted immediately.
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
- When a workflow encounters `waitForEvent()` or `wait()`, Siglo suspends the workflow, serializes the current context into a checkpoint, persists it to the configured `StorageAdapter`, and throws a `WorkflowSuspendedException`.
- Allows workflows to pause for hours, days, or months and resume safely upon external event delivery via `resumeWorkflow()`.

```typescript
await myFlow.run({ orderId: 'ord_123' }, { durable: true });
```

---

### `workflowVersion`

Declares the schema version of the workflow definition (e.g. `'v1'`, `'v2.0'`).

- Used during durable workflow resumption to detect code changes between when the checkpoint was created and when it was resumed.
- If the checkpoint's version differs from `workflowVersion` and no matching migration is provided in `migrations`, `WorkflowVersionMismatchException` is thrown.

---

### `migrations`

A map of transformation functions keyed by target version to migrate suspended checkpoint state when workflow definitions evolve.

```typescript
const migrations = {
    // Migrates checkpoint created under v1 to v2 schema
    'v2': (oldState: any) => ({
        ...oldState,
        customerFullName: `${oldState.firstName} ${oldState.lastName}`
    })
};

await resumeWorkflow(orderWorkflow, correlationKey, eventPayload, {
    workflowVersion: 'v2',
    migrations
});
```

---

### `namespace`

A string partition key used for multi-tenant isolation.

- Enforces strict isolation of checkpoints, cached step outputs, and idempotency locks.
- Restoring a checkpoint into a different namespace throws `NamespaceMismatchException`.

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

### `idempotencyStore` and `idempotencyTtlMs`

- `idempotencyStore`: Custom adapter implementing the `IdempotencyStore` interface (e.g. `PostgresIdempotencyStore`, `RedisIdempotencyStore`, or `InMemoryIdempotencyStore`).
- `idempotencyTtlMs`: Retention window for idempotency records in milliseconds (default: `86400000` / 24 hours).

---

### `workflowId` and `stackId`

- `workflowId`: Human-readable workflow identifier attached to telemetry, logs, and checkpoints.
- `stackId`: Explicit caller-provided execution stack ID. If omitted, Siglo automatically generates a unique UUID.

---

## Comprehensive Production Example

```typescript
import { Step, flow } from 'siglo';
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
