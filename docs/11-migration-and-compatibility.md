# 11. Migration and Compatibility

This guide details how to upgrade legacy `Rivulet` 0.x codebases to 1.0.0, how the backwards-compatibility layer operates, and how to safely adopt modern functional workflows.

---

## 1. Summary of Deprecations & Modern Equivalents

| Legacy 0.x Concept | Modern 1.0 Replacement | Status |
|---|---|---|
| `Chain` | `Step` | Deprecated alias preserved |
| `pipe(...)` | `flow(...)` | Deprecated alias preserved |
| `Pipeline` | `Flow` | Deprecated alias preserved |
| `Func` | `Step` | Deprecated alias preserved |
| Getter closures: `param.field()` | Direct property: `param.field` (`.modern()`) | Supported via `.modern()` / `{ pojo: true }` |
| Direct context mutation | Pure functional returns | Migrated |
| `getChainContext` / `putChainContext` | `StorageManager` / `StorageAdapter` | Deprecated compatibility wrappers |

---

## 2. The Compatibility Layer

`Rivulet` 1.0.0 is 100% backwards-compatible with existing 0.x code. You can run legacy and modern steps side-by-side in the same codebase:

```typescript
// Legacy 0.x syntax: Still works!
import { Chain, pipe } from 'rivulet';

const legacyStep = Chain.create('legacy', (param) => {
    // param was wrapped in getter closures: param.myField()
    return { legacyOutput: 42 };
});

const legacyPipeline = pipe(legacyStep);
```

---

## 3. Step-by-Step Modernization Guide

### Step 1: Update Imports
Change imports from `Chain` and `pipe` to `Step` and `flow`:

```typescript
// Before
import { Chain, pipe } from 'rivulet';

// After
import { Step, flow } from 'rivulet';
```

### Step 2: Enable `.modern()` on Steps
Add `.modern()` to step definitions to allow plain object destructuring without `param.field()` getter calls:

```typescript
// Before
const step = Chain.create('process', (param) => {
    const userId = param.userId(); // Required getter call in 0.x
    return { processed: true };
});

// After
const step = Step.create('process', ({ userId }: { userId: string }) => {
    return { processed: true }; // Clean POJO destructuring!
}).modern();
```

### Step 3: Run in POJO Mode
Execute flows with `{ pojo: true }` (or use `.execute()` / `.run()`) to receive standard frozen objects:

```typescript
const result = await flow(step1, step2).run(input, { pojo: true });
console.log(result.processed); // Direct boolean, not a function!
```

---

## Minimal Example

```typescript
// Side-by-side legacy and modern compatibility
import Step, { Chain, flow, pipe } from 'rivulet';

const legacyChain = Chain.create('legacyStep', (param: any) => {
    return { fromLegacy: 'ok' };
});

const modernStep = Step.create('modernStep', (param: any) => {
    return { fromModern: 'ok' };
}).modern();

// flow can execute legacy Chains and modern Steps together!
const mixedFlow = flow(legacyChain, modernStep);
const result = await mixedFlow.run({}, { pojo: true });

console.log(result.fromLegacy); // 'ok'
console.log(result.fromModern); // 'ok'
```

---

## Failure Example: Legacy Getter Pitfall

In legacy 0.x, reading a property as `param.field` instead of `param.field()` returned an accessor closure rather than the primitive value:

```typescript
// Common 0.x bug:
const step = Chain.create('buggy', (param: any) => {
    // If not using .modern():
    if (param.isActive) { // Fails! In 0.x param.isActive is a function, always truthy!
        ...
    }
});

// Fixed in 1.0 by calling .modern():
const fixedStep = Step.create('fixed', ({ isActive }: { isActive: boolean }) => {
    if (isActive) { // Works correctly as a boolean!
        ...
    }
}).modern();
```

---

## Testing Example

```typescript
import { expect } from 'chai';
import { Chain, Step, flow, isFlow, isPipeline } from 'rivulet';

describe('0.x to 1.0 Compatibility Test', () => {
    it('verifies aliases and mixed execution', async () => {
        expect(Chain).to.equal(Step);
        expect(isPipeline).to.equal(isFlow);

        const s1 = Chain.create('c1', () => ({ val: 1 }));
        const s2 = Step.create('s2', (p: any) => ({ val2: 2 })).modern();

        const wf = flow(s1, s2);
        const res = await wf.run({}, { pojo: true });
        expect(res.val).to.equal(1);
        expect(res.val2).to.equal(2);
    });
});
```

---

## Operational Caveats

1. **Avoid Mixing Context Paradigms**: Do not mutate context in one step and expect functional returns in another. Convert pipelines to pure functional returns step-by-step.
2. **Remove Deprecated Storage Hooks**: Replace custom `setGetChainContextPlugin` hooks with standard `StorageAdapter` implementations.

---

## API Reference Links

- [Core Concepts Guide](./02-core-concepts.md)
- [Storage and Adapters](./07-storage-and-adapters.md)
- [TypeScript API Reference](./10-typescript-reference.md)
