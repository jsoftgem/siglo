# @siglo/testing Adapter Guide

`@siglo/testing` provides zero-flake testing utilities, virtual clocks, step spies, mocks, and failure replay tooling for `Siglo` workflows.

---

## 1. Overview & Architecture

Testing distributed workflows is notoriously difficult due to non-deterministic time delays, external network dependencies, and transient race conditions. `@siglo/testing` solves this with:

1. **`WorkflowHarness`**: Runs workflows in an isolated test sandbox with built-in step spying and assertions.
2. **`FakeClock`**: Fast-forwards timers deterministically without real-time `setTimeout` delays.
3. **`InMemoryStorageFake`**: Lightweight, synchronous in-memory storage adapter capturing checkpoints and context mutations.
4. **Execution Recording & Replay**: Sanitizes production run records and replays them locally to verify deterministic parity and detect discrepancies.

```mermaid
flowchart TD
    Workflow[\"Workflow Definition (flow)\"]

    subgraph Harness[\"@siglo/testing Harness\"]
        WH[\"createWorkflowHarness(flow, options)\"]
        Clock[\"FakeClock<br/>• advanceTime()<br/>• tick()\"]
        Spy[\"StepSpy<br/>• spyOnStep()<br/>• mockStep()\"]
        FakeStore[\"InMemoryStorageFake<br/>• saveCheckpoint()<br/>• getCheckpoint()\"]
    end

    subgraph Assertions[\"Test Assertions\"]
        A1[\"assertStepCompleted(name)\"]
        A2[\"assertStepFailed(name)\"]
        A3[\"assertStepRetried(name, count)\"]
    end

    Workflow --> WH
    WH --> Clock
    WH --> Spy
    WH --> FakeStore
    WH --> Assertions
```

---

## 2. Installation & Requirements

```bash
npm install --save-dev @siglo/testing
```

Peer dependencies:
- `siglo`: `^1.0.0`

---

## 3. Basic Test with `createWorkflowHarness`

```typescript
import { expect } from 'chai';
import { Step, flow } from 'siglo';
import { createWorkflowHarness } from '@siglo/testing';

const validateUser = Step.create('validate', async (param: { email: string }) => {
    if (!param.email.includes('@')) throw new Error('Invalid email');
    return { valid: true };
});

const sendEmail = Step.create('sendEmail', async (param: { email: string }) => {
    return { delivered: true };
});

const onboardingFlow = flow(validateUser, sendEmail);

describe('User Onboarding Workflow', () => {
    it('executes steps and verifies completion with harness', async () => {
        const harness = createWorkflowHarness(onboardingFlow);

        // Spy on individual steps
        const emailSpy = harness.spyOnStep('sendEmail');

        const result = await harness.run({ email: 'alice@example.com' });

        expect(result.delivered).to.be.true;
        expect(emailSpy.called).to.be.true;
        expect(emailSpy.callCount).to.equal(1);

        // Assertion helpers
        harness.assertStepCompleted('validate');
        harness.assertStepCompleted('sendEmail');
    });
});
```

---

## 4. Mocking Steps & Fault Injection

Mock external APIs, database steps, or payment gateways to simulate failure scenarios:

```typescript
it('mocks payment step and verifies compensation rollback', async () => {
    const harness = createWorkflowHarness(checkoutFlow);

    // Mock payment step to throw a simulated decline
    harness.mockStep('chargePayment', async (input) => {
        throw new Error('Card declined: Insufficient funds');
    });

    try {
        await harness.run({ orderId: 'ord-123', amount: 500 });
        expect.fail('Workflow should have thrown');
    } catch (err: any) {
        expect(err.message).to.include('Card declined');
        harness.assertStepFailed('chargePayment');
    }
});
```

---

## 5. Virtual Clocks (`FakeClock`)

Fast-forward through time without waiting for real wall-clock delays:

```typescript
import { FakeClock } from '@siglo/testing';

const clock = new FakeClock();

// Advance time by 1 hour
clock.advanceTime(60 * 60 * 1000);

// Tick next microtask
await clock.tick();
```

---

## 6. Execution Recording & Deterministic Replay

Record workflow executions in production, sanitize PII, and replay them in CI/CD to detect regressions or output discrepancies:

```typescript
import { 
    createWorkflowHarness, 
    sanitizeExecutionRecord, 
    replayWorkflowRecord 
} from '@siglo/testing';

it('replays a recorded execution and validates deterministic parity', async () => {
    const harness = createWorkflowHarness(orderPipeline);
    const result = await harness.run({ orderId: '1001', amount: 150 });

    // 1. Export execution trace record
    const record = harness.getExecutionRecord();

    // 2. Sanitize sensitive keys
    const sanitized = sanitizeExecutionRecord(record, ['creditCard', 'cvv']);

    // 3. Replay against workflow definition
    const replay = await replayWorkflowRecord(orderPipeline, sanitized);

    expect(replay.matched).to.be.true;
    expect(replay.discrepancies).to.have.length(0);
});
```

---

## 7. API Reference

### `WorkflowHarness`
- `run(input?, options?): Promise<any>`
- `mockStep(stepName: string, implementation: Function): this`
- `spyOnStep(stepName: string): StepSpy`
- `assertStepCompleted(stepName: string): void`
- `assertStepFailed(stepName: string, expectedError?: string | RegExp): void`
- `assertStepRetried(stepName: string, expectedAttempts: number): void`
- `getExecutionRecord(): ExecutionRecord`

### `InMemoryStorageFake`
- `saveCheckpoint(cp): Promise<void>`
- `getCheckpoint(stackId): Promise<any>`
- `clear(): void`

### `FakeClock`
- `now(): number`
- `advanceTime(ms: number): number`
- `tick(ms?: number): Promise<void>`
- `reset(toTime?: number): void`
