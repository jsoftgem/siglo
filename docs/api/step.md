# API Reference: Step Methods (`Step`)

The `Step` class is the fundamental execution unit in **Siglo**. A step encapsulates an async action, parameter validation contracts, lifecycle hooks, structured retry policies, SLA deadlines, idempotency locks, caching, and saga compensations.

---

## Table of Contents

- [The 5-Phase Step Lifecycle](#the-5-phase-step-lifecycle)
- [Instantiating Steps](#instantiating-steps)
  - [`Step.create(name?, action)`](#stepcreatename-action)
- [Validation & Contracts](#validation--contracts)
  - [`step.schema(schema)`](#stepschemaschema)
  - [`step.spec(field, options)`](#stepspecfield-options)
  - [`step.strict()`](#stepstrict)
- [Lifecycle Hooks](#lifecycle-hooks)
  - [`step.onBefore(hook)`](#steponbeforehook)
  - [`step.onSkip(hook)`](#steponskiphook)
  - [`step.onAfter(hook)`](#steponafterhook)
- [Fault Tolerance & Resilience](#fault-tolerance--resilience)
  - [`step.timeout(ms)`](#steptimeoutms)
  - [`step.onFail(config | callback)`](#steponfailconfig--callback)
  - [`step.compensate(handler, options?)`](#stepcompensatehandler-options)
- [Optimization & Deduplication](#optimization--deduplication)
  - [`step.idempotent(keyOrFn?, options?)`](#stepidempotentkeyorfn-options)
  - [`step.cache(ms | options)`](#stepcachems--options)
- [Dependency Injection](#dependency-injection)
  - [`step.withDependencies(deps)`](#stepwithdependenciesdeps)
  - [`step.requireDependency(key)`](#steprequiredependencykey)
- [Context Transformation](#context-transformation)
  - [`step.reduce(field)`](#stepreducefield)
- [Execution & Inspection](#execution--inspection)
  - [`step.run(param?, options?)` / `step.execute()`](#steprunparam-options--stepexecute)
  - [`step.toGraph()`, `step.inspect()`, `step.toMermaid()`](#graph-and-export-methods)
- [Static Methods & Configuration](#static-methods--configuration)

---

## The 5-Phase Step Lifecycle

Every step executes through five distinct, deterministic phases:

```
Context In ──> [ 1. Validation ] ──> [ 2. onBefore ] ──> [ 3. Action ] ──> [ 4. onAfter ] ──> [ 5. Context Merge ] ──> Context Out
                     │                      │                   │
                     ▼ (fail)               ▼ (skip: false)     ▼ (fail)
             ValidationException        [ onSkip ]         [ onFail (Retry/Fallback) ]
                                            │                   │ (compensate)
                                            ▼                   ▼
                                       Skip Output      Compensation Rollback
```

1. **Validation**: Enforces parameter constraints declared via `.schema()` or `.spec()`. Rejections throw `ValidationException`.
2. **Pre-Execution Guard (`onBefore`)**: Evaluates whether the step should run. Returning `false` bypasses the action and triggers `onSkip`.
3. **Action Execution**: Runs the step action under the configured `timeout`, `idempotent` lock, and `onFail` retry strategy.
4. **Post-Execution Transform (`onAfter`)**: Modifies or enriches the raw output before merging.
5. **Context Merge**: Merges step output into the accumulated workflow context (or assigns it to a target property if `.reduce()` was configured).

---

## Instantiating Steps

### `Step.create(name?, action)`

Instantiates a typed `Step` execution unit with input and output contracts.

#### Signatures

```typescript
export type StepAction<TInput = any, TOutput = any> = (
    parameter: TInput,
    current?: any,
    index?: number
) => TOutput | Promise<TOutput>;

export class Step<TInput = any, TOutput = any, TName extends string = string> {
    static create<TName extends string, TIn = any, TOut = any>(
        name: TName,
        action?: StepAction<TIn, TOut>
    ): Step<TIn, TOut, TName>;

    static create<TIn = any, TOut = any>(
        action: StepAction<TIn, TOut> | Flow<TIn, TOut>
    ): Step<TIn, TOut, string>;
}
```

#### Example

```typescript
import { Step } from 'siglo';

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

## Validation & Contracts

### `step.schema(schema)`

Validates the incoming execution context against standard schema validators supporting the [Standard Schema](https://github.com/standard-schema/standard-schema) specification (`~standard`), including **Zod**, **Valibot**, and **ArkType**.

#### Signature

```typescript
step.schema<TSchema = any>(schemaObj: TSchema): Step<TInput, TOutput, TName>;
```

#### Example with Zod

```typescript
import { Step } from 'siglo';
import { z } from 'zod';

const OrderInputSchema = z.object({
    orderId: z.string().min(1),
    amount: z.number().positive(),
    currency: z.enum(['USD', 'EUR', 'GBP'])
});

export const processPayment = Step.create('processPayment', async (param: z.infer<typeof OrderInputSchema>) => {
    return { paymentCaptured: true };
})
.schema(OrderInputSchema);
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
    validate: (v: string) => v.includes('@'),
    transform: (v: string) => v.trim().toLowerCase(),
    translate: 'userEmail' // Renames param.email -> param.userEmail
})
.spec('newsletterOptIn', {
    default: false
});
```

---

### `step.strict()`

Enforces strict validation on incoming parameters, rejecting contexts that contain undeclared properties.

#### Signature

```typescript
step.strict(): Step<TInput, TOutput, TName>;
```

#### Example

```typescript
const strictStep = Step.create('createAccount', async (param: { username: string }) => ({ id: '1' }))
    .spec('username', { require: true })
    .strict();

// Throws ValidationException: Extra undeclared keys detected
await strictStep.run({ username: 'alice', extraField: 'not allowed' } as any);
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
const sendInvoice = Step.create('sendInvoice', async (param: { amount: number }) => ({ invoiceSent: true }))
    .onBefore((param) => param.amount > 0); // Skip if amount is 0
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
    .onSkip((param) => ({ charged: false, trialSkipped: true }));
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
const calculateTax = Step.create('calcTax', async (param: { subtotal: number }) => ({ tax: param.subtotal * 0.08 }))
    .onAfter((output, param) => ({
        ...output,
        totalWithTax: param.subtotal + output.tax
    }));
```

---

## Fault Tolerance & Resilience

### `step.timeout(ms)`

Enforces a per-step SLA deadline in milliseconds. If the step action takes longer than `ms`, the action is aborted via `AbortSignal` and throws a `StepTimeoutException`.

#### Signature

```typescript
step.timeout(ms: number): Step<TInput, TOutput, TName>;
```

#### Example

```typescript
import { Step, StepTimeoutException } from 'siglo';

const callExternalVendor = Step.create('vendorApi', async (param, _curr, _idx) => {
    const res = await fetch('https://api.vendor.com/data');
    return res.json();
})
.timeout(2000); // 2-second timeout
```

---

### `step.onFail(config | callback)`

Configures structured retry policies or custom error fallback handlers when the step action throws.

#### Signatures

```typescript
export interface RetryConfig {
    maxRetries?: number;
    delay?: number;
    backoff?: 'fixed' | 'linear' | 'exponential';
    jitter?: boolean;
    maxDelay?: number;
    retryable?: (err: any) => boolean;
    onRetry?: (error: any, attempt: number) => void;
    fallback?: (error: any, param: any) => any;
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
})
.onFail({
    maxRetries: 3,
    delay: 500,
    backoff: 'exponential',
    jitter: true,
    maxDelay: 5000,
    retryable: (err) => err.status >= 500, // Only retry 5xx server errors
    onRetry: (err, attempt) => console.warn(`Retry attempt ${attempt} due to ${err.message}`),
    fallback: (err) => ({ fallbackData: true }) // Graceful fallback on complete failure
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
    backoff?: 'fixed' | 'linear' | 'exponential';
    timeout?: number;
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
})
.compensate(async (ctx) => {
    // Automatically called if payment or hotel booking fails downstream
    await airlineApi.cancelReservation(ctx.flightReservationId);
}, { maxRetries: 3, delay: 1000 });
```

---

## Optimization & Deduplication

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
})
.idempotent((ctx) => ctx.idempotencyToken, { ttlMs: 86400000 }); // 24-hour TTL
```

---

### `step.cache(ms | options)`

Caches step output in memory or persistent storage (`StorageAdapter`) based on input parameters.

#### Signatures

```typescript
export interface CacheOptions {
    ttl?: number;
    key?: string | ((param: any) => string);
    namespace?: string;
}

step.cache(cachedLastOrOptions?: number | CacheOptions): Step<TInput, TOutput, TName>;
```

#### Example

```typescript
const getExchangeRates = Step.create('rates', async () => {
    return await fetchRates();
})
.cache({ ttl: 60000 }); // Cache for 60 seconds
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

const saveUser = Step.create('saveUser', async (param: { name: string }, _curr, _idx) => {
    const db = saveUser.requireDependency<DatabaseClient>('db');
    await db.query(`INSERT INTO users (name) VALUES ('${param.name}')`);
    return { saved: true };
})
.withDependencies({ db: myDbClient });
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
const countItems = Step.create('count', async () => 42)
    .reduce('itemCount');

// Output context: { itemCount: 42 } rather than { value: 42 }
```

---

## Execution & Inspection

### `step.run(param?, options?)` / `step.execute()`

Runs the step directly as a standalone unit.

```typescript
const output = await fetchUser.run({ userId: 'u_123' }, { pojo: true });
```

### Graph and Export Methods

- `step.toGraph()`: Returns a `StepNode` AST.
- `step.inspect()`: Returns inspection metrics for this step.
- `step.toMermaid()` / `step.toDot()` / `step.toJSON()`: Visual diagram and AST exports.

---

## Static Methods & Configuration

- `Step.create(name, action)`: Primary factory method.
- `Step.start(steps, param?, options?)`: Executes steps or flows.
- `Step.config(props)`: Configures global runtime options (e.g. logging, storage).

---

## Related Topic Guides

- [02. Core Concepts](../02-core-concepts.md)
- [03. Sequential Workflows](../03-sequential-workflows.md)
- [05. Retries, Timeouts, and Cancellation](../05-retries-timeouts-and-cancellation.md)
- [10. TypeScript Reference](../10-typescript-reference.md)
- [Compensation & Sagas Contract](../compensation-and-sagas.md)
- [Idempotency Contract](../idempotency.md)
