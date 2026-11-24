# @siglo/core API Cheatsheet

Quick reference for core classes, functions, options, and error hierarchies in `@siglo/core`.

---

## 1. Primary Flow & Step Functions

| Export                                          | Signature                                                                                          | Description                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `Step.create(name, fn)`                         | `Step.create<TIn, TOut>(name: string, action: (ctx: TIn) => Promise<TOut> \| TOut): Step`          | Creates a typed asynchronous I/O step with full lifecycle hooks.     |
| `Step.compute(name, fn)`                        | `Step.compute<TIn, TOut>(name: string, action: (ctx: TIn) => SyncValue<TOut>): ComputeStep`        | Creates a synchronous pure compute step with always-deny egress.     |
| `flow(...items)`                                | `flow<TIn, TOut>(...items: FlowItem[]): Flow<TIn, TOut>`                                           | Chains steps and combinators into an executable sequential pipeline. |
| `clearComputeCaches()`                          | `clearComputeCaches(): void`                                                                       | Clears all active in-memory `Step.compute` LRU+TTL caches.           |
| `parallel(branches, options?)`                  | `parallel(branches: FlowItem[], options?: ParallelOptions): Step`                                  | Concurrent fan-out with configurable merge strategy.                 |
| `race(branches)`                                | `race(branches: FlowItem[]): Step`                                                                 | Competitive concurrency; fastest branch wins.                        |
| `when(predicate, thenStep, elseStep?)`          | `when(predicate: (ctx) => boolean, thenStep, elseStep?): Step`                                     | Conditional binary branch.                                           |
| `branch(selector, branchesMap, default?)`       | `branch(selector: (ctx) => string, branches: Record<string, FlowItem>, default?: FlowItem): Step`  | Multi-way dictionary routing.                                        |
| `map(accessor, stepOrFlow, options?)`           | `map(accessor: (ctx) => any[], stepOrFlow: FlowItem, options?: MapOptions): Step`                  | Bounded concurrent iteration (`concurrency: number`).                |
| `waitForEvent(eventName, options)`              | `waitForEvent(eventName: string, options: WaitForEventOptions): Step`                              | Suspends execution until external event or webhook arrives.          |
| `wait(duration)`                                | `wait(duration: DynamicDuration): Step`                                                            | Durable timer sleep (`'24h'`, `'30m'`, `5000`, or `ctx => ...`).     |
| `resumeWorkflow(flow, correlationKey, payload)` | `resumeWorkflow(flow: Flow, key: string, payload?: any, options?: ExecutionOptions): Promise<any>` | Resumes a suspended workflow run.                                    |

---

## 2. Step Builder Methods

All methods below are chainable on `Step.create()` (`ComputeStep` from `Step.compute()` intentionally exposes only synchronous `.spec()`, `.cache(ttlOrOptions)`, and `.run()`):

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
        delay: '100ms', // DurationInput: number | string
        backoff: 'exponential', // 'fixed' | 'linear' | 'exponential'
        maxDelay: '5s', // DurationInput: number | string
        jitter: true,
        retryIf: err => err.isTransient, // Synchronous (err, attempt) => boolean
    })
    .compensate(async (output, ctx) => {}, { maxRetries: 2, delay: '250ms' }) // LIFO Saga rollback handler
    .timeout('5s') // Step timeout (DurationInput: number | string)
    .idempotent({ key: ctx => ctx.id, ttl: '1h', store }) // Deduplicate execution
    .cache({ ttl: '5m', swr: '1m', keySerializer }); // Cache successful responses
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

## 3. Flow Execution Options (`flow.run(input, options)`)

```typescript
interface ExecutionOptions<TContext = any> {
    pojo?: boolean; // Strip proxy getters and symbols into clean POJO
    timeout?: DurationInput; // Total workflow timeout (number | string, e.g. '10s')
    timeoutMs?: DurationInput; // Alias for timeout
    namespace?: string; // Domain tag for telemetry and isolation
    services?: Record<string, any>; // Dependency injection container accessible in steps
    durable?: boolean; // Enable durable persistence and suspension
    storage?: StorageAdapter; // Custom persistence adapter (Postgres, Redis, Memory)
    idempotencyKey?: DynamicOption<string, TContext>; // String or sync (ctx) => string key
    idempotencyStore?: IdempotencyStore; // Custom idempotency store
    idempotencyTtlMs?: DurationInput; // Retention TTL (number | string, e.g. '24h')
    networkPolicy?: NetworkPolicyConfig; // Enclosing ASL network egress perimeter
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
