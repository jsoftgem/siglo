# Siglo Runtime & Resilience Cheatsheet

Quick reference for `ExecutionOptions`, `SigloError` hierarchy, cooperative cancellation, and graph validation in `@siglo/core`.

---

## 1. `ExecutionOptions` Reference

Passed into `flow.run(input, options)` and `step.run(input, options)`:

| Option                  | Type                              | Default     | Description                                                                |
| :---------------------- | :-------------------------------- | :---------- | :------------------------------------------------------------------------- |
| `signal`                | `AbortSignal`                     | `undefined` | Standard AbortSignal for cooperative cancellation.                         |
| `timeout` / `timeoutMs` | `DurationInput` (`number\|string`) | `undefined` | Overall workflow SLA deadline (e.g. `10000`, `'10s'`, `'5m'`).             |
| `services`              | `Record<string, any>`             | `{}`        | Dependency injection container accessible inside steps.                    |
| `namespace`             | `string`                          | `undefined` | Logical domain or tenant tag for logs and checkpoint isolation.            |
| `pojo`                  | `boolean`                         | `true`      | Normalizes proxy wrappers into clean plain JavaScript objects.             |
| `durable`               | `boolean`                         | `false`     | Enables durable checkpoint persistence upon suspension.                    |
| `idempotencyKey`        | `DynamicOption<string, TContext>` | `undefined` | Static string or sync `(ctx) => string` deduplication key.                 |
| `idempotencyTtlMs`      | `DurationInput` (`number\|string`) | `undefined` | Idempotency retention window (e.g. `'24h'`, `86400000`).                   |
| `networkPolicy`         | `NetworkPolicyConfig`             | `undefined` | ASL egress perimeter enclosing nested combinators, subflows & rollbacks.   |
| `stepExecutionHook`     | `StepExecutionHook`               | `undefined` | Lifecycle interceptor executed before/after every step.                    |

---

## 2. `SigloError` Exception Hierarchy

All framework exceptions inherit from `SigloError`:

```typescript
interface SigloErrorMetadata {
    stepName?: string;
    phase?: 'validation' | 'before' | 'action' | 'after' | 'compensation';
    retryable: boolean;
    stackId?: string;
    namespace?: string;
}
```

| Exception Class                     | Retryable | Typical Trigger                             | Recommended Action                        |
| :---------------------------------- | :-------- | :------------------------------------------ | :---------------------------------------- |
| `StepTimeoutException`              | **Yes**   | Step exceeded `.timeout(ms)`.               | Retry with backoff or failover.           |
| `FlowTimeoutException`              | **No**    | Total workflow exceeded SLA.                | Escalate alert; cancel in-flight tasks.   |
| `CancellationException`             | **No**    | User or system called `controller.abort()`. | Clean up resources; return 499 / 204.     |
| `ValidationException`               | **No**    | `.spec()` or `.schema()` rejected inputs.   | Return 400 Bad Request to caller.         |
| `GraphValidationException`          | **No**    | Cyclic dependency or duplicate step ID.     | Fix workflow composition at build time.   |
| `CompensationException`             | **No**    | Rollback handler encountered error.         | Log rollback event; investigate service.  |
| `UnresolvableCompensationException` | **No**    | Compensation handler threw and failed.      | Route to Dead-Letter Queue (DLQ) & alert. |
| `IdempotencyConflictException`      | **No**    | Concurrent execution with identical key.    | Return 409 Conflict or wait for lock.     |
| `FieldCollisionException`           | **No**    | Parallel branches wrote duplicate keys.     | Use `mergeStrategy: 'namespace'`.         |
| `NetworkPolicyViolationException`   | **No**    | Unauthorized outbound network call.         | Check step `.allowNetwork()` allowlist.   |
| `CheckpointConflictException`       | **Yes**   | Concurrency OCC version mismatch.           | Reload checkpoint and retry transaction.  |

---

## 3. Dynamic `retryIf` Predicate Recipes

```typescript
// Recipe 1: Retry transient HTTP and server errors (5xx + 429)
step.onFail({
    maxRetries: 3,
    delay: '200ms',
    backoff: 'exponential',
    jitter: true,
    retryIf: (err: any) => {
        const status = err.status || err.statusCode;
        return status === 429 || (status >= 500 && status <= 599);
    },
});

// Recipe 2: Retry transient Node network socket errors
step.onFail({
    maxRetries: 3,
    delay: 150,
    backoff: 'exponential',
    retryIf: (err: any) => {
        const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'];
        return transientCodes.includes(err.code);
    },
});

// Recipe 3: Respect SigloError retryable flag
step.onFail({
    maxRetries: 2,
    retryIf: (err: any) => err.retryable === true,
});
```

---

## 4. AST Graph Validation & Export

```typescript
import { validateGraph, assertValidGraph, toMermaid, toDot, toJSON } from '@siglo/core';

// 1. Static validation (returns Issue[])
const issues = validateGraph(myFlow.toGraph());

// 2. Strict assertion (throws GraphValidationException if invalid)
assertValidGraph(myFlow.toGraph());

// 3. Export to Mermaid diagram
const mermaidCode = toMermaid(myFlow, { direction: 'TD', theme: 'default' });

// 4. Export to Graphviz DOT
const dotCode = toDot(myFlow, { graphName: 'OrderFlow' });

// 5. Export to raw AST JSON
const jsonAST = toJSON(myFlow);
```
