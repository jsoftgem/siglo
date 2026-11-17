# @siglo/core API Cheatsheet

Quick reference for core classes, functions, options, and error hierarchies in `@siglo/core`.

---

## 1. Primary Flow & Step Functions

| Export                                          | Signature                                                                                          | Description                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `Step.create(name, fn)`                         | `Step.create<TIn, TOut>(name: string, action: (ctx: TIn) => Promise<TOut> \| TOut): Step`          | Creates a typed atomic step.                                         |
| `flow(...items)`                                | `flow<TIn, TOut>(...items: FlowItem[]): Flow<TIn, TOut>`                                           | Chains steps and combinators into an executable sequential pipeline. |
| `parallel(branches, options?)`                  | `parallel(branches: FlowItem[], options?: ParallelOptions): Step`                                  | Concurrent fan-out with configurable merge strategy.                 |
| `race(branches)`                                | `race(branches: FlowItem[]): Step`                                                                 | Competitive concurrency; fastest branch wins.                        |
| `when(predicate, thenStep, elseStep?)`          | `when(predicate: (ctx) => boolean, thenStep, elseStep?): Step`                                     | Conditional binary branch.                                           |
| `branch(selector, branchesMap, default?)`       | `branch(selector: (ctx) => string, branches: Record<string, FlowItem>, default?: FlowItem): Step`  | Multi-way dictionary routing.                                        |
| `map(accessor, stepOrFlow, options?)`           | `map(accessor: (ctx) => any[], stepOrFlow: FlowItem, options?: MapOptions): Step`                  | Bounded concurrent iteration over array items.                       |
| `waitForEvent(eventName, options)`              | `waitForEvent(eventName: string, options: WaitForEventOptions): Step`                              | Suspends execution until external event or webhook arrives.          |
| `wait(duration)`                                | `wait(duration: string \| number): Step`                                                           | Durable timer sleep (e.g. `'24h'`, `'30m'`, `5000`).                 |
| `resumeWorkflow(flow, correlationKey, payload)` | `resumeWorkflow(flow: Flow, key: string, payload?: any, options?: ExecutionOptions): Promise<any>` | Resumes a suspended workflow run.                                    |

---

## 2. Step Builder Methods

All methods are chainable on a `Step` instance:

```typescript
const step = Step.create('myStep', async ctx => ({ result: 1 }))
    // Validation, sanitization, translation & parameter hygiene
    .spec('email', {
        require: true,
        requireMessage: 'Customer email is required',
        default: 'guest@example.com',
        validate: async (email: string) => {
            if (!email.includes('@')) throw new Error('Invalid email format');
        },
        transform: async (email: string) => email.trim().toLowerCase(),
        translate: async (email: string, ctx: any) => ctx.set('userEmail', email),
        schema: z.string().email(),
    })
    .strict() // Strips undeclared parameters before action execution
    .schema(ZodSchema) // Validates full input against Standard Schema (Zod, Valibot, ArkType)
    .onBefore(async ctx => shouldRun(ctx)) // Gate predicate: return false to skip action
    .onSkip(ctx => ({ result: 0 })) // Fallback data when onBefore returns false
    .onAfter(async (output, ctx) => out) // Transform output before context merge
    .onFail({
        // Retries with backoff curve
        maxRetries: 3,
        delay: 100,
        backoff: 'exponential', // 'fixed' | 'linear' | 'exponential'
        factor: 2,
        maxDelay: 5000,
        jitter: true,
        retryIf: err => err.isTransient,
    })
    .compensate(async (output, ctx) => {}) // LIFO Saga rollback handler
    .timeout(5000) // Step timeout in milliseconds
    .idempotent({ keyBuilder, ttlMs, store }) // Deduplicate execution
    .cache({ keyBuilder, ttlMs, store }); // Cache successful responses
```

### 2.1 Input Contracts: `step.spec(field, options)` & `step.strict()`

| Method / Option  | Type                                       | Description                                                              |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| `require`        | `boolean \| (() => boolean)`               | Enforces field presence; throws `ValidationException` if missing.        |
| `requireMessage` | `string`                                   | Custom error message when `require` validation fails.                    |
| `default`        | `any`                                      | Default fallback value if field is `undefined`.                          |
| `validate`       | `(val: any) => Promise<void>`              | Async validator; throws or rejects to fail validation.                   |
| `transform`      | `(val: any) => Promise<any>`               | Async transformer; returns sanitized or coerced value in-place.          |
| `translate`      | `(val: any, ctx: any) => Promise<void>`    | Async translator; projects or remaps into context via `ctx.set(key, v)`. |
| `schema`         | `StandardSchema \| ZodSchema \| Predicate` | Per-field Standard Schema validation or predicate function.              |
| `step.strict()`  | `() => Step`                               | Filters out all undeclared properties from incoming parameter context.   |
| `step.schema(s)` | `(schema: any) => Step`                    | Validates entire incoming context against Standard Schema / Zod.         |

---

## 3. Flow Execution Options (`flow.run(input, options)`)\n

```typescript
interface ExecutionOptions {
    pojo?: boolean; // Strip proxy getters and symbols into clean POJO
    timeout?: number; // Total workflow timeout in milliseconds
    namespace?: string; // Domain tag for telemetry and isolation
    services?: Record<string, any>; // Dependency injection container accessible in steps
    durable?: boolean; // Enable durable persistence and suspension
    storage?: StorageAdapter; // Custom persistence adapter (Postgres, Redis, Memory)
    idempotencyStore?: IdempotencyStore; // Custom idempotency store
    signal?: AbortSignal; // Standard AbortSignal for cancellation
}
```

---

## 4. Reserved Context Keys

| Key                   | Description                                                                            |
| --------------------- | -------------------------------------------------------------------------------------- |
| `$steps` / `$history` | Record and callable function (`$steps('stepName')`) of each prior step's exact output. |
| `$stackId`            | Unique execution run ID.                                                               |
| `$attempt`            | Current step attempt number (1 on initial run, 2+ on retry).                           |
| `$isDurable`          | Boolean flag indicating whether durable mode is active.                                |

---

## 5. Core Error Classes

All inherit from `SigloError` (which extends `Error`):

- `SigloError`: Base error class with `.metadata` (`stepName`, `phase`, `retryable`).
- `ValidationException`: Thrown when `.schema()` or `.spec()` rejects input (non-retryable).
- `StepTimeoutException`: Thrown when a step exceeds `.timeout(ms)`.
- `FlowTimeoutException`: Thrown when workflow exceeds `options.timeout`.
- `CancellationException`: Thrown when `AbortSignal` cancels execution.
- `CompensationException`: Base error for compensation failures.
- `UnresolvableCompensationException`: Thrown when compensation handler throws and cannot be reconciled.
- `IdempotencyConflictException`: Concurrent in-flight claim detected.
- `CheckpointConflictException`: Optimistic Concurrency Control (OCC) version mismatch.
- `WorkflowSuspendedException`: Normal suspension signal when encountering `waitForEvent` or `wait`.
- `ExpiredWaitException`: Event wait timed out before external resume payload arrived.
