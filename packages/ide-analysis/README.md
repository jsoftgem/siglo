# @siglo/ide-analysis

Static TypeScript workflow analysis and a JSON-RPC service for Siglo IDE extensions. Discovers workflow definitions and produces workflow graphs without executing application code.

## Installation

Install the analysis service when building a Siglo IDE integration:

```bash
npm install @siglo/ide-analysis
```

Start the JSON-RPC service over standard input and output:

```bash
npx siglo-ide-analysis
```

## Static step coverage

The package scan covers the step-producing exports in `core`, `http`, `ai`,
`notifications`, and `crypto`:

| Package          | Supported forms                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| core             | `Step.create`, `new Step`, compatibility `Func`/`Chain` constructors and `.create`, inline actions                             |
| core composition | `flow`, `pipe`, `Step.flow`, `Step.pipe`, nested flows, sequential arrays                                                      |
| core combinators | `parallel`, `all`, `allSettled`, `race`, `branch`, `when`, `map`, including corresponding `Step`/`Func`/`Chain` static helpers |
| core durable     | `wait`, `waitForEvent`, including static helpers                                                                               |
| http             | `httpStep`, `new HttpStep`                                                                                                     |
| ai               | `aiStep`, `new AiStep`                                                                                                         |
| notifications    | `sendNotificationStep`, `sendInteractiveApprovalStep`                                                                          |
| crypto           | `verifyWebhookStep`, `encryptFieldsStep`, `decryptFieldsStep`, `maskFieldsStep`, and their exported constructors               |

The inspector receives static operational properties, including HTTP retries,
map concurrency, parallel mode/merge strategy, wait duration/event timeout, and
crypto field paths. Fluent timeout, compensation, cache, validation, hooks,
network policy, and idempotency configuration is recognized. Source expressions
are displayed without execution. Runtime collections are represented by a map
body rather than expanded into an invented number of items.

Queue consumers, web framework integrations, scheduler dispatchers, storage
adapters, monitoring, and testing helpers are integrations, not additional graph
step factories.

The parser remains syntax-based: arbitrary factory execution, imported step
implementations, renamed imports, dynamic branch maps, and runtime configuration
values are not resolved. Standalone assignment statements that mutate a step
are not folded into its declaration configuration.

### Workflow properties

Workflow summaries and the active graph document carry declared flow properties
for `.timeout(...)`, `.version(...)`, `.networkPolicy(...)`, and `.monitor(...)`.
Chained configuration and separate calls on known local flow variables are
recognized in source order. Step configuration stays separate, and composed
flows do not inherit a nested flow's declared execution defaults. Runtime
`.run(...)` options are not reported as declared defaults.

Click a workflow label in the canvas to inspect its deadline, schema version,
network perimeter, monitor, and graph nodes. Dynamic settings remain source
expressions. The header's `r` value is a source document revision; schema
versions appear in workflow badges and the workflow inspector.
