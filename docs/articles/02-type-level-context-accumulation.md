---
title: 'How TypeScript Accumulates Step Types Across Pipelines'
description: 'Type-level walkthrough of Step<TInput, TOutput, TName>, MergeStepContext<TAcc, TOut>, $steps history inference, and StandardSchemaV1 integration.'
---

# How TypeScript Accumulates Step Types Across Pipelines

One of the oldest ergonomics problems in TypeScript pipeline libraries is **context typing across independent steps**.

Suppose you have three decoupled steps in an order pipeline:

1. `fetchUser` takes `{ userId: string }` and returns `{ name: string; tier: 'FREE' | 'PRO' }`.
2. `calculateDiscount` reads `{ tier: string }` and returns `{ discount: number }`.
3. `createInvoice` reads `{ userId: string; name: string; discount: number }` and returns `{ invoiceId: string }`.

In most workflow engines or middleware chains, you end up choosing between two painful compromises:

- **The God Context**: Define a giant `OrderPipelineContext` interface upfront where every field produced by later steps is marked `optional?:`, littering downstream steps with non-null assertions (`ctx.discount!`).
- **Manual Plumbing**: Write a wrapper function that manually awaits each step and threads the outputs into the next call, losing declarative graph inspection, retries, and automatic Saga rollbacks.

When designing [**Siglo**](https://github.com/jsoftgem/siglo) (`@siglo/core`), we wanted each step to remain completely decoupled while giving the composed `flow()` **exact compile-time knowledge** of both the accumulated flat context and the per-step execution history (`$steps`).

Here is how TypeScript's type system makes that work under the hood.

---

## 1. Capturing Literal Step Names with `Step<TInput, TOutput, TName>`

Every step in Siglo carries three type parameters:

```typescript
export class Step<TInput = any, TOutput = any, TName extends string = string> {
    name: TName;
    action: StepAction<TInput, TOutput>;
    // ...
}
```

When you define a step with `Step.create()`, TypeScript infers `TName` as a **string literal type** (`'fetchUser'`), not just `string`:

```typescript
const fetchUser = Step.create('fetchUser', async (param: { userId: string }) => {
    return { name: 'Alice', tier: 'PRO' as const };
});
// Inferred type:
// Step<{ userId: string }, { name: string; tier: 'PRO' }, 'fetchUser'>
```

Capturing `'fetchUser'` as a literal type parameter `N1 extends string` is the key that unlocks typed step history (`result.$steps.fetchUser`) later in the pipeline.

---

## 2. Merging Contexts Without Duplicate Property Collisions (`MergeStepContext`)

At runtime, when a step returns a plain object `{ name: 'Alice', tier: 'PRO' }`, Siglo merges those keys into the active workflow context. If a later step returns an updated property with the same key (for example, overriding `{ status: 'PENDING' }` with `{ status: 'APPROVED' }`), the later step's property wins.

If you model this in TypeScript with a naive intersection (`TAcc & TOut`), overriding a property with a different type produces `never` (e.g., `{ status: 'PENDING' } & { status: 'APPROVED' }` makes `status: never`).

Instead, Siglo uses `MergeStepContext<TAcc, TOut>`:

```typescript
export type MergeStepContext<TAcc, TOut> = [TOut] extends [void | undefined]
    ? TAcc
    : [TOut] extends [object]
      ? Omit<TAcc, keyof TOut> & TOut
      : TAcc;
```

Let's break down why each piece of `MergeStepContext` is written this way:

1. **Tuple wrapping (`[TOut] extends [...]`)**: Wrapping `TOut` in a 1-tuple prevents conditional type distribution if `TOut` happens to be a union (such as `{ cached: true; data: string } | void`).
2. **Side-effect steps (`[TOut] extends [void | undefined]`)**: Many workflow steps—such as logging, metrics, or sending an email—return `void`. Those steps leave the accumulated context `TAcc` untouched.
3. **Key eviction before intersection (`Omit<TAcc, keyof TOut> & TOut`)**: By omitting `keyof TOut` from the prior accumulated context `TAcc` before intersecting `& TOut`, downstream steps cleanly narrow or overwrite upstream keys without ever collapsing a property type to `never`.

---

## 3. Preserving Shadowed Outputs in `$steps` (`FlowContextResult`)

What if two steps _intentionally_ return a field with the same name—for example, `reserveWarehouseA` and `reserveWarehouseB` both return `{ reservationId: string }`—and a downstream step needs both?

alongside the flat merged context, Siglo records every step's raw output under `result.$steps[stepName]`. At the type level, `FlowContextResult` combines the flat context with a mapped `$steps` record:

```typescript
export type FlowContextResult<TContext, THistory = Record<string, any>> = TContext & {
    $steps: THistory;
};
```

In `flow()`, each step's literal name `N1`, `N2`, `N3` and output type `T1Out`, `T2Out`, `T3Out` are folded into both `MergeStepContext` and the `$steps` history intersection:

```typescript
export function flow<TIn, T1Out, N1 extends string, T2Out, N2 extends string, T3Out, N3 extends string>(
    s1: Step<any, T1Out, N1>,
    s2: Step<any, T2Out, N2>,
    s3: Step<any, T3Out, N3>,
): Flow<
    TIn,
    FlowContextResult<
        MergeStepContext<MergeStepContext<MergeStepContext<TIn, T1Out>, T2Out>, T3Out>,
        Record<N1, T1Out> & Record<N2, T2Out> & Record<N3, T3Out>
    >
>;
```

Here is what the developer experiences in their IDE:

```typescript
import { Step, flow } from '@siglo/core';

const fetchUser = Step.create('fetchUser', async ({ userId }: { userId: string }) => ({
    name: 'Alice',
    tier: 'PRO' as const,
}));

const calculateDiscount = Step.create('calculateDiscount', async ({ tier }: { tier: 'FREE' | 'PRO' }) => ({
    discountPercentage: tier === 'PRO' ? 0.2 : 0.05,
}));

const issueReceipt = Step.create(
    'issueReceipt',
    async ({ name, discountPercentage }: { name: string; discountPercentage: number }) => ({
        receiptId: `rcpt_${name}_${discountPercentage}`,
    }),
);

const orderFlow = flow(fetchUser, calculateDiscount, issueReceipt);

const result = await orderFlow.run({ userId: 'u_123' }, { pojo: true });

// 1. Flat accumulated context is fully typed:
result.userId; // string
result.name; // string
result.tier; // 'PRO'
result.discountPercentage; // number
result.receiptId; // string

// 2. Individual step outputs are also statically typed under $steps:
result.$steps.fetchUser.tier; // 'PRO'
result.$steps.calculateDiscount.discountPercentage; // number
result.$steps.issueReceipt.receiptId; // string
```

---

## 4. Extending Type Inference to Schema Validation (`StandardSchemaV1`) and `@siglo/ai`

This exact same type accumulation mechanism powers `@siglo/ai`. Because Siglo supports the [Standard Schema (`StandardSchemaV1`)](https://standardschema.dev/) specification—implemented by **Zod**, **Valibot**, and **ArkType**—an `aiStep` infers its structured output type directly from your schema without tying `@siglo/ai` to a specific validation library:

```typescript
export function aiStep<const N extends string, I = any, S extends StandardSchemaV1 = StandardSchemaV1>(
    name: N,
    options: AiStepOptions<I, S> & { schema: S },
): AiStep<I, StandardSchemaV1.InferOutput<S>, N>;
```

When you drop an `aiStep` into a `flow()`, `StandardSchemaV1.InferOutput<S>` becomes `TOut` for that step, automatically merging the validated LLM output and token/cost telemetry (`$ai`) into the downstream TypeScript context.

---

## Explore the Code

- **Type definitions in `@siglo/core`**: [`packages/core/src/features/step/index.ts`](https://github.com/jsoftgem/siglo/blob/main/packages/core/src/features/step/index.ts)
- **TypeScript Reference Guide**: [`docs/10-typescript-reference.md`](../10-typescript-reference.md)
