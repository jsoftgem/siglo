# @siglo/testing API Cheatsheet

Quick reference for classes, assertions, and utilities in `@siglo/testing`.

---

## 1. Primary Exports

| Export                                       | Signature                                                                                                  | Description                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `createWorkflowHarness(flow, options)`       | `createWorkflowHarness(workflow: Flow, options?: HarnessOptions): WorkflowHarness`                         | Creates an isolated test harness wrapping a workflow.                |
| `FakeClock`                                  | `new FakeClock(initialTimestamp?: number)`                                                                 | Deterministic virtual clock for timestamp and microtask advancement. |
| `replayExecution(record, workflow, options)` | `replayExecution(record: ExecutionRecord, workflow: Flow, options?: ReplayOptions): Promise<ReplayResult>` | Deterministically replays a captured execution trace fixture.        |

---

## 2. WorkflowHarness Methods

```typescript
class WorkflowHarness {
    // Execution
    run(input?: any, options?: ExecutionOptions): Promise<any>;
    execute(input?: any, options?: ExecutionOptions): Promise<any>;

    // Mocking & Spying
    mockStep(stepName: string, mockFn: (param: any) => Promise<any> | any): this; // Must stay sync for Step.compute
    spyStep(stepName: string): StepSpy;

    // Assertions
    assertStepExecuted(stepName: string, times?: number): void;
    assertStepRetried(stepName: string, minAttempts?: number): void;
    assertStepFailed(stepName: string, errorPattern?: string | RegExp): void;

    // Durable / Event Injection
    injectEvent(eventName: string, correlationKey: string, payload?: any): Promise<any>;

    // Inspection & Snapshotting
    getTrace(): ExecutionTraceItem[];
    exportExecutionRecord(options?: { excludeKeys?: string[] }): ExecutionRecord;
}
// Note: Each WorkflowHarness isolates Step.compute in-memory LRU caches per harness instance
// and clears cached entries for any step overridden with mockStep().
```

---

## 3. StepSpy API

```typescript
interface StepSpy {
    called: boolean;
    callCount: number;
    calls: Array<{ input: any; output?: any; error?: any; timestamp: number }>;
    firstCall(): { input: any; output?: any; error?: any; timestamp: number } | undefined;
    lastCall(): { input: any; output?: any; error?: any; timestamp: number } | undefined;
    reset(): void;
}
```

---

## 4. FakeClock Methods

```typescript
class FakeClock {
    constructor(initialMs?: number);
    now(): number;
    advanceTime(ms: number): void;
    tick(ms: number): Promise<void>; // Advances time AND flushes Node.js microtask loop
}
```
