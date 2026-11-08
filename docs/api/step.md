---
title: 'Step Methods'
description: 'API reference for the Step execution unit in Siglo: instantiation, schema validation, lifecycle hooks, retries, sagas, idempotency, caching, dependency injection, and network guardrails.'
---

# API Reference: Step Methods (`Step`)

The `Step` class is the fundamental execution unit in **Siglo**. A step encapsulates an async action, parameter validation contracts, lifecycle hooks, structured retry policies, SLA deadlines, idempotency locks, caching, and saga compensations.

---

## Table of Contents

- [The 5-Phase Step Lifecycle](#the-5-phase-step-lifecycle)
- [Instantiating Steps](#instantiating-steps)
    - [`Step.create(name?, action)`](#stepcreatename-action)
- [Validation and Contracts](#validation-and-contracts)
    - [`step.schema(schema)`](#stepschemaschema)
    - [`step.spec(field, options)`](#stepspecfield-options)
    - [`step.strict()`](#stepstrict)
- [Lifecycle Hooks](#lifecycle-hooks)
    - [`step.onBefore(hook)`](#steponbeforehook)
    - [`step.onSkip(hook)`](#steponskiphook)
    - [`step.onAfter(hook)`](#steponafterhook)
- [Fault Tolerance and Resilience](#fault-tolerance-and-resilience)
    - [`step.timeout(ms)`](#steptimeoutms)
    - [`step.onFail(config)`](#steponfailconfig)
    - [`step.compensate(handler, options?)`](#stepcompensatehandler-options)
- [Optimization and Deduplication](#optimization-and-deduplication)
    - [`step.idempotent(keyOrFn?, options?)`](#stepidempotentkeyorfn-options)
    - [`step.cache(msOrOptions)`](#stepcachemsoroptions)
- [Dependency Injection](#dependency-injection)
    - [`step.withDependencies(deps)`](#stepwithdependenciesdeps)
    - [`step.requireDependency(key)`](#steprequiredependencykey)
- [Context Transformation](#context-transformation)
    - [`step.reduce(field)`](#stepreducefield)
- [Network Egress Guardrails](#network-egress-guardrails)
    - [`step.allowNetwork(hosts)`](#stepallownetworkhosts)
    - [`step.allowUnixSockets(sockets)`](#stepallowunixsocketssockets)
    - [`step.denyNetwork()`](#stepdenynetwork)
    - [`step.networkPolicy(policy)`](#stepnetworkpolicypolicy)
- [Execution and Inspection](#execution-and-inspection)
    - [`step.run and step.execute`](#steprun-and-stepexecute)
    - [`step.toGraph`, `step.inspect`, `step.toMermaid`](#graph-and-export-methods)
- [Static Methods and Configuration](#static-methods-and-configuration)

---

## The 5-Phase Step Lifecycle

Every step executes through five distinct, deterministic phases:

```mermaid
flowchart TD
    CIn["Context In"] --> V["1. Validation"]
    V -->|Pass| B["2. onBefore"]
    V -->|Fail| VE["ValidationException"]

    B -->|Continue| A["3. Action"]
    B -->|Skip: false| OS["onSkip"]
    OS --> SO["Skip Output"]

    A -->|Success| AF["4. onAfter"]
    A -->|Fail| OF["onFail (Retry/Fallback)"]
    OF -->|Compensate| CR["Compensation Rollback"]

    AF --> CM["5. Context Merge"]
    CM --> COut["Context Out"]
```

1. **Validation**: Enforces parameter constraints declared via `.schema()` or `.spec()`. Rejections throw `ValidationException`.
2. **Pre-Execution Guard (`onBefore`)**: Evaluates whether the step should run. Returning `false` bypasses the action and triggers `onSkip`.
3. **Action Execution**: Runs the step action under the configured `timeout`, `idempotent` lock, and `onFail` retry strategy.
4. **Post-Execution Transform (`onAfter`)**: Modifies or enriches the raw output before merging.
5. **Context Merge**: Merges step output into the accumulated workflow context (or assigns it to a target property if `.reduce()` was configured).

> [!NOTE]
> **Network Guardrails Across Lifecycle Phases**: When `.allowNetwork()`, `.allowUnixSockets()`, `.denyNetwork()`, or `.networkPolicy()` is declared, the network egress policy governs phases 2 (`onBefore`/`onSkip`), 3 (`action`), 4 (`onAfter`), and `onFail` through Node's `AsyncLocalStorage`. Any unauthorized outbound call triggers a `NetworkPolicyViolationException` tagged with the active phase (`before`, `action`, or `after`).

---

## Instantiating Steps

### `Step.create(name?, action)`

Instantiates a typed `Step` execution unit with input and output contracts.

#### Signatures

```typescript
export type StepAction<TInput = any, TOutput = any> = (
    parameter: TInput,
    current?: any,
    index?: number,
) => TOutput | Promise<TOutput>;

export class Step<TInput = any, TOutput = any, TName extends string = string> {
    static create<TName extends string, TIn = any, TOut = any>(
        name: TName,
        action?: StepAction<TIn, TOut>,
    ): Step<TIn, TOut, TName>;

    static create<TIn = any, TOut = any>(action: StepAction<TIn, TOut> | Flow<TIn, TOut>): Step<TIn, TOut, string>;
}
```

#### Example

```typescript
import { Step } from '@siglo/core';

interface UserInput {
    userId: string;
}

interface UserOutput {
    name: string;
    email: string;
}

export const fetchUser = Step.create('fetchUser', async (param: UserInput): Promise<UserOutput> => {
    return { name: 'Bob', email: 'bob@example.com' };
});
```

---

## Validation and Contracts

### `step.schema(schema)`

Validates the incoming execution context against standard schema validators supporting the [Standard Schema](https://github.com/standard-schema/standard-schema) specification (`~standard`), including **Zod**, **Valibot**, and **ArkType**.

#### Signature

```typescript
step.schema<TSchema = any>(schemaObj: TSchema): Step<TInput, TOutput, TName>;
```

#### Example with Zod

```typescript
import { Step } from '@siglo/core';
import { z } from 'zod';

const OrderInputSchema = z.object({
    orderId: z.string().min(1),
    amount: z.number().positive(),
    currency: z.enum(['USD', 'EUR', 'GBP']),
});

export const processPayment = Step.create('processPayment', async (param: z.infer<typeof OrderInputSchema>) => {
    return { paymentCaptured: true };
}).schema(OrderInputSchema);
```

If validation fails, a `ValidationException` is thrown before the step action executes, containing detailed issue descriptions in `err.errors`.

---

### `step.spec(field, options)`

Declares granular parameter constraints, default values, transforms, and translations for a specific context field.

#### Signature

```typescript
export interface SpecData {
    require?: boolean;
    requireMessage?: string;
    default?: any;
    validate?: (value: any) => boolean;
    transform?: (value: any) => any;
    translate?: string; // Rename field in context
    schema?: any;       // Standard schema for this field
}

step.spec(field: string, options: SpecData): Step<TInput, TOutput, TName>;
```

#### Example

```typescript
const sanitizeInput = Step.create('sanitizeInput', async (param: any) => {
    return { cleanEmail: param.userEmail };
})
    .spec('email', {
        require: true,
        requireMessage: 'Customer email is mandatory.',
        validate: async (v: string) => v.includes('@'),
        transform: async (v: string) => v.trim().toLowerCase(),
        translate: async (param: any, value: string) => {
            param.userEmail = value;
        },
    })
    .spec('newsletterOptIn', {
        default: false,
    });
```

---

### `step.strict()`

Enforces strict parameter filtering on incoming parameters, selecting only declared spec fields and filtering out undeclared properties before the action executes.

#### Signature

```typescript
step.strict(): Step<TInput, TOutput, TName>;
```

#### Example

```typescript
const strictStep = Step.create('createAccount', async (param: any) => {
    // Only declared spec fields ('username') are present in param; extra keys are filtered
    return { created: param.username, hasExtra: 'extraField' in param };
})
    .spec('username', { require: true })
    .strict();

const result = await strictStep.run({ username: 'alice', extraField: 'filtered out' } as any);
console.log(result.hasExtra); // false
```

---

## Lifecycle Hooks

### `step.onBefore(hook)`

Pre-execution guard hook. Evaluates the incoming parameter context before the action executes. If it returns `false`, step action execution is skipped and control transfers to `onSkip` (or context passes through unchanged).

#### Signature

```typescript
export type OnBeforeAction<TInput = any> = (
    parameter: TInput
) => boolean | Promise<boolean>;

step.onBefore(hook: OnBeforeAction<TInput>): Step<TInput, TOutput, TName>;
```

#### Example

```typescript
const sendInvoice = Step.create('sendInvoice', async (param: { amount: number }) => ({ invoiceSent: true })).onBefore(
    param => param.amount > 0,
); // Skip if amount is 0
```

---

### `step.onSkip(hook)`

Fallback hook that executes if and only if `onBefore` returns `false`. Its returned value is merged into the context in place of the step action output.

#### Signature

```typescript
export type OnSkipAction<TInput = any, TFallback = any> = (
    parameter: TInput
) => TFallback | Promise<TFallback>;

step.onSkip(hook: OnSkipAction<TInput>): Step<TInput, TOutput, TName>;
```

#### Example

```typescript
const chargeSubscription = Step.create('charge', async () => ({ charged: true }))
    .onBefore((param: { isTrial: boolean }) => !param.isTrial)
    .onSkip(param => ({ charged: false, trialSkipped: true }));
```

---

### `step.onAfter(hook)`

Post-execution transformation hook. Receives the raw output produced by the step action and the input parameters, returning an enriched or transformed output.

#### Signature

```typescript
export type OnAfterAction<TOutput = any, TInput = any> = (
    output: TOutput,
    parameter: TInput
) => any | Promise<any>;

step.onAfter(hook: OnAfterAction<TOutput, TInput>): Step<TInput, TOutput, TName>;
```

#### Example

```typescript
const calculateTax = Step.create('calcTax', async (param: { subtotal: number }) => ({
    tax: param.subtotal * 0.08,
})).onAfter((output, param) => ({
    ...output,
    totalWithTax: param.subtotal + output.tax,
}));
```

---

## Fault Tolerance and Resilience

### `step.timeout(ms)`

Enforces a per-step SLA deadline in milliseconds. If the step action takes longer than `ms`, the action is aborted via `AbortSignal` and throws a `StepTimeoutException`.

#### Signature

```typescript
step.timeout(ms: number): Step<TInput, TOutput, TName>;
```

#### Example

```typescript
import { Step, StepTimeoutException } from '@siglo/core';

const callExternalVendor = Step.create('vendorApi', async () => {
    const res = await fetch('https://api.vendor.com/data');
    return res.json();
}).timeout(2000); // 2-second timeout
```

---

### `step.onFail(config)`

Configures structured retry policies or custom error fallback handlers when the step action throws.

#### Signatures

```typescript
export interface RetryConfig {
    maxRetries?: number;
    delay?: number;
    backoff?: 'fixed' | 'linear' | 'exponential' | ((attempt: number) => number);
    jitter?: boolean | ((delay: number) => number);
    maxDelay?: number;
    retryIf?: (err: any, attempt: number) => boolean;
    onRetry?: (error: any, attempt: number, delayMs?: number) => void;
}

export type OnFailCallback = (
    error: any,
    retry: (fallback?: any) => void,
    reject: (err?: any) => void
) => any;

step.onFail(config: RetryConfig | OnFailCallback): Step<TInput, TOutput, TName>;
```

#### Example with Exponential Backoff & Jitter

```typescript
const resilientFetch = Step.create('fetchData', async () => {
    return await externalService.call();
}).onFail({
    maxRetries: 3,
    delay: 500,
    backoff: 'exponential',
    jitter: true,
    maxDelay: 5000,
    retryIf: err => err.status >= 500, // Only retry 5xx server errors
    onRetry: (err, attempt) => console.warn(`Retry attempt ${attempt} due to ${err.message}`),
});
```

#### Example with OnFail Fallback

To provide a graceful fallback return value when errors occur, use the callback form:

```typescript
const resilientFetchWithFallback = Step.create('fetchData', async () => {
    return await externalService.call();
}).onFail((err, retry, reject) => {
    if (err.status >= 500) {
        retry({ fallbackData: true }); // Resolves step with fallback data
    } else {
        reject(err);
    }
});
```

---

### `step.compensate(handler, options?)`

Registers a saga compensation rollback handler. If downstream steps in the workflow fail, registered compensation handlers execute automatically in reverse order (LIFO).

#### Signature

```typescript
export interface CompensationOptions {
    maxRetries?: number;
    delay?: number;
    retryIf?: (err: any, attempt: number) => boolean;
}

step.compensate(
    handler: (ctx: any) => Promise<void> | void,
    options?: CompensationOptions
): Step<TInput, TOutput, TName>;
```

#### Example

```typescript
const bookFlight = Step.create('bookFlight', async (ctx: { flightNo: string }) => {
    const booking = await airlineApi.reserve(ctx.flightNo);
    return { flightReservationId: booking.id };
}).compensate(
    async ctx => {
        // Automatically called if payment or hotel booking fails downstream
        await airlineApi.cancelReservation(ctx.flightReservationId);
    },
    { maxRetries: 3, delay: 1000 },
);
```

---

## Optimization and Deduplication

### `step.idempotent(keyOrFn?, options?)`

Guarantees step deduplication and concurrent claim locking using deterministic idempotency keys and TTL storage.

#### Signature

```typescript
step.idempotent(
    keyOrFn?: string | ((ctx: any) => string),
    options?: { ttlMs?: number; store?: IdempotencyStore }
): Step<TInput, TOutput, TName>;
```

#### Semantics

1. **Claiming**: Before execution, attempts to claim the key in the configured `IdempotencyStore`.
2. **Conflict**: If already in-progress, throws `IdempotencyConflictException`.
3. **Cache Hit**: If previously completed and within TTL, returns cached output without re-executing.
4. **Completion**: Upon successful execution, records output and marks status `COMPLETED`.

#### Example

```typescript
const chargeCard = Step.create('chargeCard', async (ctx: { idempotencyToken: string; amount: number }) => {
    return await stripe.charges.create({ amount: ctx.amount });
}).idempotent(ctx => ctx.idempotencyToken, { ttlMs: 86400000 }); // 24-hour TTL
```

---

### `step.cache(msOrOptions)`

Caches step output in memory or persistent storage (`StorageAdapter`) based on input parameters.

#### Signatures

```typescript
export interface CacheOptions {
    ttl?: number;
    staleWhileRevalidate?: number;
    swr?: boolean | number;
    keySerializer?: (stepId: string, param: any, namespace?: string) => string;
    stampedeProtection?: boolean;
}

step.cache(cachedLastOrOptions?: number | CacheOptions): Step<TInput, TOutput, TName>;
```

#### Example

```typescript
const getExchangeRates = Step.create('rates', async () => {
    return await fetchRates();
}).cache({ ttl: 60000 }); // Cache for 60 seconds
```

---

## Dependency Injection

### `step.withDependencies(deps)`

Attaches runtime dependencies and service repositories directly to the step.

#### Signature

```typescript
step.withDependencies(dependencies: Record<string, any>): this;
```

---

### `step.requireDependency(key)`

Retrieves a required injected dependency or throws a descriptive error if missing.

#### Signature

```typescript
step.requireDependency<T = any>(key: string): T;
```

#### Example

```typescript
interface DatabaseClient {
    query: (sql: string) => Promise<any>;
}

const saveUser = Step.create('saveUser', async (param: { name: string }) => {
    const db = saveUser.requireDependency<DatabaseClient>('db');
    await db.query(`INSERT INTO users (name) VALUES ('${param.name}')`);
    return { saved: true };
}).withDependencies({ db: myDbClient });
```

---

## Context Transformation

### `step.reduce(field)`

Assigns the step output directly to a designated field in the accumulated context instead of shallow-merging properties.

#### Signature

```typescript
step.reduce(field: string): Step<TInput, TOutput, TName>;
```

#### Example

```typescript
const countItems = Step.create('count', async () => 42).reduce('itemCount');

// Output context: { itemCount: 42 } rather than { value: 42 }
```

---

## Network Egress Guardrails

Steps can declare granular network egress permissions enforced via Node's `AsyncLocalStorage` (ASL). In flows with an outer network policy, the flow supersedes the step; steps can only narrow permissions within what the flow permits. By default, loopback addresses (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`) and local Unix domain socket IPC are allowed.

### Lifecycle Hook Governance

The network policy boundary wraps the **entire step execution lifecycle** via `AsyncLocalStorage`:

- **`onBefore` & `onSkip`**: Pre-execution guards and fallback computations are governed by the step's allowlist (violations tagged with `phase: 'before'`).
- **`action` & `reduce`**: The core step execution runs within the policy context (violations tagged with `phase: 'action'`).
- **`onAfter`**: Context enrichment and post-processing cannot bypass step network restrictions (violations tagged with `phase: 'after'`).
- **`onFail`**: Step-level retries and fallback error handlers adhere to the policy perimeter.
- **Global Plugins (`executeBefore`, `executeAfter`)**: Engine-level plugins execute **outside** this boundary to ensure system observability and metrics remain unaffected.
- **Compensations (`step.compensate`)**: Sagas rollback in an independent scope with their own execution perimeter.

---

### `step.allowNetwork(hosts)`

Declares an allowlist of target hosts, wildcard subdomains, ports, or regular expressions permitted for network calls during this step.

#### Signatures

```typescript
step.allowNetwork(hosts: (string | RegExp)[] | string | RegExp): this;
```

#### Parameters

- `hosts`: `(string | RegExp)[]` &mdash; Array of hostnames (`'api.stripe.com'`), wildcard patterns (`'*.stripe.com'`), specific ports (`'api.internal:8080'`), or RegExps (`/^api\.internal$/`).

#### Example

```typescript
const chargeStep = Step.create('charge', async ({ amount }) => {
    return await fetch('https://api.stripe.com/v1/charges', {/* ... */});
}).allowNetwork(['api.stripe.com', '*.stripe.network']);
```

---

### `step.allowUnixSockets(sockets)`

Explicitly permits communication over specified local Unix domain sockets (IPC filesystem paths) during step execution.

#### Signature

```typescript
step.allowUnixSockets(sockets: string | string[]): this;
```

#### Example

```typescript
const dockerStep = Step.create('dockerInspect', async () => {
    // Connects to local Docker daemon Unix socket
    return await queryDockerDaemon('/var/run/docker.sock');
}).allowUnixSockets(['/var/run/docker.sock']);
```

---

### `step.denyNetwork()`

Shorthand for `.allowNetwork([])`. Strictly denies all external outbound network access from the step's lifecycle hooks and action.

#### Signature

```typescript
step.denyNetwork(): this;
```

#### Example

```typescript
const computeTax = Step.create('computeTax', ({ subtotal }) => {
    return { tax: subtotal * 0.08 };
}).denyNetwork(); // Disallows external network egress entirely
```

---

### `step.networkPolicy(policy)`

Configures the complete network egress policy object for the step.

#### Signature

```typescript
step.networkPolicy(policy: NetworkPolicyConfig): this;
```

#### Parameters

- `policy`: `NetworkPolicyConfig`
    - `allowedHosts`: `(string | RegExp)[]` _(optional)_ &mdash; Allowed target host patterns.
    - `defaultPolicy`: `'allow' | 'deny'` _(optional, default: `'deny'`)_ &mdash; Default fallback rule.
    - `allowLocalhost`: `boolean` _(optional, default: `true`)_ &mdash; Loopback exemption.
    - `allowUnixSockets`: `string[]` _(optional)_ &mdash; Allowed Unix domain socket paths.

#### Example

```typescript
const syncStep = Step.create('sync', async () => {
    /* ... */
}).networkPolicy({
    allowedHosts: ['api.github.com'],
    defaultPolicy: 'deny',
    allowLocalhost: true,
    allowUnixSockets: ['/var/run/docker.sock'],
});
```

---

## Execution and Inspection

### `step.run and step.execute`

Runs the step directly as a standalone unit.

```typescript
const output = await fetchUser.run({ userId: 'u_123' }, { pojo: true });
```

### Graph and Export Methods

- `step.toGraph()`: Returns a `StepNode` AST.
- `step.inspect()`: Returns inspection metrics for this step.
- `step.toMermaid()` / `step.toDot()` / `step.toJSON()`: Visual diagram and AST exports.

---

## Static Methods and Configuration

The `Step` class exposes static utilities and orchestrator shortcuts:

- `Step.create(name, action)`: Primary factory method for step construction.
- `Step.flow(...steps)` / `Step.pipe(...steps)`: Shorthand alias to compose a sequential `Flow`.
- `Step.start(steps, param?, options?)`: Low-level executor entry point.
- `Step.config(props)`: Configures global runtime settings (logging, plugins, telemetry).
- `Step.useStorage(adapter)`: Registers the global `StorageAdapter`.
- `Step.checkpoint(stackId, options?)`: Captures an instantaneous checkpoint snapshot.
- `Step.restoreCheckpoint(data, options?)`: Restores stack state from a serialized snapshot.
- `Step.parallel(...)`, `Step.all(...)`, `Step.allSettled(...)`, `Step.race(...)`: Combinator factories.
- `Step.when(...)`, `Step.branch(...)`, `Step.map(...)`: Branching and collection combinators.
- `Step.waitForEvent(...)`, `Step.wait(...)`: Durable wait factories.

---

## Related Topic Guides

- [02. Core Concepts](/02-core-concepts)
- [03. Sequential Workflows](/03-sequential-workflows)
- [05. Retries, Timeouts, and Cancellation](/05-retries-timeouts-and-cancellation)
- [10. TypeScript Reference](/10-typescript-reference)
- [Compensation and Sagas Contract](/compensation-and-sagas)
- [Idempotency Contract](/idempotency)
- [Network Egress Policy](/network-egress-policy)
