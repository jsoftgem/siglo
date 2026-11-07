---
title: "Workflow Graph Model"
description: "Declarative workflow AST, pure JSON-serializable node hierarchy, cycle validation, and inspector API in Siglo."
---

# Workflow Graph Model

`Siglo` v1.0.0 features an internal, declarative Workflow Graph Model. The graph model cleanly separates workflow structure from runtime execution state, providing inspection, static validation, and tooling capabilities without breaking the sequential `flow(...)` API.

---

## 1. Graph Node Hierarchy

All workflow entities are representable as pure JSON-serializable `WorkflowNode` data structures:

```typescript
type WorkflowNode =
  | StepNode
  | SequenceNode
  | ParallelNode
  | BranchNode
  | WaitNode
  | MapNode;
```

### Node Types

1. **`StepNode` (`type: 'step'`)**
   - Represents an atomic unit of execution.
   - Contains: `id`, `name`, optional `metadata` (e.g. `reducer`, `isStrict`, `timeoutMs`, `cachedLast`).

2. **`SequenceNode` (`type: 'sequence'`)**
   - Represents linear steps executed sequentially.
   - Contains: `id`, `name`, and an ordered list of `children: WorkflowNode[]`.

3. **`ParallelNode` (`type: 'parallel'`)**
   - Represents concurrent branches.
   - Contains: `id`, `name`, `branches: WorkflowNode[]`, `mode` (`'fail-fast' | 'allSettled' | 'race'`), and `mergeStrategy`.

4. **`BranchNode` (`type: 'branch'`)**
   - Represents conditional control flow.
   - Contains: `id`, `name`, `branches: Record<string, WorkflowNode>`, selector function, and optional `defaultBranch`.

5. **`WaitNode` (`type: 'wait'`)**
   - Represents an asynchronous pause (timer or external event).
   - Contains: `id`, `name`, optional `eventName`, `correlationKey`, `durationMs`, and `timeoutMs`.

6. **`MapNode` (`type: 'map'`)**
   - Represents controlled iteration with bounded concurrency.
   - Contains: `id`, `name`, `itemNode: WorkflowNode`, `concurrency`, `stopOnError`, and `preserveOrder`.

---

## 2. Converting Workflows to Graphs (`toGraph`)

Any `Step`, `Flow`, nested array, function, or combinator can be converted to a `WorkflowNode`:

```typescript
import { Step, flow, parallel, toGraph } from '@siglo/core';

const workflow = flow(
  Step.create('validate'),
  parallel(
    Step.create('inventory'),
    Step.create('payment')
  ),
  Step.create('ship')
);

// Convert via standalone utility or instance method
const graph = toGraph(workflow);
// Or via instance method / property:
const graphInstance = workflow.toGraph();
const ast = workflow.ast;
```

The resulting AST is consumed directly by developer tooling:
- **`@siglo/monitor`**: Renders real-time execution DAGs, active node highlights, and duration heatmaps.
- **`@siglo/cli`**: Produces terminal and SVG visualizations via `siglo visualize <workflow>`.

---

## 3. Graph Validation (`validateGraph`, `assertValidGraph`)

Graph validation detects structural defects, missing identifiers, empty branches, or cyclic dependencies prior to execution. Note that `flow.run()` does not validate graphs automatically at runtime; validation is an explicit static check:

```typescript
import { validateGraph, assertValidGraph, GraphValidationException } from '@siglo/core';

const result = validateGraph(graph);

if (!result.valid) {
  console.error('Graph validation errors:', result.errors);
}

// Or throw GraphValidationException on failure:
assertValidGraph(graph);
```

### Validation Rules
- Every node must possess a valid string `id` and recognized `type`.
- `sequence` nodes must have at least one child.
- `parallel` nodes must have at least one branch.
- `branch` nodes must have at least one branch target.
- `wait` nodes must declare either a timer duration or an `eventName` and `correlationKey`.
- `map` nodes must specify an `itemNode` and a positive `concurrency` value ($> 0$).
- Cycles in the graph are detected and rejected.

---

## 4. Graph Inspection API (`inspectGraph`)

For visualization, developer tools, and analytics, `inspectGraph` produces a flattened summary with nodes, directed edges, entry points, and terminal exits:

```typescript
import { inspectGraph } from '@siglo/core';

const inspection = inspectGraph(workflow);
// Or: workflow.inspect();

console.log('Total nodes:', inspection.totalNodes);
console.log('Entry node:', inspection.entryNodeId);
console.log('Exit nodes:', inspection.exitNodeIds);
console.log('Directed edges:', inspection.edges);
```

Each edge in `inspection.edges` specifies `from`, `to`, and an optional human-readable `label` (e.g., `'when:then'`, `'when:else'`, `'branch:credit_card'`).
