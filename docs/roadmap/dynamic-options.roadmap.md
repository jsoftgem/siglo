# Siglo Roadmap (Revised): Synchronous Dynamic Options & Duration Inputs

> Architectural plan for standardizing **synchronous context-based option resolvers** (`T | ((ctx: TContext) => T)`) so steps can read values produced by previous steps in `ctx`, alongside lightweight static **`DurationInput`** (`number | string`) ergonomics for timeouts, TTLs, and delays.

---

## 1. Design Principles: Why Sync `DynamicOption` (Not Async)

In Siglo, **`DynamicOption` exists to read values from the accumulated `ctx` of preceding steps** (e.g., `ctx => ctx.tenantApiKey`, `ctx => ctx.approvalSla`, `ctx => ctx.presignedUrl`). Arbitrary async I/O (DB lookups, Vault/Secrets Manager calls, feature-flag fetches, RAG prompt assembly) belongs in explicit upstream `Step`s, which already get first-class DAG visibility (`toGraph`, `toMermaid`), retries, timeouts, caching, network policies, and telemetry.

Keeping `DynamicOption` strictly synchronous avoids:

- Silent cache-key collisions in synchronous serializers such as `AiStep.cache()`'s `CacheOptions.keySerializer` and `resolveModel()` (`JSON.stringify(Promise)` evaluating to `{}`).
- Duplicate external I/O invocations across `schema` / `onBefore` / `action` lifecycle hooks (and the need for per-attempt memoization wrappers).
- Unnecessary microtask overhead and `AsyncLocalStorage` (`networkPolicyStorage`) plumbing around option resolvers in `Runner.start`, `OnFail`, and `WaitNode`.

Each option falls into one of three tiers:

| Tier                                                | Type                                                     | When to Use                                                                                                                         | Examples                                                                                                                                                                                                                                                                                                                                                                                                       |
| :-------------------------------------------------- | :------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tier 1: Sync `DynamicOption`**                    | `T \| ((ctx: TContext) => T)`                            | Options that may come from a literal value or be read from a prior step's `ctx`.                                                    | `WaitForEventOptions.timeout` / `correlationKey`, `wait(durationOrMs)`, `ExecutionOptions.idempotencyKey`, `IdempotencyOptions.key`, `SendNotificationOptions.*`, `InteractiveApprovalOptions.*`, `HttpStepOptions.url` / `headers` / `query` / `body`, `WebhookVerifyOptions.secret` / `provider`, `FieldCipherOptions.aad` / `deriveKeyContext`, `AiModelConfig.apiKey`, `AiStepOptions.prompt`              |
| **Tier 2: Static `DurationInput`**                  | `number \| string` (e.g. `5000 \| '5s'`)                 | Human-readable durations for configuration timeouts, TTLs, and backoff delays that do not need `ctx` callbacks.                     | `Step.timeout()`, `Flow.timeout()`, `ExecutionOptions.timeout` / `timeoutMs` / `idempotencyTtlMs`, `IdempotencyOptions.ttl` / `ttlMs`, `CacheOptions.ttl` / `swr`, `Step.cache()`, `RetryConfig.delay` / `maxDelay`, `CompensationOptions.delay`, `SendNotificationOptions.deduplicationTtl`, `HttpStepOptions.timeoutMs` / `timeout`, `AiModelConfig.requestTimeoutMs`                                        |
| **Tier 3: Static / Existing Specialized Callbacks** | Static value or specialized sync/existing async callback | Worker/concurrency config, existing sync predicates/extractors, or APIs that already support `Promise` for backwards compatibility. | `MapOptions.concurrency` (`number`), `WebhookVerifyOptions.payload` / `signature` / `headers` (`(ctx) => ...`), `AiTool.mapInput` (`(args, ctx) => TInput`), `RetryConfig.retryIf` / `CompensationOptions.retryIf` (sync `(err, attempt) => boolean`). **Existing `Promise`-capable APIs preserved as-is:** `FieldCipherOptions.secretKey`, `BranchPredicate`, `BranchSelector`, `MapItemAccessor`, `KeyRing`. |

---

## 2. Shared Foundation (`@siglo/core`)

Add reusable types and helpers in `packages/core/src/shared/DynamicOption.ts` (re-exported via `packages/core/src/shared/index.ts` and `packages/core/src/index.ts`):

```ts
import { isFunction } from './TypeGuards';

export type DynamicOption<T, TContext = any> = T | ((ctx: TContext) => T);

export type DurationInput = number | string;
export type DynamicDuration<TContext = any> = DynamicOption<DurationInput, TContext>;

export function resolveDynamic<T, TContext = any>(value: DynamicOption<T, TContext>, ctx: TContext): T {
    return isFunction(value) ? value(ctx) : value;
}
```

### Duration Parsing Hardening (`parseDuration`)

- Accept `number | string | null | undefined`; return `undefined` for `undefined` and `null` (avoiding `String(null)` coercion).
- Parse strings (`'500ms'`, `'30s'`, `'5m'`, `'2h'`, `'1d'`, numeric strings) accurately while preserving raw `number` values as milliseconds.
- Consolidate `parseDuration` alongside `DynamicOption.ts` (re-exported from `features/durable/wait.ts` and `packages/core/src/index.ts` for backwards compatibility).

---

## 3. Architectural Guardrails (Definition Time, Graph Validation, and ASL)

1. **Definition-Time Metadata vs. Execution-Time Resolution**:
    - Static values (`'30m'`, `'https://api.example.com'`) continue populating `WaitNode` (`timeoutMs` / `durationMs`), `HttpStep` static `allowNetwork` hosts, and synchronous validation (`sendInteractiveApprovalStep` rejecting invalid static `timeout` at definition time).
    - Function resolvers (`isFunction(opt)`) evaluate synchronously at execution time against `ctx` (e.g., `waitForEvent` / `wait` resolving `DynamicDuration` inside the step action; `WaitNode` & `validateGraph` allowing dynamic `wait`/`waitForEvent` nodes without requiring static `durationMs` at definition time).
2. **Network Egress Policy ASL Hardening (`networkPolicyStorage`)**:
    - Even without async `DynamicOption`, keep the enclosing-policy safeguards so nested flows and compensations respect outer perimeters:
        - `StartChain.ts` merges enclosing `networkPolicyStorage.getStore()` with step/sub-flow policies so nested `parallel`, `branch`, `map`, and `Step.create(subFlow)` cannot widen an outer flow's perimeter.
        - `CompensationManager` (`packages/core/src/features/compensation/`) and `flow.compensate()` propagate and run compensation handlers inside the captured effective `networkPolicy`.

---

## 4. Scoped Inventory & Rationale

### 4.1 `@siglo/core`

| Symbol / File                                                                                                                                                                                                                          | Field(s)                     | Decision                                                     | Rationale                                                                                                                                                                            |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------- | :----------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WaitForEventOptions` (`features/durable/types.ts`, `wait.ts`)                                                                                                                                                                         | `timeout`, `correlationKey`  | **Tier 1: Sync `DynamicDuration` / `DynamicOption<string>`** | Read per-tenant approval SLAs & dynamic correlation keys from prior step `ctx`. `timeoutMs` retains precedence; non-durable path skips `timeout(ctx)` evaluation.                    |
| `wait(durationOrMs)` (`features/durable/wait.ts`)                                                                                                                                                                                      | `durationOrMs`               | **Tier 1: Sync `DynamicDuration`**                           | Read dynamic backoff/cooldown computed by a previous step (`ctx => ctx.cooldown`). Updates `WaitNode` (`features/graph/types.ts`) & `validateGraph` (`features/graph/validator.ts`). |
| `ExecutionOptions` (`features/step/index.ts`, `executer/runner.ts`)                                                                                                                                                                    | `idempotencyKey`             | **Tier 1: Sync `DynamicOption<string>`**                     | Already sync `string \| ((ctx: any) => string)`; standardize type via `DynamicOption<string>`.                                                                                       |
| `IdempotencyOptions`, `Step.idempotent()` (`features/idempotency/types.ts`, `step/index.ts`, `StartChain.ts`)                                                                                                                          | `key` / `keyOrFn`            | **Tier 1: Sync `DynamicOption<string>`**                     | Already sync `string \| ((ctx: any) => string)`; standardize type via `DynamicOption<string>`.                                                                                       |
| `ExecutionOptions.timeout`/`timeoutMs`/`idempotencyTtlMs`, `Step.timeout()`, `Flow.timeout()`, `IdempotencyOptions.ttl`/`ttlMs`, `RetryConfig.delay`/`maxDelay`, `CompensationOptions.delay`, `CacheOptions.ttl`/`swr`, `Step.cache()` | timeout / ttl / delay fields | **Tier 2: Static `DurationInput` (`number \| string`)**      | Ergonomic duration strings (`'30s'`, `'5m'`) for configuration values without unnecessary callback overhead.                                                                         |
| `RetryConfig`, `CompensationOptions` (`OnFail.ts`, `compensation/types.ts`)                                                                                                                                                            | `retryIf`                    | **Tier 3: Keep sync `(err, attempt) => boolean`**            | Pure error/attempt inspection without `Promise` overhead in retry timers.                                                                                                            |
| `MapOptions` (`features/combinators/map.ts`)                                                                                                                                                                                           | `concurrency`                | **Tier 3: Keep static `number`**                             | Worker pool sizing is static orchestration config.                                                                                                                                   |

### 4.2 Ecosystem Packages & IDE Analysis

| Package & Symbol                                                                       | Field(s)                                                         | Decision                                                                                                             | Rationale                                                                                                                                                                                  |
| :------------------------------------------------------------------------------------- | :--------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@siglo/notifications`** (`types.ts`, `steps.ts`: `SendNotificationOptions`)         | `channel`, `recipient`, `subject`, `template`, `data`            | **Tier 1: Sync `DynamicOption`**                                                                                     | Alias `export type Dynamic<T, C> = DynamicOption<T, C>`. Allow `data` to use `DynamicOption<Record<string, unknown>, TInput>` as well; all read from prior step `ctx`.                     |
| **`@siglo/notifications`** (`SendNotificationOptions`)                                 | `deduplicationTtl`                                               | **Tier 2: `DurationInput` (`number` seconds \| `string`)**                                                           | Preserves `number` as seconds for backwards compatibility; string uses `parseDuration`.                                                                                                    |
| **`@siglo/notifications`** (`InteractiveApprovalOptions`)                              | `recipient`, `title`, `description`, `correlationKey`, `timeout` | **Tier 1: Sync `DynamicOption` / `DynamicDuration`**                                                                 | Read SLA `timeout` and approval fields from prior step `ctx`; static `timeout` continues validating eagerly at definition time (`ttl > 0`).                                                |
| **`@siglo/http`** (`types.ts`, `step.ts`: `HttpStepOptions`, `CompensationHttpConfig`) | `url`, `headers`, `query`, `body`                                | **Tier 1: Sync `DynamicOption` / `(ctx, res) => T`**                                                                 | Standardize `HttpStepOptions` via `DynamicOption`; `CompensationHttpConfig` keeps sync `(ctx, res) => T` resolvers.                                                                        |
| **`@siglo/http`** (`HttpStepOptions`)                                                  | `timeoutMs` (and optional `timeout`)                             | **Tier 2: `DurationInput`** (keep `timeoutMs?: number`, optionally `timeout?: DurationInput`)                        | Request deadlines are configuration values (`5000` / `'5s'`); dynamic deadlines can be computed upstream if needed.                                                                        |
| **`@siglo/crypto`** (`types.ts`: `FieldCipherOptions`)                                 | `aad`, `deriveKeyContext`                                        | **Tier 1: Sync `DynamicOption`** (keep `secretKey` async-capable)                                                    | Standardize `aad` & `deriveKeyContext` via `DynamicOption`; preserve `secretKey`'s existing `Promise` support for backwards compatibility.                                                 |
| **`@siglo/crypto`** (`types.ts`: `WebhookVerifyOptions`)                               | `secret`, `provider`                                             | **Tier 1: Sync `DynamicOption`**                                                                                     | Standardize `secret` & `provider` via `DynamicOption`; upstream step or handler supplies tenant secret on `ctx`.                                                                           |
| **`@siglo/crypto`** (`WebhookVerifyOptions`)                                           | `payload`, `signature`, `headers`                                | **Tier 3: Keep sync `(ctx) => ...`**                                                                                 | Pure extractors off the incoming request object (`ReadableStream` / `AsyncIterable` payloads remain supported).                                                                            |
| **`@siglo/ai`** (`types.ts`, `models.ts`, `step.ts`: `AiModelConfig`, `AiStepOptions`) | `apiKey`, `prompt`                                               | **Tier 1: Sync `DynamicOption`**                                                                                     | Standardize via `DynamicOption`. Must remain synchronous so `AiStep.cache()`'s synchronous `keySerializer` and exported `resolveModel()` work safely without `Promise` serialization bugs. |
| **`@siglo/ai`** (`AiModelConfig`, `AiTool`)                                            | `requestTimeoutMs` / `mapInput`                                  | **Tier 2 / Tier 3**: `requestTimeoutMs` as static `DurationInput` (`number \| string`); `AiTool.mapInput` stays sync | Timeouts are static config; `AiTool.step` already handles async tool execution.                                                                                                            |
| **`@siglo/ide-analysis`** (`patterns/step-detector.ts`)                                | AST parsing                                                      | **Parser Tests Only**                                                                                                | Verify `(ctx) => ...` dynamic expressions (including `DynamicDuration` in `wait` / `waitForEvent` / `sendInteractiveApprovalStep`) extract cleanly.                                        |

---

## 5. Phased Implementation Plan

### Phase 1: Core Shared Types & Durable Waits (`@siglo/core`)

- [x] Create `packages/core/src/shared/DynamicOption.ts` (`DynamicOption`, `DurationInput`, `DynamicDuration`, `resolveDynamic`, hardened `parseDuration`) with unit tests (`100%` `c8` coverage), exported from `packages/core/src/shared/index.ts` and `packages/core/src/index.ts`.
- [x] Update `WaitForEventOptions` (`packages/core/src/features/durable/types.ts`), `waitForEvent` & `wait` (`packages/core/src/features/durable/wait.ts`), and `WaitNode` (`packages/core/src/features/graph/types.ts` + `packages/core/src/features/graph/validator.ts`).
- [x] Add comprehensive tests in `durable.test.ts` and `graph.test.ts` (static and sync-dynamic `timeout` & `correlationKey`, `timeoutMs` precedence, non-durable skip, `wait` dynamic durations, graph validation & `toJSON`).
- [x] Update `docs/06-durable-workflows.md`, `docs/api/orchestration-and-combinators.md`, and `skills/siglo-durable-workflows/SKILL.md`.

### Phase 2: Core Duration Inputs, Idempotency Types & ASL Hardening (`@siglo/core`)

- [x] Implement ASL governance fixes in `StartChain.ts` (intersect enclosing `networkPolicyStorage` with step/sub-flow policies), `CompensationManager` (`compensation/manager.ts`), and `flow.compensate()` (`step/index.ts`).
- [x] Standardize `ExecutionOptions.idempotencyKey`, `IdempotencyOptions.key`, and `Step.idempotent()` on `DynamicOption<string, TContext>` (`step/index.ts`, `idempotency/types.ts`).
- [x] Add `DurationInput` (`number | string`) support to `ExecutionOptions.timeout`/`timeoutMs`/`idempotencyTtlMs`, `Step.timeout()`, `Flow.timeout()`, `IdempotencyOptions.ttl`/`ttlMs`, `RetryConfig.delay`/`maxDelay`, `CompensationOptions.delay`, and `CacheOptions.ttl`/`swr` + `Step.cache()`.
- [x] Keep `MapOptions.concurrency` as static `number` and `RetryConfig.retryIf` / `CompensationOptions.retryIf` synchronous.
- [x] Maintain **100% `c8` line & statement coverage** across all modified `@siglo/core` files (`npm test`), plus ASL integration tests (`network.integration.test.ts`).
- [x] Update core API docs (`execution-options.md`, `flow.md`, `step.md`, `orchestration-and-combinators.md`) and skills (`siglo-runtime-and-resilience`, `siglo-workflow-development`).

### Phase 3: Ecosystem Parity & IDE Analysis

- [x] **`@siglo/notifications`**: Alias `Dynamic<T, C> = DynamicOption<T, C>`; support sync `DynamicOption` on `SendNotificationOptions` (`channel`, `recipient`, `subject`, `template`, `data`) & `InteractiveApprovalOptions` (`recipient`, `title`, `description`, `correlationKey`, `timeout: DynamicDuration`); support `DurationInput` on `deduplicationTtl`; test dynamic/invalid timeouts.
- [x] **`@siglo/http`**: Standardize `HttpStepOptions` (`url`, `headers`, `query`, `body`) on `DynamicOption`; support `DurationInput` timeout; keep `CompensationHttpConfig` sync `(ctx, res) => T`.\n- [x] **`@siglo/crypto`**: Standardize `FieldCipherOptions` (`aad`, `deriveKeyContext`, keeping `secretKey` async-capable) and `WebhookVerifyOptions` (`secret`, `provider`) on `DynamicOption` (keeping `payload`, `signature`, `headers` sync extractors).
- [x] **`@siglo/ai`**: Standardize `AiModelConfig.apiKey` and `AiStepOptions.prompt` on sync `DynamicOption` and support `DurationInput` for `requestTimeoutMs` (keeping `AiTool.mapInput` sync and `AiStep.cache()` synchronous).
- [x] **`@siglo/ide-analysis`**: Add parser tests verifying dynamic `(ctx) => ...` expressions in `wait`, `waitForEvent`, and ecosystem steps extract cleanly.
- [x] Update ecosystem adapter docs and skills (`siglo-ecosystem-adapters`, `siglo-security-and-guardrails`).

---

## 6. Verification Checklist

- [x] `npm test` — builds `@siglo/core` and enforces 100% line & statement `c8` coverage _(verified for Phases 1–3)_.
- [x] `npm run test:packages` — runs all ecosystem package tests (`http`, `crypto`, `notifications`, `ai`, `scheduler`, etc.) _(verified for Phases 1–3)_.
- [x] `npm run test:ide` — runs `@siglo/ide-protocol`, `@siglo/ide-analysis`, and `@siglo/vscode` suites _(verified for Phases 1–3)_.
- [x] `npm run lint` — verifies ESLint across packages with zero errors or warnings _(verified for Phases 1–3)_.
