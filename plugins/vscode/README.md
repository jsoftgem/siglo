# Siglo Workflow Explorer for VS Code

Read-only workflow exploration, static diagnostics, and ecosystem step inspection for VS Code 1.90+ on desktop and remote workspace hosts. Uses the same `@siglo/ide-protocol`, zero-execution `@siglo/ide-analysis`, and React/SVG `@siglo/ide-ui` as the IntelliJ plugin. Requires workspace trust. Browser-only VS Code and virtual workspaces are unsupported.

## Getting started

1. [Install the extension from VSIX](#install-in-vs-code), then open and trust your project folder.
2. Open an existing Siglo workflow, or save the example below as `hello.workflow.ts` in your project. For a project that will run the example, install the runtime with `npm install @siglo/core`; the visualizer itself can analyze the file without installing or running the application.
3. Open the Command Palette and run **Siglo: Open Workflow Visualizer**, or press `⌥⌘V` (macOS) / `Ctrl+Alt+V` (Linux/Windows). You should see `helloWorkflow` with two connected steps: `greet` and `formatMessage`.
4. Click `greet` to inspect its required `name` input and navigate to its definition. Change `.timeout(1000)` to `.timeout(2000)` and watch the graph update with **Auto-Reload** enabled.

```ts
import { Step, flow } from '@siglo/core';

const greet = Step.create('greet', async (input: { name: string }) => ({
  message: `Hello, ${input.name}!`,
})).spec('name', { require: true }).timeout(1000);

const formatMessage = Step.create('formatMessage', async (input: { message: string }) => ({
  message: input.message.toUpperCase(),
}));

export const helloWorkflow = flow(greet, formatMessage);
```

For the workflows shown in the screenshots, open [demo.workflow.ts](marketplace/demo.workflow.ts) and choose **All Flows**. If the graph does not appear, confirm workspace trust, click **Reload**, and inspect **Output → Siglo**.

## Features

- **Visual workflow graphs:** Follow sequential steps, parallel forks and joins, conditional branches, races, compensation paths, and fallbacks. Switch between workflows in a file or compare them with **All Flows**.
- **Static code diagnostics:** Surfaces static analysis diagnostics directly in the VS Code editor via `DiagnosticCollection`. Flags topological cycles (`SIGLO_STATIC_CYCLE`), missing compensations for sagas with side-effect steps (`SIGLO_MISSING_COMPENSATION`), unhandled durable error branches (`SIGLO_UNHANDLED_ERROR_BRANCH`), and duplicate step IDs (`SIGLO_DUPLICATE_STEP_ID`).
- **Ecosystem deep-dive inspectors:** Dedicated step inspector cards for HTTP, AI, Notification, and Crypto steps, displaying statically resolvable configurations fail-closed without importing or executing application modules.
- **Offline telemetry recording import:** Import local `.json` telemetry documents via **Siglo: Import Telemetry Recording...** or the webview toolbar to inspect recorded runtime status, HTTP latencies, crypto verification categories, notification payloads, and AI token metrics with fail-closed secret redaction.
- **Step inspection:** Review declared retries, timeouts, compensation, and source coordinates. Inspect input contracts from `.spec(...)` and `.schema(...)`, including required fields, defaults, validators, transforms, and schemas.
- **Workflow settings:** Inspect workflow deadlines, schema versions, network policies, and monitor expressions.
- **Source navigation:** Click graph steps to open their definitions, and move the editor cursor into a step to highlight it in the graph.
- **Live editing:** Follow the active source file, refresh after edits, and control automatic or manual reload independently in each view.
- **Flexible views:** Open the visualizer beside your code or in the Siglo sidebar. Discover workflows across workspace folders from the Command Palette.
- **Static analysis:** Understand declared workflow structure without importing or executing application code. Dynamic expressions remain labeled as unresolved; analysis never connects to live runtime monitors.

## Screenshots

These captures show the extension's actual bundled webview using a statically analyzed example workflow. They exclude the surrounding VS Code editor.

### Workflow graph and step settings

Explore parallel paths and inspect a payment step's declared retries, timeout, and source coordinates.

![Workflow graph with a payment step selected](marketplace/screenshots/01-workflow-graph.png)

### Input contracts

Review required inputs, transforms, defaults, and validation rules extracted from step definitions.

![Step inspector showing structured input contracts](marketplace/screenshots/02-step-input-contracts.png)

### Workflow settings

Inspect the workflow deadline, schema version, and allowed network hosts.

![Workflow inspector showing execution defaults and network policy](marketplace/screenshots/03-workflow-settings.png)

### Multiple workflows

Compare workflows from the same source file with **All Flows**.

![All Flows view showing checkout and receipt workflows](marketplace/screenshots/04-all-workflows.png)

### Ecosystem telemetry & offline recordings

Inspect recorded runtime metrics, retry attempts, HTTP latencies, crypto verification categories, notification payloads, and AI token usages from imported offline recordings with fail-closed sanitization.

![Ecosystem telemetry inspector showing execution details](marketplace/screenshots/05-ecosystem-telemetry.png)

See [Marketplace listing assets](marketplace/README.md) for listing details, screenshot captions, and capture instructions.

## Requirements

- VS Code 1.90 or newer on a desktop or remote workspace host.
- A trusted workspace containing JavaScript or TypeScript Siglo workflow source.
- The installed extension includes its analyzer and UI. Users do not need a separate Node.js installation or workspace npm dependencies for analysis.

Browser-only VS Code and virtual workspaces are unsupported. Building from source requires the Node.js version declared in the repository root manifest.

## Install in VS Code

Use the generated archive at `plugins/vscode/siglo-workflow-explorer-1.2.3.vsix`. If it is missing, follow [Build and package](#build-and-package) first.

1. Open VS Code's **Extensions** view (`Cmd+Shift+X` on macOS; `Ctrl+Shift+X` on Windows/Linux).
2. Click **…** in the Extensions view, then select **Install from VSIX…**.
3. Select `siglo-workflow-explorer-1.2.3.vsix` from this repository's `plugins/vscode` directory.
4. Reload VS Code if prompted.
5. Open your project folder and trust the workspace to enable workflow analysis.

## Open and use the visualizer

1. Open a JavaScript or TypeScript file containing a Siglo workflow.
2. Open the Command Palette (`Cmd+Shift+P` on macOS; `Ctrl+Shift+P` on Windows/Linux) and run **Siglo: Open Workflow Visualizer**, or press `⌥⌘V` (macOS) / `Ctrl+Alt+V` (Linux/Windows). This opens the graph in an editor panel. For the sidebar, select the **Siglo** activity bar icon and open **Siglo Workflows**.
3. Click a step to navigate to its source. Move the editor cursor into a step to highlight it. Edits refresh the graph after 250 ms; each view has its own **Auto-Reload** toggle and **Reload** button.
4. Run **Siglo: Discover Workspace Workflows** from the Command Palette to choose a workflow across workspace folders. Scans at most 100 source files, excluding `node_modules`, `dist`, `.git`, `coverage`, `build`, and `.idea`. The scan honors unsaved content in open documents and can be cancelled.
5. Run **Siglo: Import Telemetry Recording...** or click **Import Telemetry** in the visualizer toolbar to load an offline `.json` recording and populate runtime fields on matching workflow nodes.

Workflow exploration, static diagnostics, and ecosystem inspectors work entirely offline without connecting to live runtime monitors. Optional local telemetry recordings can be imported to populate runtime inspection fields with fail-closed sanitization.

### Contributed Commands & Shortcuts

| Command | Title | Default Shortcut |
| --- | --- | --- |
| `siglo.openVisualizer` | **Siglo: Open Workflow Visualizer** | `⌥⌘V` (macOS) / `Ctrl+Alt+V` (Linux/Win) |
| `siglo.discoverWorkflows` | **Siglo: Discover Workspace Workflows** | Command Palette |
| `siglo.importTelemetry` | **Siglo: Import Telemetry Recording...** | Command Palette / Webview Action |

## Build and package

From the repository root (Node.js version per the root package manifest):

```sh
npm install
npm test --workspace=@siglo/vscode
npm run package --workspace=@siglo/vscode
```

Output: `plugins/vscode/siglo-workflow-explorer-1.2.3.vsix`.

The root explicitly registers `plugins/vscode` as an npm workspace. The build bundles the extension host and analyzer (including TypeScript) and copies the shared single-file HTML UI. Installation needs neither a separate Node executable nor workspace npm dependencies. The analyzer runs using the extension host executable in Node mode, also on remote hosts.

The npm workspace retains the name `@siglo/vscode`. Packaging stages an unscoped VS Code manifest (`siglo-workflow-explorer`) in a temporary directory because VS Code rejects scoped names. The installed extension ID is `jsoftgem.siglo-workflow-explorer`.

### Marketplace Publishing

- **Visual Studio Marketplace**:
  ```sh
  npm run publish:vsce --workspace=@siglo/vscode
  ```
- **Open VSX Registry**:
  ```sh
  npm run publish:ovsx --workspace=@siglo/vscode
  ```

For local debugging, extract the VSIX into a temporary directory and launch its `extension` subdirectory as an Extension Development Host using VS Code's `--extensionDevelopmentPath` flag. Use the staged, unscoped manifest rather than the scoped npm source manifest.

## Lifecycle and security

The client uses newline-delimited JSON-RPC, monotonic request IDs, concurrent request correlation, a 10-second timeout, and automatic restart with exponential backoff (500 ms to 30 seconds). Failed in-flight requests are rejected; recovery refreshes the active document. Deactivation sends `siglo/shutdown`, with a forced-exit fallback.

Workspace trust is checked before launching the analyzer or scanning files. Only the bundled analyzer is used, with `NODE_OPTIONS` and `NODE_PATH` cleared. No workspace scripts or dependency executables are launched. Incoming card clicks are resolved against current host graph IDs and revisions; supplied locations are ignored. Edit responses are discarded when their editor, revision, or request generation is stale.

The webview disallows local resources and network connections. Scripts and style elements use per-view CSP nonces. `style-src-attr 'unsafe-inline'` permits React's calculated node positions; script execution remains nonce restricted. These controls follow the [VS Code webview guide](https://code.visualstudio.com/api/extension-guides/webview) and [workspace trust guide](https://code.visualstudio.com/api/extension-guides/workspace-trust).

## Verification and limitations

Automated tests exercise the packaged analyzer through the real stdio client, including trust gating, concurrent requests, RPC errors, restart, disposal, and 1,000 edit cycles with sampled RSS. Host tests use a VS Code API mock to verify ready messages, navigation, live edits, tab switching, static diagnostic mapping, telemetry import, and manual reload. The shared analyzer fixture suite remains the source of syntax coverage.

All extension tests pass (9 passing unit tests), including static diagnostics and telemetry import verification, and a regression check that CSP injection leaves the actual bundled JavaScript unchanged and syntactically valid. A targeted smoke test in an isolated macOS VS Code Extension Development Host confirmed that the packaged extension starts the analyzer and renders all five steps in `usecase-2-ai-rag-pipeline.ts`.

If analysis fails, inspect **Output → Siglo**. Trust the workspace if analysis is blocked. On failure, the last graph remains visible; manual Reload retries analysis. A scan covers only its first 100 matching files; open a source file directly to inspect workflows outside that limit.
