# IDE step execution

The IntelliJ and VS Code visualizers share the **Run** tab in the right panel. Select one step, or Ctrl/Cmd-click multiple steps to run the inclusive sequential range between them. Selecting 2 and 4 runs 2, 3, 4 in execution order. The highlighted path previews the range. Choose a single workflow instead of All Flows before running.

Enter JSON as the first selected step's input. Run executes real project code, including external integrations. Earlier steps are not executed and their history is not reconstructed. Normal runtime input propagation, specs, retries, timeouts, fallback, and compensation apply only to the selected subset. Cancel aborts the run and terminates its process if necessary; it cannot undo completed external effects.

The output panel defaults to the final step's resolved output, with intermediate completed outputs available in its dropdown. Pretty and Raw JSON differ only in whitespace. Application logs and failures are displayed separately. Input remains in memory per workflow for the panel session; results are marked stale after a source revision or workflow change.

## Project setup

- Use a trusted project and save modified source files before running.
- Export the workflow as a named export, an aliased local export, or `export default workflow`.
- Install the updated `@siglo/core` runtime containing non-serialized graph step references and `ExecutionOptions.onStepResult`. Older runtimes are rejected before selected step actions run.
- Install `tsx` in the project for TypeScript source or setup modules. It resolves project dependencies and tsconfig options. JavaScript-only workflows can run without it.
- IntelliJ needs a discoverable Node executable; VS Code uses its extension host's Node executable. IntelliJ's native tree fallback does not support execution.

Optional `.siglo/run.json` at the IDE workspace/project root:

```json
{
  "cwd": ".",
  "setupModule": "./dev/setup.ts",
  "env": { "APP_ENV": "development" }
}
```

`cwd` is relative to the workspace/project root; `setupModule` is relative to that working directory. Environment overrides merge with the IDE process environment. The setup module runs before importing the workflow; ordinary module import side effects still apply. With no configuration, the workspace/project root is the working directory.

Only statically resolved workflows can run. Selections cannot cross branch/parallel/map boundaries or include synthetic graph hubs. Individual nested steps and sequential ranges within a branch are supported when the runtime structure matches the analyzer. Dynamic or duplicate/ambiguous structures fail with an explanation. This feature does not run composite groups, persist run history, or configure mocks.

## Development

`npm run test:ide-runner` builds the runtime and VS Code bundle, then runs process-level integration tests. `node packages/ide-runner/build.mjs` builds IntelliJ execution resources and copies the built UI; Gradle calls it during resource processing. Build shared protocol/UI first when changing them.

The supervisor owns the worker and uses newline JSON over stdin/stdout for host communication. The worker uses Node IPC for results; its stdout/stderr become log events. Source parsing and range validation happen before importing application code. Each run gets a fresh worker. The core `onStepResult` callback exposes resolved, unredacted local data after after-hooks; it is separate from the redacted monitoring API.
