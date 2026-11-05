# 10. TypeScript Reference

`Siglo` is built from the ground up for modern TypeScript (strict mode, noImplicitAny, exactOptionalPropertyTypes).

---

## 1. Step Generics: `Step<TInput, TOutput, TName>`

```typescript
export class Step<TInput = any, TOutput = any, TName extends string = string> {
    name: TName;
    action: StepAction<TInput, TOutput>;
    ...
}
```

When defining a step with `Step.create(name, action)`:
- `TInput`: Type expected by the step action parameter.
- `TOutput`: Type returned by the step action.
- `TName`: String literal name of the step (used to index `$steps`).

```typescript
const fetchUser = Step.create<'fetchUser', { id: string }, { user: { name: string; email: string } }>(
    'fetchUser',
    async (param) => ({ user: { name: 'Alice', email: 'alice@example.com' } })
);
```

---

## 2. Accumulated Context Inference

When steps are chained in `flow(s1, s2, s3)`:
- Step 1 receives `TIn` and returns `T1Out`.
- Step 2 receives `TIn & T1Out` and returns `T2Out`.
- Step 3 receives `TIn & T1Out & T2Out` and returns `T3Out`.
- The workflow execution returns `MergeStepContext<TIn, T1Out & T2Out & T3Out> & { $steps: Record<...> }`.

```typescript
const s1 = Step.create('s1', (p: { a: number }) => ({ b: 'hello' }));
const s2 = Step.create('s2', (p: { a: number; b: string }) => ({ c: true }));

const wf = flow(s1, s2);

// TypeScript infers result as:
// { a: number; b: string; c: boolean; $steps: { s1: { b: string }; s2: { c: boolean } } }
const result = await wf.run({ a: 10 });
```

---

## 3. Typed Step History: `$steps`

Every named step automatically registers its typed output in `$steps`:

```typescript
const s1 = Step.create('loadUser', () => ({ user: { id: 'u1', role: 'admin' } }));
const s2 = Step.create('loadBilling', (param: any) => {
    // Statically typed access to s1's output!
    const userRole = param.$steps.loadUser.user.role;
    return { billed: true };
});
```

---

## 4. Dependency Injection Typing

Define typed runtime dependencies per-step or per-workflow:

```typescript
interface MyServices {
    db: { query: (sql: string) => Promise<any[]> };
    logger: { info: (msg: string) => void };
}

const dbStep = Step.create('dbStep', async (param: any) => {
    const services = param.$services as MyServices;
    const rows = await services.db.query('SELECT 1');
    return { rows };
});

// Run with typed services
await dbStep.execute({}, {
    services: {
        db: myDbPool,
        logger: console
    }
});
```

Or attach step-level dependencies:

```typescript
const stepWithDeps = dbStep.withDependencies({
    apiClient: new HttpClient()
});

const client = stepWithDeps.requireDependency<HttpClient>('apiClient');
```

---

## 5. Schema Validation Support

`Siglo` integrates with **Standard Schema** (`~standard`) compatible libraries including **Zod**, **Valibot**, and **ArkType**:

```typescript
import { z } from 'zod';
import { Step } from '@siglo/core';

const UserSchema = z.object({
    username: z.string().min(3),
    age: z.number().int().positive()
});

const validateStep = Step.create('validate', async (param) => {
    return { ok: true };
})
.schema(UserSchema)
.strict();
```

---

## Minimal Example

```typescript
import { Step, flow } from '@siglo/core';

interface Input {
    val: number;
}
interface Step1Out {
    doubled: number;
}

const s1 = Step.create<Input, Step1Out, 'doubleStep'>('doubleStep', (p) => ({
    doubled: p.val * 2
}));

const wf = flow(s1);
const res = await wf.run({ val: 21 });
console.log(res.doubled); // 42
```

---

## Compile-Time Checking & Inference Boundaries

When steps declare explicit input generic types (`Step.create<MyInput, ...>`), TypeScript verifies whether upstream outputs provide the required properties:

```typescript
const stepA = Step.create('stepA', () => ({ x: 10 }));

// stepB requires 'y: string' which does not exist in upstream output
const stepB = Step.create<{ y: string }, { z: string }, 'stepB'>('stepB', (param) => ({
    z: param.y.toUpperCase()
}));
```

> [!NOTE]
> **Inference Limits with Combinators & Long Pipelines**:
> Type inference works seamlessly across sequential chains. However, across dynamic combinators (`branch`, `when`, `map`) or deep pipelines (5+ steps), TypeScript's conditional type evaluation may widen accumulated intersection types or infer optional properties. For ironclad parameter validation across complex combinators and untrusted ingress boundaries, pair TypeScript definitions with runtime schema assertions (`step.schema()` or `step.spec()`).

---

## Testing Example

```typescript
import { expect } from 'chai';
import { Step, flow } from '@siglo/core';

const s1 = Step.create<'calc', { n: number }, { isEven: boolean }>('calc', (p) => ({
    isEven: p.n % 2 === 0
}));

describe('TypeScript Type Parity Test', () => {
    it('verifies typed output parity', async () => {
        const wf = flow(s1);
        const res = await wf.run({ n: 4 });
        expect(res.isEven).to.be.true;
        expect(res.$steps.calc.isEven).to.be.true;
    });
});
```

---

## Operational Caveats

1. **Keep Step Generic Signatures Clean**: In complex pipelines, rely on TypeScript's inference rather than manually specifying all intermediate types for 10+ steps.
2. **Strict Mode**: Ensure `"strict": true` is enabled in `tsconfig.json` for full compile-time inference benefits.

---

## API Reference Links

- [Core Concepts Guide](./02-core-concepts.md)
- [Sequential Workflows](./03-sequential-workflows.md)
- [Testing & Replay Reference](./09-testing-and-replay.md)
