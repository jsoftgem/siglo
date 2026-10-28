# 01. Getting Started

Welcome to **Rivulet** (formerly `Rivulet`), an enterprise-grade, asynchronous workflow engine and distributed execution runtime for TypeScript and Node.js.

Rivulet makes it easy to compose complex business pipelines, sagas, parallel fan-outs, and durable human-in-the-loop orchestrations with complete type safety, deterministic testing, and zero mandatory infrastructure daemons.

---

## Installation

Install `Rivulet` (or `@rivulet/core`) along with its test harness and CLI:

```bash
npm install Rivulet
npm install --save-dev @rivulet/testing @rivulet/cli
```

---

## Quickstart: Your First Workflow

Create a new file `src/quickstart.ts`:

```typescript
import { Step, flow } from 'rivulet';

// 1. Define Step 1: Input validation and enrichment
export const fetchUser = Step.create('fetchUser', async (param: { userId: string }) => {
    if (!param.userId) {
        throw new Error('User ID is required');
    }
    return { name: 'Alice', tier: 'PRO' };
});

// 2. Define Step 2: Business action using accumulated context
export const calculateDiscount = Step.create('calculateDiscount', async (param: { tier: string }) => {
    const discount = param.tier === 'PRO' ? 0.20 : 0.05;
    return { discountPercentage: discount };
});

// 3. Compose workflow into a typed sequence
export const userWorkflow = flow(fetchUser, calculateDiscount);

// 4. Run the workflow
async function run() {
    const result = await userWorkflow.run({ userId: 'usr_1001' });
    console.log('Workflow Output:', result);
    // { userId: 'usr_1001', name: 'Alice', tier: 'PRO', discountPercentage: 0.20, $steps: { ... } }
}

run();
```

---

## Minimal Example

Here is a minimal step and flow demonstrating accumulated typed context:

```typescript
import { Step, flow } from 'rivulet';

const greet = Step.create('greet', (p: { name: string }) => ({
    message: `Hello, ${p.name}!`
}));

const pipeline = flow(greet);
const res = await pipeline.run({ name: 'World' });
console.log(res.message); // 'Hello, World!'
```

---

## Failure Example

When a step fails, `Rivulet` captures phase diagnostics, attaches error metadata, and cancels or recovers according to policy:

```typescript
import { Step, flow, RivuletError } from 'rivulet';

const riskyStep = Step.create('riskyStep', async (param: { balance: number }) => {
    if (param.balance < 0) {
        throw new Error('Insufficient balance');
    }
    return { status: 'APPROVED' };
});

const orderFlow = flow(riskyStep);

try {
    await orderFlow.run({ balance: -50 });
} catch (err: any) {
    console.error('Execution Failed:', err.message); // Insufficient balance
    console.error('Failed Step:', err.stepName);     // 'riskyStep'
    console.error('Execution Phase:', err.phase);    // 'action'
}
```

---

## Testing Example

Using `@rivulet/testing`, you can deterministically test workflows without mock servers:

```typescript
import { expect } from 'chai';
import { createWorkflowHarness } from '@rivulet/testing';
import { userWorkflow } from './quickstart';

describe('User Workflow Test Suite', () => {
    it('calculates 20% discount for PRO tier users', async () => {
        const harness = createWorkflowHarness(userWorkflow);

        const result = await harness.run({ userId: 'usr_1001' });

        expect(result.discountPercentage).to.equal(0.20);
        expect(result.name).to.equal('Alice');

        // Assert step execution telemetry
        harness.assertStepExecuted('fetchUser', 1);
        harness.assertStepExecuted('calculateDiscount', 1);
    });
});
```

---

## Operational Caveats

1. **Step Immutability**: Always use `` or POJO execution mode (`{ pojo: true }`) in production to ensure pure functional context immutability and prevent side-effect pollution between concurrent executions.
2. **Deterministic Step Actions**: Keep step actions idempotent and deterministic. Side effects (e.g. charging a payment or sending an email) should declare idempotency keys or compensation rollbacks.
3. **Avoid Unhandled Promises**: Ensure all asynchronous steps return promises that resolve or reject explicitly.

---

## CLI Scaffolding

Generate production-ready workflow templates using the CLI:

```bash
# Scaffold a new project structure
npx rivulet init

# Generate a typed workflow and mocha/chai test
npx rivulet generate workflow checkout

# Generate an isolated step and unit test
npx rivulet generate step charge-customer
```

---

## API Reference Links

- [Core Concepts Guide](./02-core-concepts.md)
- [Sequential Workflows](./03-sequential-workflows.md)
- [Testing & Replay Reference](./09-testing-and-replay.md)
- [TypeScript API Reference](./10-typescript-reference.md)
