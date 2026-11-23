# Siglo Roadmap: Synchronous Compute Steps (`Step.compute`)

> Architectural plan for introducing **`Step.compute`** — a lightweight, synchronous, zero-lifecycle step primitive purpose-built for non-I/O CPU logic (math, scoring, algorithms, pure transformations) with **always-deny network guardrails**, **sync-only `.spec()` input contracts**, **synchronous in-memory `.cache()` memoization**, **zero-macrotask execution**, **OpenTelemetry traceability**, and **first-class workflow & IDE graph visibility**.

---

## 1. Motivation & Design Principles

In Siglo today, every regular `Step.create(...)` executes through `StartChain`, which schedules a `setTimeout(..., 0)` macrotask, allocates a reactive `Context` proxy, runs lifecycle hooks (`onBefore`, `onSkip`, `onAfter`, `onFail`), evaluates plugin hooks, checks distributed idempotency/cache adapters, sets up `AbortController`/signal listeners, and handles compensation registration.

That machinery is essential for I/O-bound steps (HTTP, DB, queues, AI inference), but imposes avoidable timer and allocation overhead on pure in-memory logic such as pricing math, risk scoring, ranking algorithms, or payload shaping.

`Step.compute` fills this gap with six strict design invariants:

1. **Synchronous by Construction**: Both the action function and `.spec()` rules are strictly synchronous—enforced at compile time via TypeScript types and fail-fast at runtime if a thenable (`PromiseLike`) is returned.
2. **No Lifecycle or I/O Hooks**: Omits `.onBefore()`, `.onSkip()`, `.onAfter()`, `.onFail()`, `.compensate()`, `.timeout()`, `.idempotent()`, `.allowNetwork()`, `.allowUnixSockets()`, `.networkPolicy()`, and `.withDependencies()` at the type level.
3. **Always-Deny Network Perimeter**: Unconditionally enforces `{ enabled: true, defaultPolicy: 'deny', allowedHosts: [], allowLocalhost: false }` across both `.spec()` evaluation and action execution—even when the enclosing `flow` has no `networkPolicy` configured.
4. **Synchronous In-Memory Memoization (`.cache()`)**: Supports bounded LRU + TTL in-memory caching (`DurationInput` or `ComputeCacheOptions`) keyed on post-`.spec()` normalized inputs—never invoking external async `StorageAdapter` I/O so caching stays 100% synchronous and zero-network.
5. **`.run()` Entry Point Only**: Exposes `.run(param?, options?) => Promise<TOutput>` for uniform `FlowItem` parity with `Step` and `Flow` (no `.runSync()` surface duplication), while executing synchronously on the runtime fast path inside `flow()`, `parallel()`, `when()`, `branch()`, and `map()`.
6. **Full Observability & Graph Visibility**: Produces first-class OpenTelemetry child spans (with zero microtask overhead, `siglo.step.kind = 'compute'`, and `siglo.cache.hit`), emits live monitoring events (`step:start`, `step:complete`, `step:error`), appears in `toGraph()` / `toMermaid()` / `toDot()` / `toJSON()`, and renders in VS Code and IntelliJ plugins.

---

## 2. Public API & Type Contracts (`@siglo/core`)

No standalone `computeStep` alias is introduced; `Step.compute` is the single canonical factory on `Step`:

```ts
const calculateTotals = Step.compute(
    'calculateTotals',
    (ctx: { subtotal: number; discount: number; taxRate: number }) => {
        const taxable = Math.max(0, ctx.subtotal - ctx.discount);
        const tax = Math.round(taxable * ctx.taxRate * 100) / 100;
        return { tax, total: taxable + tax };
    },
)
    .spec('subtotal', { require: true, validate: v => typeof v === 'number' && v >= 0 })
    .spec('discount', { default: 0, transform: v => Math.max(0, Number(v)) })
    .spec('taxRate', { default: 0.08 })
    .cache({ ttl: '5m', maxEntries: 500 });

export const checkoutFlow = flow(
    fetchCart,       // Async I/O Step
    calculateTotals, // Synchronous ComputeStep (fast path, always-deny network, in-memory LRU cache)
    chargeCard,      // Async I/O Step
);
```

### 2.1 Core Types (`packages/core/src/features/step/compute.ts`)

```ts
export type SyncValue<T> = T extends PromiseLike<any> ? never : T;

export type SyncStepAction<TInput = any, TOutput = any> = (
    parameter: TInput,
) => SyncValue<TOutput>;

export interface SyncSpecData {
    defaultValue?: any;
    default?: any;
    require?: boolean | (() => boolean);
    requireMessage?: string;
    validator?: (currentValue?: any) => SyncValue<any>;
    validate?: (currentValue?: any) => SyncValue<any>;
    transformer?: (currentValue?: any) => SyncValue<any>;
    transform?: (currentValue?: any) => SyncValue<any>;
    translator?: (currentValue?: any, context?: Record<string, any>) => SyncValue<void>;
    translate?: (currentValue?: any, context?: Record<string, any>) => SyncValue<void>;
    schema?: any; // Standard Schema, Zod/Valibot safeParse/parse, or sync predicate
}

export interface ComputeCacheOptions {
    /** Cache entry TTL (number in ms or DurationInput string like '5m'). Default: 1500ms. */
    ttl?: DurationInput;
    /** Maximum number of entries retained in the step-local LRU cache. Default: 1000. */
    maxEntries?: number;
    /** Synchronous custom cache key serializer (receives post-.spec() normalized input). */
    keySerializer?: (stepId: string, param: any, namespace?: string) => SyncValue<string>;
}
```

### 2.2 `ComputeStep` Class Surface

```ts
export class ComputeStep<TInput = any, TOutput = any, TName extends string = string> {
    readonly isCompute = true as const;
    readonly name: TName;
    readonly func: string;
    readonly $stepId: string;
    readonly action: SyncStepAction<TInput, TOutput>;
    readonly specs: SyncSpec[];
    readonly networkPolicyConfig: Readonly<NetworkPolicyConfig>; // Always-deny constant
    cachedLast?: number;
    cacheOptions?: ComputeCacheOptions;

    spec(fieldOrSchema: string | any, json?: SyncSpecData | any): ComputeStep<TInput, TOutput, TName>;
    cache(ttlOrOptions?: DurationInput | ComputeCacheOptions): ComputeStep<TInput, TOutput, TName>;
    run(param?: TInput, options?: ExecutionOptions): Promise<TOutput>;
}
```

### 2.3 Factory Overloads on `Step` (`packages/core/src/features/step/index.ts`)

```ts
static compute<TName extends string, TIn = any, TOut = any>(
    name: TName,
    action: SyncStepAction<TIn, TOut>,
): ComputeStep<TIn, TOut, TName>;
static compute<TIn = any, TOut = any>(
    action: SyncStepAction<TIn, TOut>,
): ComputeStep<TIn, TOut, string>;
```

### 2.4 `FlowItem` & Type Inference Integration

- Extend `FlowItem<TIn, TOut>` in `packages/core/src/features/step/index.ts` to include `ComputeStep<TIn, TOut, any>` so `flow()`, `parallel()`, `all()`, `allSettled()`, `race()`, `when()`, `branch()`, and `map()` preserve full accumulated context inference across mixed `Step` and `ComputeStep` chains.
- Update `isFlow()` to return `false` for `ComputeStep` instances (`item instanceof ComputeStep || item.isCompute === true`).

---

## 3. Synchronous `.spec()` Execution Engine & In-Memory `.cache()`

### 3.1 Sync `.spec()` Evaluator (`packages/core/src/features/spec/sync.ts`)

Existing `Spec` helpers (`Defaults`, `Validators`, `Transformer`, `Translator`, `Spec.runSchema`) unconditionally wrap work in `new Promise(...)` or `async` functions and expect a reactive `Context` proxy.

For `ComputeStep`, introduce a zero-Promise synchronous spec evaluator:

1. **Plain Object Evaluation**: Operates directly on a shallow-cloned plain input object (`Record<string, any>`) without allocating a `Context` proxy.
2. **Action Order Parity**: Preserves the exact evaluation order of `Step.spec()` (`default` -> `require` -> `validate` -> `transform` -> `translate` -> `schema`).
3. **Sync Schema Support**:
   - Standard Schema (`schema['~standard'].validate(val)`): inspects return value; if it is a thenable (`isThenable(res)`), immediately throws a non-retryable `ValidationException` explaining that async schemas are forbidden in `Step.compute`.
   - `safeParse` / `parse` / `validate` / function predicate: invokes synchronously and rejects any thenable return with a clear error.
4. **Consistent Error Semantics**:
   - Throws `ValidationException` tagged with `ExecutionPhase.VALIDATION` and step name so error handling, monitoring, OTel spans, and upstream Saga rollbacks behave identically to regular `Step` validation failures.

### 3.2 Synchronous In-Memory `.cache()` Memoization (`packages/core/src/features/cache/compute.ts`)

Unlike `Step.cache()`, which falls back to async distributed `StorageAdapter` calls (`getCachedStep` / `setCachedStep`) and keys its in-memory store per `stackId`, `ComputeStep.cache()` is designed specifically for deterministic CPU memoization:

1. **Strictly In-Memory (Zero Network / Zero Async)**:
   - Never invokes external `StorageAdapter` methods (Redis/Postgres), avoiding both async Promise overhead and `NetworkPolicyViolationException` conflicts with `Step.compute`'s always-deny network perimeter.
   - Omits async-only options (`swr` / `staleWhileRevalidate` background revalidation and `stampedeProtection` in-flight Promise deduplication).
2. **Cross-Run Bounded LRU + TTL (Partitioned by `namespace`)**:
   - Uses a step-local in-memory `Map<string, { value: any; expiresAt: number }>` keyed by `(namespace, serializedInput)` so repeated `flow.run()` invocations and `map()` batch iterations share cache hits across distinct `stackId`s.
   - Refreshes LRU recency on hit (`delete` + `set`) and evicts the oldest entry whenever size exceeds `maxEntries` (default: `1000`), preventing unbounded memory growth on long-running servers.
   - Registers with a lightweight reset hook invoked by `clearStorage()` so unit tests stay isolated.
3. **Post-`.spec()` Keying & Reserved-Key Stripping**:
   - Computes the cache key **after** `.spec()` applies defaults, transforms, and translations (and after stripping reserved internal keys like `$stackId`, `$signal`, `$steps`, `$history`), ensuring `{ subtotal: 100 }` and `{ subtotal: 100, discount: 0 }` share the same cache entry.
   - Rejects any custom `keySerializer` that returns a thenable at runtime.
4. **Observability Events**:
   - Emits standard `defaultStorageManager.emitCacheEvent({ type: 'hit' | 'miss', key, stepId, stackId, namespace, timestamp })` and exposes `cacheHit` status to the active `StepExecutionContext` so OpenTelemetry sets `siglo.cache.hit`.

---

## 4. Runtime Fast Path & Always-Deny Network Guardrails

### 4.1 Synchronous Execution Helper (`executeComputeStepSync`)

Create a dedicated fast-path executor (invoked by `StartChain`, `ArrayChain`, and `ComputeStep.run`):

1. **Cooperative Cancellation Check**: Immediately check `options?.signal?.aborted`; if aborted, throw `options.signal.reason || new CancellationException(...)`.
2. **Always-Deny Network Perimeter**:
   - Call `ensureNetworkInterceptorsInstalled()`.
   - Run `.spec()` evaluation, cache key serialization, and `action(input)` inside:
     ```ts
     networkPolicyStorage.run(
         {
             enabled: true,
             defaultPolicy: 'deny',
             allowedHosts: [],
             allowLocalhost: false,
             stepName,
             throwSync: true,
         },
         () => { ... },
     );
     ```
   - Guarantees zero outbound network egress (`fetch`, `node:http`, `node:https`, `node:net`, `node:tls`, localhost, Unix sockets) regardless of enclosing flow policy, throwing `NetworkPolicyViolationException` synchronously via `throwSync: true` rather than deferring errors to a rejected `Promise` or `process.nextTick`.
3. **Monitoring Events**:
   - Emit `step:start` before execution, `step:complete` (with `durationMs`) on success, and `step:error` on throw via `emitMonitoringEvent(options, ...)` (zero-cost no-op when no monitor is attached).
4. **Sync Spec Validation**:
   - If `step.specs.length > 0`, run `runSpecsSync(step.specs, input, stepName)`.
5. **In-Memory Cache Lookup, Action Execution & OpenTelemetry Hook**:
   - Check `activeHook = options?.stepExecutionHook || stepExecutionHookStorage.getStore()`.
   - Inside the hook wrapper (so cache hits and misses are both visible in OTel traces with `siglo.cache.hit`):
     - If `step.cachedLast` is configured, check the step-local LRU/TTL cache first; on hit, record `stepContext.cacheHit = true`, emit cache `'hit'`, and return immediately.
     - On miss (or uncached), run `step.action(cleanInput)`.
     - **Thenable Guard**: If `step.action(...)` returns a thenable (`result && typeof result.then === 'function'`), immediately throw a non-retryable `SigloError` (`"Step.compute '<name>' must be synchronous and cannot return a Promise. Use Step.create for async or I/O operations."`).
     - If caching is enabled, store the result in the bounded LRU/TTL cache, record `stepContext.cacheHit = false`, and emit cache `'miss'`.
6. **Error Phase Tagging & Saga Interop**:
   - Errors thrown during `.spec()` are tagged `ExecutionPhase.VALIDATION`.
   - Errors thrown during `action()` are tagged `ExecutionPhase.ACTION` (unless already a `NetworkPolicyViolationException`).
   - Throwing bubbles out of `ArrayChain` / `Runner`, triggering automatic LIFO compensations for any upstream I/O steps in the same `flow()`.

### 4.2 Consecutive Sync Batching in `ArrayChain` (`packages/core/src/features/executer/array-chain.ts`)

- In `executeArrayChain`, check whether the next item is a `ComputeStep` (`chain?.isCompute === true`).
- Execute consecutive `ComputeStep`s in a **tight synchronous `while` loop**—updating `accumulatedParam`, `updatedSteps` (`$steps` / `$history`), and calling `options?.onStepComplete?.()` synchronously—without invoking `setTimeout` or allocating intermediate `Promise` / `.then()` frames.
- If a custom `stepExecutionHook` happens to return a `Promise` for a compute step (e.g., third-party async hook), gracefully await it via `.then()` and resume the loop; if it returns synchronously (like upgraded `@siglo/opentelemetry`), stay 100% synchronous.

### 4.3 Single-Step Path in `StartChain` & `ComputeStep.run()`

- If `StartChain.start` receives a `ComputeStep` directly (e.g., inside `parallel`, `branch`, `when`, `map`, or `Step.start(computeStep)`), short-circuit **before** `setTimeout` and execute via `executeComputeStepSync`, resolving/rejecting immediately.
- `ComputeStep.run(param, options)` delegates through the runner/fast-path and returns a `Promise<TOutput>` for full `FlowItem` parity (including `pojo`, `monitor`, `signal`, and `stepExecutionHook` options).

---

## 5. OpenTelemetry Zero-Microtask Instrumentation (`@siglo/opentelemetry`)

### 5.1 Semantic Attributes (`packages/opentelemetry/src/attributes.ts`)

- Add `STEP_KIND: 'siglo.step.kind'` (`'compute' | 'standard'`) to `SemanticAttributes` so distributed traces and APM dashboards clearly distinguish synchronous compute spans from I/O spans.
- Reuse existing `SemanticAttributes.CACHE_HIT` (`'siglo.cache.hit'`) on compute spans whenever `.cache()` is configured (`true` on hit, `false` on miss).

### 5.2 Dual Sync/Async `stepExecutionHook` (`packages/opentelemetry/src/instrument.ts`)

Currently, `instrumentWorkflow`'s `stepExecutionHook` is an `async` function (`otelContext.with(ctx, async () => { const result = await next(); ... })`), which forces a Promise allocation and microtask hop on every step.

Refactor `stepExecutionHook` (and `instrumentStep`) to preserve synchronous execution when `next()` returns a non-Promise:

```ts
return otelContext.with(ctx, () => {
    try {
        const result = next();
        if (result && typeof result.then === 'function') {
            return result.then(
                (val: any) => {
                    if (typeof stepContext.cacheHit === 'boolean') {
                        stepSpan.setAttribute(SemanticAttributes.CACHE_HIT, stepContext.cacheHit);
                    }
                    stepSpan.setStatus({ code: SpanStatusCode.OK });
                    stepSpan.end();
                    return val;
                },
                (err: any) => {
                    stepSpan.recordException(err);
                    stepSpan.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || 'Step execution failed' });
                    stepSpan.end();
                    throw err;
                },
            );
        }
        if (typeof stepContext.cacheHit === 'boolean') {
            stepSpan.setAttribute(SemanticAttributes.CACHE_HIT, stepContext.cacheHit);
        }
        stepSpan.setStatus({ code: SpanStatusCode.OK });
        stepSpan.end();
        return result;
    } catch (err: any) {
        stepSpan.recordException(err);
        stepSpan.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || 'Step execution failed' });
        stepSpan.end();
        throw err;
    }
});
```

- When `Step.compute` runs inside `instrumentWorkflow(flow)`, OTel starts the child span, binds `otelContext`, executes the sync function (or hits in-memory LRU cache), sets `siglo.step.kind = 'compute'` and `siglo.cache.hit`, ends the span, and returns the value—**all synchronously with zero Promise/microtask overhead**.
- Nested spans created *inside* a compute step (if user code manually calls `tracer.startActiveSpan(...)`) still parent correctly under the active compute step span.
- Exceptions thrown by `.spec()` or `action()` are recorded via `stepSpan.recordException(err)` and marked `SpanStatusCode.ERROR`.

---

## 6. Graph Visualization, Testing & IDE Analysis

### 6.1 Core Graph & Exporters (`packages/core/src/features/graph/`)

- **`toGraph.ts`**: Recognize `item.isCompute === true` and emit a `StepNode` with:
  ```ts
  metadata: {
      compute: true,
      cachedLast: item.cachedLast,
      cacheOptions: item.cacheOptions,
      networkPolicy: item.networkPolicyConfig, // always-deny
  }
  ```
- **`export.ts` (`toMermaid`, `toDot`, `toJSON`)**: Optionally annotate compute nodes cleanly (while preserving backwards-compatible graph structure) so compute vs. I/O boundaries are immediately legible in exported diagrams.

### 6.2 Testing Harness Compatibility (`packages/testing/src/index.ts`)

- **Critical Detail**: `WorkflowHarness.wrapWorkflowSteps()` currently replaces every step's `action` with an `async (param) => ...` wrapper.
- Update `WorkflowHarness` so that when `origStep.isCompute === true`, it wraps the step with a **synchronous** spy/mock function (preserving `isCompute: true`, `specs`, `cachedLast`, `cacheOptions`, and sync validation/thenable checks) so `mockStep`, `spyStep`, `assertStepExecuted`, `assertStepFailed`, and execution trace recording work seamlessly on `Step.compute` without tripping the runtime sync guard.

### 6.3 IDE Protocol, Analysis & Plugins (`@siglo/ide-protocol`, `@siglo/ide-analysis`, `@siglo/ide-ui`, `@siglo/vscode`, `plugins/intellij`)

- **`@siglo/ide-protocol`** (`packages/ide-protocol/src/types.ts`):
  - Extend `GraphNode['stepKind']` union with `'compute'` (and verify IntelliJ Kotlin protocol models in `plugins/intellij` deserialize `'compute'` cleanly).
- **`@siglo/ide-analysis`** (`packages/ide-analysis/src/patterns/step-detector.ts`):
  - Detect `Step.compute(name, fn)` along with chained `.spec(...)` and `.cache(...)` calls in `detectStepFromExpression`.
  - Set `stepKind: 'compute'`, `properties.operation = 'Step.compute'`, and `properties.networkPolicy = 'deny'`.
  - Because `stepKind === 'compute'` is not in the side-effect set (`http`, `crypto`, `notification`), `workflow-detector.ts` automatically exempts `Step.compute` from `SIGLO_MISSING_COMPENSATION` static diagnostics.
- **`@siglo/ide-ui` & IDE Plugins**:
  - Render `compute` nodes with a distinct icon/badge (e.g., `Cpu` / `Zap` icon and `"Compute · Sync"` / `"No Network"` indicator) in the workflow graph viewer.
  - Ensure `ide-runner` can execute single or ranged `Step.compute` selections cleanly.

---

## 7. Phased Implementation Plan

### Phase 1: Core `ComputeStep`, Sync `.spec()`, In-Memory `.cache()`, Fast Path & Always-Deny Guardrails (`@siglo/core`)

- [x] Implement `packages/core/src/features/spec/sync.ts` (`SyncSpec`, `SyncSpecData`, `runSpecsSync`) with compile-time and runtime sync enforcement (rejecting thenables in `validate`, `transform`, `translate`, and `schema`).
- [x] Implement `packages/core/src/features/cache/compute.ts` (`ComputeCache`, `ComputeCacheOptions`, `clearComputeCaches`) with bounded LRU eviction (`maxEntries`), `DurationInput` TTL, `namespace` partitioning, `clearStorage()` integration, and zero external `StorageAdapter` I/O.
- [x] Implement `packages/core/src/features/step/compute.ts` (`ComputeStep`, `SyncStepAction`, `SyncValue`, always-deny `COMPUTE_NETWORK_POLICY`, `executeComputeStepSync`).
- [x] Add `Step.compute(...)` overloads, update `FlowItem`, `isFlow()`, `StepExecutionContext` (`cacheHit?: boolean`), and exports in `packages/core/src/features/step/index.ts`, `packages/core/src/features/executer/hooks.ts`, and `packages/core/src/index.ts`.
- [x] Add synchronous fast-path execution in `packages/core/src/features/executer/array-chain.ts` (tight `while` loop for consecutive compute steps) and `packages/core/src/features/executer/SingleChain/StartChain.ts` (bypass `setTimeout` and lifecycle overhead).
- [x] Update `packages/core/src/features/graph/toGraph.ts` (and `packages/core/src/features/graph/export.ts`) to populate `metadata.compute = true`, `cachedLast`, `cacheOptions`, always-deny `networkPolicy`, and `⚡ compute` export badges.
- [x] Add comprehensive unit, integration, and performance/microtask tests (`compute.test.ts`, `network.integration.test.ts`, `graph.test.ts`):
  - Sync execution, context accumulation, `$steps`/`$history`, mixed `Step.create` + `Step.compute` flows, combinators (`parallel`, `branch`, `when`, `map`).
  - Sync `.spec()` rules (`default`, `require`, `validate`, `transform`, `translate`, sync Standard Schema/Zod, rejection of async callbacks/schemas).
  - In-memory `.cache()` memoization: cross-run hits, `map()` batch hits, `namespace` isolation, TTL expiration, LRU `maxEntries` eviction, post-`.spec()` normalized key sharing, `clearStorage()` reset, and zero interaction with external `StorageAdapter` (even when Redis/Postgres adapter is registered).
  - Runtime thenable rejection when JS/untyped code returns a `Promise` (from `action` or custom `keySerializer`).
  - Always-deny network enforcement (`fetch`, `http`, `net`) even when parent flow has no `networkPolicy` or explicitly allows the host.
  - Error propagation triggering upstream Saga compensations and cooperative `AbortSignal` cancellation.
  - Maintain **100% `c8` line & statement coverage** across `@siglo/core`.

### Phase 2: OpenTelemetry Zero-Microtask Tracing & Testing Harness (`@siglo/opentelemetry`, `@siglo/testing`)

- [x] Add `SemanticAttributes.STEP_KIND` (`'siglo.step.kind'`) in `packages/opentelemetry/src/attributes.ts`.
- [x] Refactor `stepExecutionHook` and `instrumentStep` in `packages/opentelemetry/src/instrument.ts` to execute synchronously when `next()` returns a non-Promise, tagging compute spans with `siglo.step.kind = 'compute'` and `siglo.cache.hit`.
- [x] Add OTel tests verifying child span creation, `siglo.step.kind` and `siglo.cache.hit` attributes (hit & miss), sync span closure (no extra microtask), exception recording on `.spec()` and `action()` failures, and parent-child context propagation.
- [x] Update `WorkflowHarness.wrapWorkflowSteps()` in `packages/testing/src/index.ts` to preserve synchronous wrapping for `ComputeStep` (`spyStep`, `mockStep`, `assertStepExecuted`, `assertStepFailed`, trace recording) and add tests.

### Phase 3: IDE Protocol, Static Analysis, UI & Documentation

- [x] Extend `GraphNode['stepKind']` with `'compute'` in `packages/ide-protocol/src/types.ts` (and verify IntelliJ Kotlin protocol models in `plugins/intellij` deserialize `'compute'` cleanly).
- [x] Update `packages/ide-analysis/src/patterns/step-detector.ts` to detect `Step.compute(...)` and chained `.spec(...)` / `.cache(...)` rules with zero-execution parser tests and diagnostic tests confirming exemption from `SIGLO_MISSING_COMPENSATION`.
- [x] Update `packages/ide-ui` node rendering for `stepKind: 'compute'` and verify `test:ide` + `test:ide-runner` + IntelliJ `./gradlew test`.
- [x] Update documentation (`docs/api/step.md`, `docs/api/orchestration-and-combinators.md`, `docs/network-egress-policy.md`, `docs/adapters/opentelemetry.md`) and AI agent skills (`siglo-workflow-development`, `siglo-security-and-guardrails`, `siglo-runtime-and-resilience`).

---

## 8. Verification Checklist

- [x] `npm test` — builds `@siglo/core` and enforces **100% line & statement `c8` coverage**.
- [x] `npm run test:packages` — verifies `@siglo/opentelemetry`, `@siglo/testing`, and all ecosystem packages pass.
- [x] `npm run test:ide && npm run test:ide-runner` — verifies protocol, AST analysis, VS Code extension, and execution runner.
- [x] `./gradlew test` (in `plugins/intellij`) — verifies IntelliJ plugin protocol models, diagnostics, and bundled assets.
- [x] `npm run lint` — verifies zero ESLint errors or warnings across the monorepo.
