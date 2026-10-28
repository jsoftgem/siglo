# API Reference: Orchestration & Combinators

The Orchestration & Combinators API in **Rivulet** provides functional combinators and workflow orchestrators to compose modular, resilient, and type-safe async workflows. Rivulet combines sequential pipelines, parallel fan-out/fan-in, conditional branching, dynamic collections mapping, durable event suspension, and workflow AST inspection.

---

## Table of Contents

- [Core Orchestration](#core-orchestration)
  - [`flow(...steps)`](#flowsteps)
  - [`isFlow(item)`](#isflowitem)
  - [`toPOJO(context)`](#topojocontext)
- [Parallel Combinators](#parallel-combinators)
  - [`parallel(steps, options?)`](#parallelsteps-options)
  - [`all(steps, options?)`](#allsteps-options)
  - [`allSettled(steps, options?)`](#allsettledsteps-options)
  - [`race(...steps)`](#racesteps)
- [Branching & Routing](#branching--routing)
  - [`when(predicate, thenStep, elseStep?)`](#whenpredicate-thenstep-elsestep)
  - [`branch(selectorOrBranches, branchesMap?, defaultBranch?)`](#branchselectororbranches-branchesmap-defaultbranch)
- [Dynamic Mapping](#dynamic-mapping)
  - [`map(itemsOrAccessor, processItem, options?)`](#mapitemsoraccessor-processitem-options)
- [Durable Waits & Event Resumption](#durable-waits--event-resumption)
  - [`waitForEvent(eventName, options)`](#waitforeventeventname-options)
  - [`wait(durationOrMs)`](#waitdurationorms)
  - [`resumeWorkflow(flow, key, payload?, options?)`](#resumeworkflowflow-key-payload-options)
- [Graph Inspection & Visualization](#graph-inspection--visualization)
  - [`toGraph(item)`](#tographitem)
  - [`inspectGraph(item)`](#inspectgraphitem)
  - [`validateGraph(node)`](#validategraphnode)
  - [`assertValidGraph(node)`](#assertvalidgraphnode)
  - [`toMermaid(item, options?)`](#tomermaiditem-options)
  - [`toDot(item, options?)`](#todotitem-options)
  - [`toJSON(item)`](#tojsonitem)

---

## Core Orchestration

### `flow(...steps)`

Composes sequential execution units (`Step`, nested `Flow`, or combinator steps) into an executable workflow with compile-time accumulated context inference and typed step history (`$steps`).

#### Signatures

```typescript
// 1 to 5+ steps with compile-time accumulated context inference
export function flow<TIn, T1Out, N1 extends string>(
    s1: Step<any, T1Out, N1>
): Flow<TIn, FlowContextResult<MergeStepContext<TIn, T1Out>, Record<N1, T1Out>>>;

export function flow<TIn, T1Out, N1 extends string, T2Out, N2 extends string>(
    s1: Step<any, T1Out, N1>,
    s2: Step<any, T2Out, N2>
): Flow<TIn, FlowContextResult<MergeStepContext<MergeStepContext<TIn, T1Out>, T2Out>, Record<N1, T1Out> & Record<N2, T2Out>>>;

// Generic overload for dynamic/arbitrary step arrays
export function flow<TInput = any, TOutput = any>(
    ...steps: FlowArg[]
): Flow<TInput, TOutput>;
```

#### Parameters

- `...steps`: `(Step | Flow | Array<Step | Flow>)[]` &mdash; Variable list or nested arrays of steps to execute sequentially.

#### Returns

A `Flow<TInput, TOutput>` object exposing execution methods (`.run()`, `.execute()`), durable controls (`.resume()`, `.compensate()`), and export utilities (`.toMermaid()`, `.toJSON()`).

#### Context Accumulation & `$steps`

As each step executes, its output is shallow-merged into the accumulated context. Earlier step outputs remain accessible to subsequent steps. In addition, the return context includes a typed `$steps` property containing each step's output keyed by step name.

#### Example

```typescript
import { Step, flow } from 'rivulet';

const fetchUser = Step.create('fetchUser', async (param: { userId: string }) => {
    return { name: 'Alice', role: 'admin' };
});

const checkPermissions = Step.create('checkPermissions', async (param: { role: string }) => {
    return { canApprove: param.role === 'admin' };
});

const sendAlert = Step.create('sendAlert', async (param: { name: string; canApprove: boolean }) => {
    return { alerted: true, timestamp: Date.now() };
});

export const authFlow = flow(fetchUser, checkPermissions, sendAlert);

const result = await authFlow.run({ userId: 'u_100' });
console.log(result.name);              // 'Alice'
console.log(result.canApprove);         // true
console.log(result.alerted);            // true
console.log(result.$steps.fetchUser);   // { name: 'Alice', role: 'admin' }
```

---

### `isFlow(item)`

Type guard verifying whether a value implements the `Flow` interface.

#### Signature

```typescript
export function isFlow(item: any): item is Flow;
```

#### Example

```typescript
import { flow, isFlow, Step } from 'rivulet';

const myStep = Step.create('noop', async () => ({}));
const myFlow = flow(myStep);

console.log(isFlow(myFlow)); // true
console.log(isFlow(myStep)); // false
```

---

### `toPOJO(context)`

Strips internal tracked proxy wrappers, getters, and metadata from an execution context, returning a clean, serializable JavaScript object.

#### Signature

```typescript
export function toPOJO<T = any>(context: T): T;
```

#### Example

```typescript
import { toPOJO } from 'rivulet';

const cleanData = toPOJO(rawExecutionContext);
console.log(JSON.stringify(cleanData));
```

---

## Parallel Combinators

### `parallel(steps, options?)`

Executes multiple steps, flows, or functions concurrently. By default, it operates in `fail-fast` mode: if any branch fails, all other in-flight branches are aborted via an internal `AbortController`.

#### Signature

```typescript
export function parallel(
    ...args: any[]
): Step<any, any>;

export interface ParallelOptions {
    name?: string;
    mode?: 'fail-fast' | 'allSettled' | 'race';
    mergeStrategy?: 'shallow' | 'deep' | 'error' | ((target: any, source: any, branchKey: string | number) => any);
}
```

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | `'parallel'` | Identifying name for the combinator node in AST and telemetry. |
| `mode` | `'fail-fast' \| 'allSettled' \| 'race'` | `'fail-fast'` | Execution mode governing failure and settle handling. |
| `mergeStrategy` | `'shallow' \| 'deep' \| 'error' \| Function` | `'shallow'` | Strategy for merging branch outputs into accumulated context. |

#### Merge Strategies

1. `'shallow'` (default): `Object.assign(target, branchOutput)`.
2. `'deep'`: Recursively merges nested objects.
3. `'error'`: Throws `FieldCollisionException` if two branches output differing values for the same key.
4. `(target, source, branchKey) => merged`: Custom callback to resolve branch collisions.

#### Context Isolation

Each branch receives a deep copy of the input context. Mutating context in one branch does not bleed into sibling branches.

#### Example

```typescript
import { Step, flow, parallel } from 'rivulet';

const fetchOrders = Step.create('orders', async () => ({ orders: [1, 2, 3] }));
const fetchInvoices = Step.create('invoices', async () => ({ invoices: ['inv_1'] }));

const prepareDashboard = flow(
    parallel([fetchOrders, fetchInvoices], {
        mergeStrategy: 'deep',
        name: 'fetchDashboardData'
    })
);

const result = await prepareDashboard.run();
console.log(result.orders);   // [1, 2, 3]
console.log(result.invoices); // ['inv_1']
console.log(result.$branches.length); // 2
```

---

### `all(steps, options?)`

Convenience alias for `parallel(steps, { ...options, mode: 'fail-fast' })`.

#### Signature

```typescript
export function all(
    branches: any[],
    options?: ParallelOptions
): Step<any, any>;
```

#### Example

```typescript
import { all, Step, flow } from 'rivulet';

const step1 = Step.create('s1', async () => ({ a: 1 }));
const step2 = Step.create('s2', async () => ({ b: 2 }));

const workflow = flow(all([step1, step2]));
```

---

### `allSettled(steps, options?)`

Executes all branches concurrently without failing fast. Collects all results and errors, ensuring that every branch runs to completion or failure.

#### Signature

```typescript
export function allSettled(
    branches: any[],
    options?: ParallelOptions
): Step<any, any>;
```

#### Return Context Additions

- `$branches`: `BranchExecutionSummary[]` containing execution duration, status, output, and error for each branch.
- `$settled`: `PromiseSettledResult<any>[]` standard settled result objects.
- Each branch output or error object keyed by branch name (e.g. `result.auditStep = { error: ... }`).

#### Example

```typescript
import { Step, flow, allSettled } from 'rivulet';

const notifySlack = Step.create('slack', async () => ({ slackSent: true }));
const notifyPagerDuty = Step.create('pagerDuty', async () => {
    throw new Error('PagerDuty rate limited');
});

const alertSystem = flow(
    allSettled([notifySlack, notifyPagerDuty])
);

const result = await alertSystem.run();
console.log(result.slack.slackSent);       // true
console.log(result.pagerDuty.error.message); // 'PagerDuty rate limited'
console.log(result.$branches);
```

---

### `race(...steps)`

Executes multiple branches concurrently. Settles as soon as the **first** branch resolves or rejects. Losing branches are immediately aborted via cooperative `AbortSignal` cancellation.

#### Signature

```typescript
export function race(
    ...args: any[]
): Step<any, any>;
```

#### Example

```typescript
import { Step, flow, race } from 'rivulet';

const primaryDns = Step.create('primaryDns', async (_p, _c, _i) => {
    return { ip: '1.1.1.1', source: 'primary' };
});

const fallbackDns = Step.create('fallbackDns', async () => {
    await new Promise(r => setTimeout(r, 500));
    return { ip: '1.0.0.1', source: 'fallback' };
});

const resolveDns = flow(race([primaryDns, fallbackDns]));
const result = await resolveDns.run();
console.log(result.source); // 'primary'
```

---

## Branching & Routing

### `when(predicate, thenStep, elseStep?)`

Conditional branching combinator that evaluates a predicate function against the current context. If `true`, executes `thenStep`; otherwise executes `elseStep` (if provided).

#### Signatures

```typescript
export type BranchPredicate = (ctx: any, meta?: {
    attempt?: number;
    stackId?: string;
    namespace?: string;
}) => boolean | Promise<boolean>;

export function when(
    predicate: BranchPredicate,
    thenStep: any,
    elseStep?: any
): Step<any, any>;
```

#### Metadata

The output context is enriched with:
- `$branchSelected`: `'then'` | `'else'` | `undefined`
- `$skippedBranches`: Array of branch route names that were bypassed.
- `$skipped`: `true` if predicate evaluated to `false` and no `elseStep` was configured.

#### Example

```typescript
import { Step, flow, when } from 'rivulet';

const applyDiscount = Step.create('applyDiscount', async (ctx: { total: number }) => ({
    discount: ctx.total * 0.1
}));

const noDiscount = Step.create('noDiscount', async () => ({
    discount: 0
}));

const checkoutFlow = flow(
    when(
        (ctx) => ctx.isVipMember === true,
        applyDiscount,
        noDiscount
    )
);

const output = await checkoutFlow.run({ total: 200, isVipMember: true });
console.log(output.discount);        // 20
console.log(output.$branchSelected);  // 'then'
```

---

### `branch(selectorOrBranches, branchesMap?, defaultBranch?)`

Dynamic multi-path router that selects a branch from a map using a selector function or context key.

#### Signatures

```typescript
export type BranchSelector = (ctx: any, meta?: {
    attempt?: number;
    stackId?: string;
    namespace?: string;
}) => string | Promise<string>;

export function branch(
    selector: BranchSelector,
    branches: Record<string, any>,
    defaultBranch?: any
): Step<any, any>;

export function branch(
    branchesMap: Record<string, any>,
    defaultBranch?: any
): Step<any, any>;
```

#### Example

```typescript
import { Step, flow, branch } from 'rivulet';

const enterpriseFlow = Step.create('enterprise', async () => ({ slaTier: '24/7 Phone' }));
const standardFlow = Step.create('standard', async () => ({ slaTier: 'Email Only' }));
const defaultFlow = Step.create('community', async () => ({ slaTier: 'Forums' }));

const supportRouter = flow(
    branch(
        (ctx) => ctx.planType,
        {
            enterprise: enterpriseFlow,
            standard: standardFlow
        },
        defaultFlow // fallback
    )
);

const result = await supportRouter.run({ planType: 'enterprise' });
console.log(result.slaTier);         // '24/7 Phone'
console.log(result.$branchSelected); // 'enterprise'
```

---

## Dynamic Mapping

### `map(itemsOrAccessor, processItem, options?)`

Maps an array or async iterable through an item processing step or subflow with bounded worker concurrency, error aggregation, and order preservation.

#### Signatures

```typescript
export type MapItemAccessor =
    | any[]
    | AsyncIterable<any>
    | Iterable<any>
    | ((ctx: any) => any[] | AsyncIterable<any> | Iterable<any> | Promise<any[] | AsyncIterable<any> | Iterable<any>>);

export interface MapOptions {
    name?: string;
    concurrency?: number;     // Default: 10 (minimum: 1)
    stopOnError?: boolean;    // Default: true (fails fast and aborts workers)
    preserveOrder?: boolean;  // Default: true (results array matches input order)
}

export function map(
    itemsOrAccessor: MapItemAccessor,
    processItem: any,
    options?: MapOptions
): Step<any, any>;
```

#### Process Item Context

Inside `processItem`, the step parameter receives `{ item, index, total, ...meta }`.

#### Output

The map step outputs:
- `items`: Array of processed results.
- `count`: Total count of items.
- `errors`: Array of caught errors (when `stopOnError: false`).

#### Example

```typescript
import { Step, flow, map } from 'rivulet';

const processOrder = Step.create('processOrder', async (ctx: { item: { id: string; amount: number } }) => {
    return { processedId: ctx.item.id, charged: ctx.item.amount };
});

const batchFlow = flow(
    map((ctx) => ctx.pendingOrders, processOrder, {
        concurrency: 3,
        preserveOrder: true,
        stopOnError: true
    })
);

const result = await batchFlow.run({
    pendingOrders: [
        { id: 'ord_1', amount: 50 },
        { id: 'ord_2', amount: 120 },
        { id: 'ord_3', amount: 75 }
    ]
});

console.log(result.count); // 3
console.log(result.items); // [{ processedId: 'ord_1', charged: 50 }, ...]
```

---

## Durable Waits & Event Resumption

### `waitForEvent(eventName, options)`

Suspends workflow execution in durable mode until an external event is delivered via `resumeWorkflow()`, or an optional timeout window elapses.

#### Signature

```typescript
export interface WaitForEventOptions {
    correlationKey: string | ((ctx: any) => string);
    timeout?: string | number;   // e.g. '24h', '30m', 60000
    timeoutMs?: number;
}

export function waitForEvent(
    eventName: string,
    options: WaitForEventOptions
): Step<any, any>;
```

#### Semantics

1. When `options.durable: true`, reaching `waitForEvent` persists an execution checkpoint to storage and throws `WorkflowSuspendedException`.
2. The waiting instance is registered under `eventName` and the computed `correlationKey`.
3. If no event arrives before `timeout`, subsequent resumption throws `ExpiredWaitException`.

#### Example

```typescript
import { Step, flow, waitForEvent } from 'rivulet';

export const approvalWorkflow = flow(
    Step.create('createTicket', async (ctx: { ticketId: string }) => ({ status: 'pending' })),
    waitForEvent('managerApproval', {
        correlationKey: (ctx) => ctx.ticketId,
        timeout: '48h'
    }),
    Step.create('grantAccess', async (ctx: { approved: boolean; approver: string }) => ({
        granted: ctx.approved
    }))
);

// Starts workflow and suspends at waitForEvent
await approvalWorkflow.run({ ticketId: 'ticket_42' }, { durable: true });
```

---

### `wait(durationOrMs)`

Pauses workflow execution for a duration string (e.g. `'5m'`, `'2h'`, `'1d'`) or millisecond count. In durable mode, suspends execution to storage. In in-memory mode, pauses using a timer.

#### Signature

```typescript
export function wait(
    durationOrMs: number | string
): Step<any, any>;
```

#### Example

```typescript
import { Step, flow, wait } from 'rivulet';

const delayedWorkflow = flow(
    Step.create('init', async () => ({ step: 1 })),
    wait('10m'), // In durable mode: suspends checkpoint. In memory: awaits timeout.
    Step.create('finalize', async () => ({ step: 2 }))
);
```

---

### `resumeWorkflow(flow, key, payload?, options?)`

Restores and resumes a suspended durable workflow from storage using its correlation key or stack ID.

#### Signature

```typescript
export interface ResumeOptions extends ExecutionOptions {
    migrations?: Record<string, (state: any) => any>;
    targetVersion?: string | number;
}

export function resumeWorkflow(
    flowInstance: Flow<any, any>,
    correlationKeyOrStackId: string,
    eventPayload: any = {},
    options?: ResumeOptions
): Promise<any>;
```

#### Example

```typescript
import { resumeWorkflow } from 'rivulet';
import { approvalWorkflow } from './approval.workflow';

// Resumes the workflow where it left off, passing event payload
const finalResult = await resumeWorkflow(
    approvalWorkflow,
    'ticket_42',
    { approved: true, approver: 'Alice' }
);

console.log(finalResult.granted); // true
```

---

## Graph Inspection & Visualization

### `toGraph(item)`

Compiles any step, flow, or combinator into a JSON-serializable `WorkflowNode` AST.

#### Signature

```typescript
export function toGraph(item: any): WorkflowNode;
```

#### Node Types (`WorkflowNodeType`)

- `'step'`: Single step execution unit.
- `'sequence'`: Sequential chain (`Flow`).
- `'parallel'`: Concurrent fan-out.
- `'branch'`: Conditional or multi-path router.
- `'wait'`: Durable wait or event suspension.
- `'map'`: Dynamic array/iterable mapping.

---

### `inspectGraph(item)`

Analyzes workflow AST topology and returns structural metrics including node count, depth, and directed edges.

#### Signature

```typescript
export interface GraphInspectionResult {
    nodeCount: number;
    depth: number;
    edges: GraphInspectionEdge[];
    types: Record<string, number>;
}

export function inspectGraph(item: any): GraphInspectionResult;
```

#### Example

```typescript
import { inspectGraph } from 'rivulet';
import { authFlow } from './auth';

const metrics = inspectGraph(authFlow);
console.log(`Nodes: ${metrics.nodeCount}, Max Depth: ${metrics.depth}`);
```

---

### `validateGraph(node)` and `assertValidGraph(node)`

Validates graph structure, checking for cycles and unreachable nodes.

#### Signatures

```typescript
export interface GraphValidationResult {
    valid: boolean;
    errors: string[];
}

export function validateGraph(node: WorkflowNode | Flow | Step): GraphValidationResult;
export function assertValidGraph(node: WorkflowNode | Flow | Step): void; // Throws GraphValidationException
```

---

### `toMermaid(item, options?)`

Renders workflow structure as a Mermaid flowchart diagram with policy badges (e.g. `[⏱️ 3000ms]`, `[🔁 retry(3)]`, `[⏪ saga]`).

#### Signature

```typescript
export interface MermaidExportOptions {
    direction?: 'TD' | 'LR';
    theme?: string;
}

export function toMermaid(item: any, options?: MermaidExportOptions): string;
```

#### Example

```typescript
import { toMermaid } from 'rivulet';
import { myWorkflow } from './pipeline';

const diagram = toMermaid(myWorkflow, { direction: 'TD' });
console.log(diagram);
```

---

### `toDot(item, options?)` and `toJSON(item)`

- `toDot(item, options?)`: Exports Graphviz DOT representation (`options.graphName`).
- `toJSON(item)`: Serializes the entire workflow AST into a clean JSON string.

---

## Related Topic Guides

- [02. Core Concepts](../02-core-concepts.md)
- [03. Sequential Workflows](../03-sequential-workflows.md)
- [04. Branching and Parallelism](../04-branching-and-parallelism.md)
- [06. Durable Workflows](../06-durable-workflows.md)
- [08. Observability & Diagrams](../08-observability.md)
