# API Reference: Deterministic Testing (`@siglo/testing`)

The `@siglo/testing` package provides a zero-flake, deterministic test harness for **Siglo** workflows. It eliminates reliance on flaky timers, live databases, and manual mocking setups by providing virtual clocks (`FakeClock`), step spies, deterministic step mocking, event injection for durable waits, execution tracing, and replay tooling.

---

## Table of Contents

- [Overview & Installation](#overview--installation)
- [Workflow Test Harness](#workflow-test-harness)
  - [`createWorkflowHarness(flow, options?)`](#createworkflowharnessflow-options)
  - [`harness.run(input?, options?)` / `harness.execute()`](#harnessruninput-options--harnessexecute)
  - [`harness.mockStep(stepName, mockImpl)`](#harnessmockstepstepname-mockimpl)
  - [`harness.spyStep(stepName)`](#harnessspystepstepname)
  - [`harness.injectEvent(eventName, correlationKey, payload?)`](#harnessinjecteventeventname-correlationkey-payload)
  - [`harness.getTrace()`](#harnessgettrace)
- [Harness Assertions](#harness-assertions)
  - [`harness.assertStepExecuted(stepName, times?)`](#harnessassertstepexecutedstepname-times)
  - [`harness.assertStepRetried(stepName, minAttempts?)`](#harnessassertstepretriedstepname-minattempts)
  - [`harness.assertStepFailed(stepName, errorPattern?)`](#harnessassertstepfailedstepname-errorpattern)
- [Virtual Clock (`FakeClock`)](#virtual-clock-fakeclock)
- [In-Memory Storage Fake (`InMemoryStorageFake`)](#in-memory-storage-fake-inmemorystoragefake)
- [Execution Fixtures & Replay](#execution-fixtures--replay)
  - [`harness.exportExecutionRecord(options?)`](#harnessexportexecutionrecordoptions)
  - [`replayExecution(record, flow, options?)`](#replayexecutionrecord-flow-options)
  - [`sanitizeExecutionRecord(record, options?)`](#sanitizeexecutionrecordrecord-options)
- [Full Test Suite Example](#full-test-suite-example)

---

## Overview & Installation

```bash
npm install --save-dev @siglo/testing
```

---

## Workflow Test Harness

### `createWorkflowHarness(flow, options?)`

Factory creating an isolated `WorkflowHarness` with virtual clocks, storage, step mocking, and execution telemetry.

#### Signatures

```typescript
export interface HarnessOptions {
    services?: Record<string, any>;
    clock?: FakeClock;
    storage?: InMemoryStorageFake;
    recordTrace?: boolean;
}

export function createWorkflowHarness(
    workflow: any,
    options?: HarnessOptions
): WorkflowHarness;
```

#### Example

```typescript
import { createWorkflowHarness, FakeClock } from '@siglo/testing';
import { orderWorkflow } from './order.workflow';

const clock = new FakeClock();
const harness = createWorkflowHarness(orderWorkflow, { clock });
```

---

### `harness.run(input?, options?)` / `harness.execute()`

Executes the workflow through the instrumented harness, automatically recording step trace records, timings, and outputs.

#### Signature

```typescript
harness.run(input: any = {}, execOptions: any = {}): Promise<any>;
```

---

### `harness.mockStep(stepName, mockImpl)`

Overrides a step's action with a deterministic mock implementation. Useful for third-party HTTP requests, credit card processors, or slow I/O.

#### Signature

```typescript
harness.mockStep(stepName: string, mockImpl: (param: any) => any): this;
```

#### Example

```typescript
harness.mockStep('chargeCreditCard', async (param) => {
    return { transactionId: 'txn_mock_123', status: 'SUCCESS' };
});
```

---

### `harness.spyStep(stepName)`

Attaches a `StepSpy` tracking invocation count, inputs, outputs, errors, and timestamps without overriding the step's implementation.

#### Signature

```typescript
export class StepSpy {
    readonly name: string;
    readonly calls: Array<{ input: any; output?: any; error?: any; timestamp: number }>;
    readonly called: boolean;
    readonly callCount: number;

    firstCall(): { input: any; output?: any; error?: any; timestamp: number } | undefined;
    lastCall(): { input: any; output?: any; error?: any; timestamp: number } | undefined;
}

harness.spyStep(stepName: string): StepSpy;
```

#### Example

```typescript
const spy = harness.spyStep('calculateDiscount');

await harness.run({ cartTotal: 100 });

expect(spy.called).to.be.true;
expect(spy.callCount).to.equal(1);
expect(spy.firstCall()?.input.cartTotal).to.equal(100);
```

---

### `harness.injectEvent(eventName, correlationKey, payload?)`

Simulates the arrival of an external event to resume a durable waiting workflow in test scenarios without requiring network infrastructure.

#### Signature

```typescript
harness.injectEvent(
    eventName: string,
    correlationKey: string,
    payload?: any
): Promise<any>;
```

#### Example

```typescript
// 1. Run durable workflow until it suspends at waitForEvent
await harness.run({ orderId: 'ord_123' }, { durable: true });

// 2. Inject event to resume execution
const result = await harness.injectEvent('paymentWebhook', 'ord_123', {
    paymentStatus: 'PAID'
});

expect(result.orderStatus).to.equal('COMPLETED');
```

---

### `harness.getTrace()`

Returns the recorded chronological execution trace across all steps and phases.

#### Signature

```typescript
export interface StepTraceRecord {
    stepName: string;
    phase: 'start' | 'retry' | 'complete' | 'fail' | 'skip';
    timestamp: number;
    input: any;
    output?: any;
    error?: any;
    attempt?: number;
}

harness.getTrace(): StepTraceRecord[];
```

---

## Harness Assertions

The harness provides high-level assertion helpers:

### `harness.assertStepExecuted(stepName, times?)`

Asserts that a step executed and completed successfully a specific number of times (or at least once if `times` is omitted).

```typescript
harness.assertStepExecuted('validateCart', 1);
```

---

### `harness.assertStepRetried(stepName, minAttempts?)`

Asserts that a step failed and executed retries, verifying that total attempts met or exceeded `minAttempts` (default: 2).

```typescript
harness.assertStepRetried('flakyService', 3);
```

---

### `harness.assertStepFailed(stepName, errorPattern?)`

Asserts that a step failed, optionally matching against an error string substring or regular expression pattern.

```typescript
harness.assertStepFailed('unauthorizedStep', /access denied/i);
```

---

## Virtual Clock (`FakeClock`)

`FakeClock` controls timestamps recorded in harness execution traces deterministically. Note that `FakeClock` only advances its own timestamp counter and `tick()` waits for `setImmediate`; it does not mock Node's global `Date.now`, `setTimeout`, or runtime sleep loops:

```typescript
export class FakeClock {
    constructor(initialTime: number = Date.now());
    now(): number;
    advanceTime(ms: number): number;
    tick(ms?: number): Promise<void>;
    reset(toTime?: number): void;
}
```

#### Example

```typescript
const clock = new FakeClock();
const harness = createWorkflowHarness(flowWithDelay, { clock });

// Advance virtual time by 5 minutes
clock.advanceTime(5 * 60 * 1000);
```

---

## In-Memory Storage Fake (`InMemoryStorageFake`)

Implements `StorageAdapter` completely in memory for fast, zero-dependency unit and integration tests.

```typescript
export class InMemoryStorageFake implements StorageAdapter {
    readonly name = 'in-memory-fake';
    contextChanges: any[];

    saveCheckpoint(checkpoint: any): Promise<void>;
    getCheckpoint(key: string): Promise<any>;
    clear(): void;
    getCheckpoints(): Map<string, any>;
}
```

---

## Execution Fixtures & Replay

### `harness.exportExecutionRecord(options?)`

Exports a sanitized execution record fixture containing initial inputs, outputs, errors, and complete trace data. Secret keys (e.g. `password`, `token`, `secret`, `cvv`) are automatically redacted.

```typescript
const fixture = harness.exportExecutionRecord({
    excludeKeys: ['internalSessionId']
});

fs.writeFileSync('fixtures/failed-run.json', JSON.stringify(fixture, null, 2));
```

---

### `replayExecution(record, flow, options?)`

Replays a recorded test fixture against a workflow to verify output parity, ensuring bug fixes or refactors do not introduce regressions.

#### Signature

```typescript
export interface ReplayOptions {
    substituteFixtures?: Record<string, any>;
    excludeKeys?: string[];
}

export interface ReplayResult {
    matched: boolean;
    expectedOutput: any;
    actualOutput: any;
    discrepancies: string[];
}

export function replayExecution(
    record: ExecutionRecord,
    workflow: any,
    options?: ReplayOptions
): Promise<ReplayResult>;
```

#### Example

```typescript
import { replayExecution } from '@siglo/testing';
import fixture from './fixtures/order-run.json';
import { orderWorkflow } from './order.workflow';

const result = await replayExecution(fixture, orderWorkflow);
expect(result.matched).to.be.true;
```

---

### `sanitizeExecutionRecord(record, options?)`

Sanitizes an `ExecutionRecord` by recursively redacting sensitive keys (e.g. passwords, API keys, tokens, credit card numbers) from `input`, `output`, and `trace` steps.

#### Signature

```typescript
export function sanitizeExecutionRecord(
    record: ExecutionRecord,
    options?: { excludeKeys?: string[] }
): ExecutionRecord;
```

#### Example

```typescript
import { sanitizeExecutionRecord } from '@siglo/testing';

const cleanRecord = sanitizeExecutionRecord(rawRecord, {
    excludeKeys: ['internalSecret', 'customToken']
});
```

---

## Full Test Suite Example

```typescript
import { expect } from 'chai';
import { createWorkflowHarness, FakeClock } from '@siglo/testing';
import { Step, flow } from '@siglo/core';

const fetchUser = Step.create('fetchUser', async (ctx: { userId: string }) => ({
    name: 'Alice',
    tier: 'PRO'
}));

const calculateDiscount = Step.create('calculateDiscount', async (ctx: { tier: string }) => ({
    discount: ctx.tier === 'PRO' ? 0.2 : 0.05
}));

const checkoutWorkflow = flow(fetchUser, calculateDiscount);

describe('Checkout Workflow Test Suite', () => {
    it('executes successfully with step spies and deterministic assertions', async () => {
        const clock = new FakeClock();
        const harness = createWorkflowHarness(checkoutWorkflow, { clock });

        // Spy on discount step
        const discountSpy = harness.spyStep('calculateDiscount');

        // Mock external user service
        harness.mockStep('fetchUser', () => ({ name: 'MockUser', tier: 'PRO' }));

        const result = await harness.run({ userId: 'u_100' });

        expect(result.discount).to.equal(0.2);
        expect(discountSpy.called).to.be.true;
        expect(discountSpy.firstCall()?.input.tier).to.equal('PRO');

        harness.assertStepExecuted('fetchUser', 1);
        harness.assertStepExecuted('calculateDiscount', 1);
    });
});
```

---

## Related Topic Guides

- [09. Testing and Replay](../09-testing-and-replay.md)
- [02. Core Concepts](../02-core-concepts.md)
- [CLI Developer Tooling](../adapters/cli.md)
