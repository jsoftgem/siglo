# 03. Sequential Workflows

Sequential workflows are the primary building block in `fluid-func`. They execute a series of steps in strict order, passing accumulated context forward.

---

## 1. Constructing Steps

Use `Step.create(name, action)` to define an isolated step:

```typescript
import { Step } from 'fluid-func';

export const parseInvoice = Step.create('parseInvoice', async (param: { rawText: string }) => {
    const lines = param.rawText.split('\n');
    return {
        lineCount: lines.length,
        parsedAt: Date.now()
    };
}).modern();
```

### The `.modern()` Modifier
Invoking `.modern()` on a step enables clean POJO parameters, destructuring, and disables legacy getter-closure wrappers.

---

## 2. Composing Sequences with `flow()`

Compose multiple steps into a sequential pipeline using `flow(...steps)`:

```typescript
import { Step, flow } from 'fluid-func';

const validateInput = Step.create('validate', async (param: { email: string }) => {
    if (!param.email.includes('@')) throw new Error('Invalid email');
    return { emailValid: true };
}).modern();

const createAccount = Step.create('createAccount', async (param: { email: string }) => {
    return { accountId: 'acc_123' };
}).modern();

const sendWelcomeEmail = Step.create('sendEmail', async (param: { email: string; accountId: string }) => {
    return { emailSent: true };
}).modern();

export const signupWorkflow = flow(
    validateInput,
    createAccount,
    sendWelcomeEmail
);
```

---

## 3. Step Lifecycles

Every step supports declarative lifecycle hooks:

### `onBefore(predicate)`
Conditionally execute or skip the step action based on context:
```typescript
const notifyVip = Step.create('notifyVip', async (param: any) => ({ notified: true }))
    .onBefore((param) => param.isVip === true);
```

### `onSkip(fallbackAction)`
Provide fallback data when a step is skipped:
```typescript
const chargeCard = Step.create('chargeCard', async () => ({ charged: true }))
    .onBefore((param) => param.amount > 0)
    .onSkip(() => ({ charged: false, reason: 'Zero amount order' }));
```

### `onAfter(transformer)`
Enrich or transform step output before context assignment:
```typescript
const fetchRate = Step.create('fetchRate', async () => ({ rate: 1.25 }))
    .onAfter((output, param) => ({
        ...output,
        calculatedTotal: param.base * output.rate
    }));
```

### `cache(ttlMs)`
Cache step output in memory or across distributed storage:
```typescript
const fetchExchangeRates = Step.create('fetchRates', async () => {
    return { EUR: 1.08, GBP: 1.26 };
}).cache(60000); // Cached for 60 seconds
```

---

## Minimal Example

```typescript
import { Step, flow } from 'fluid-func';

const step1 = Step.create('add', (p: { x: number }) => ({ x: p.x + 10 })).modern();
const step2 = Step.create('multiply', (p: { x: number }) => ({ result: p.x * 2 })).modern();

const pipeline = flow(step1, step2);
const output = await pipeline.run({ x: 5 });
console.log(output.result); // 30
```

---

## Failure Example: Handling Validation & Lifecycle Rejections

```typescript
import { Step, flow, ValidationException } from 'fluid-func';

const strictStep = Step.create('strictStep', (param: { age: number }) => {
    if (param.age < 0) throw new Error('Invalid age');
    return { valid: true };
})
.spec('age', { require: true })
.strict();

const wf = flow(strictStep);

try {
    // Missing required field 'age'
    await wf.run({} as any);
} catch (err: any) {
    console.error('Validation Error:', err.message);
}
```

---

## Testing Example

```typescript
import { expect } from 'chai';
import { createWorkflowHarness } from '@fluid-func/testing';
import { Step, flow } from 'fluid-func';

const s1 = Step.create('step1', () => ({ a: 'hello' })).modern();
const s2 = Step.create('step2', (p: { a: string }) => ({ b: `${p.a} world` })).modern();
const wf = flow(s1, s2);

describe('Sequential Workflows Suite', () => {
    it('executes steps in sequence and records trace', async () => {
        const harness = createWorkflowHarness(wf);
        const result = await harness.run();

        expect(result.b).to.equal('hello world');
        expect(harness.getTrace().map(t => t.stepName)).to.deep.equal([
            'step1', 'step1', 'step2', 'step2'
        ]);
    });
});
```

---

## Operational Caveats

1. **Step Granularity**: Do not make every line of code its own step. Separate steps by logical domain boundaries, external I/O operations, or rollback requirements.
2. **Deterministic Inputs**: Keep input parameters serializable JSON objects. Avoid passing database connection instances, sockets, or open file descriptors directly through the workflow context. Use dependency injection instead (`step.withDependencies()` or `options.services`).

---

## API Reference Links

- [Branching and Parallelism](./04-branching-and-parallelism.md)
- [Retries, Timeouts, and Cancellation](./05-retries-timeouts-and-cancellation.md)
- [Testing & Replay Reference](./09-testing-and-replay.md)
