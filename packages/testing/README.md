# 09. Testing and Replay

`@siglo/testing` provides a comprehensive, zero-flake test harness for deterministic execution, step mocking, spy inspection, virtual timers, execution trace snapshots, and production failure replay.

---

## 1. The Workflow Harness

Create a test harness wrapping any workflow:

```typescript
import { createWorkflowHarness } from '@siglo/testing';
import { orderWorkflow } from './order.workflow';

const harness = createWorkflowHarness(orderWorkflow, {
    services: {
        paymentGateway: mockPaymentGateway
    }
});

const result = await harness.run({ orderId: 'ord-100' });
```

---

## 2. Spies and Assertions

Inspect step calls, attempt counts, inputs, and outputs:

```typescript
const spy = harness.spyStep('validateOrder');

await harness.run({ orderId: 'ord-100' });

console.log(spy.called);     // true
console.log(spy.callCount);  // 1
console.log(spy.firstCall()?.input); // { orderId: 'ord-100' }

// Built-in assertions
harness.assertStepExecuted('validateOrder', 1);
harness.assertStepRetried('chargeCard', 2);
harness.assertStepFailed('riskyStep', /timeout/);
```

---

## 3. Step Mocking

Replace third-party dependencies or expensive external APIs without modifying workflow code:

```typescript
harness.mockStep('callStripe', async (param) => {
    return { chargeId: 'ch_mock_123', status: 'SUCCESS' };
});
```

---

## 4. Fake Clock & Virtual Timers

Control virtual time for delays, timeouts, and expirations without `setTimeout` delays in tests:

```typescript
import { FakeClock, createWorkflowHarness } from '@siglo/testing';

const clock = new FakeClock(1000);
const harness = createWorkflowHarness(workflow, { clock });

// Advance virtual clock
clock.advanceTime(5000);

// Advance virtual clock and flush microtask loop
await clock.tick(1000);
```

---

## 5. Execution Records and Failure Replay

Export sanitized execution records from real executions or staging runs and replay them locally:

```typescript
// 1. Export sanitized record from execution
const record = harness.exportExecutionRecord({
    excludeKeys: ['internalSecret']
});

// 2. Replay execution against workflow definition
import { replayExecution } from '@siglo/testing';

const replayResult = await replayExecution(record, orderWorkflow, {
    substituteFixtures: {
        // Replace flaky third-party API with recorded response
        chargeCard: { success: true, txnId: 'txn_999' }
    }
});

console.log(replayResult.matched);       // true or false
console.log(replayResult.discrepancies); // List of mismatches if any
```

---

## Minimal Example

```typescript
import { expect } from 'chai';
import { createWorkflowHarness } from '@siglo/testing';
import { Step, flow } from 'siglo';

const s1 = Step.create('add', (p: { x: number }) => ({ res: p.x + 5 }));
const wf = flow(s1);

const harness = createWorkflowHarness(wf);
const res = await harness.run({ x: 10 });
expect(res.res).to.equal(15);
harness.assertStepExecuted('add', 1);
```

---

## Failure Example: Catching Regressions with Replay

```typescript
import { replayExecution } from '@siglo/testing';
import { Step, flow } from 'siglo';

// Modified workflow with a bug: calculates 10% tax instead of 5%
const buggyWf = flow(
    Step.create('calcTax', (p: { amount: number }) => ({ tax: p.amount * 0.10 }))
);

const recordedBaseline = {
    input: { amount: 100 },
    output: { tax: 5 }, // Expected 5 from baseline
    trace: [],
    recordedAt: new Date().toISOString()
};

const result = await replayExecution(recordedBaseline, buggyWf);

if (!result.matched) {
    console.error('Regression Detected:');
    for (const diff of result.discrepancies) {
        console.error(' -', diff);
    }
}
```

---

## Testing Example: Full Mocking & Spying

```typescript
import { expect } from 'chai';
import { createWorkflowHarness } from '@siglo/testing';
import { Step, flow } from 'siglo';

const s1 = Step.create('fetchUser', () => ({ user: 'Alice' }));
const s2 = Step.create('emailUser', (p: any) => ({ sent: true }));
const wf = flow(s1, s2);

describe('Full Harness Suite', () => {
    it('mocks step and asserts spy calls', async () => {
        const harness = createWorkflowHarness(wf);
        const emailSpy = harness.spyStep('emailUser');

        harness.mockStep('fetchUser', () => ({ user: 'MockedUser' }));

        const result = await harness.run();
        expect(result.user).to.equal('MockedUser');
        expect(emailSpy.called).to.be.true;
        expect(emailSpy.firstCall()?.input.user).to.equal('MockedUser');
    });
});
```

---

## Operational Caveats

1. **Secret Redaction**: Always run `sanitizeExecutionRecord()` before writing execution records to bug reports or test fixtures. Defaults automatically redact passwords, API keys, and credit cards.
2. **Deterministic Randomness**: If steps generate UUIDs or timestamps, inject a deterministic clock or generator via `param.$services` so replays produce matching records.

---

## API Reference Links

- [TypeScript Reference](../../docs/10-typescript-reference.md)
- [CLI Reference](../../docs/01-getting-started.md#cli-scaffolding)
