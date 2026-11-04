# Siglo Workflow Explorer for VS Code

Read-only workflow exploration for VS Code 1.90+ on desktop and remote workspace hosts. Uses the same `@siglo/ide-protocol`, zero-execution `@siglo/ide-analysis`, and React/SVG `@siglo/ide-ui` as the IntelliJ plugin. Requires workspace trust. Browser-only VS Code and virtual workspaces are unsupported.

## Install in VS Code

Use the generated archive at `plugins/vscode/siglo-workflow-explorer-1.0.0.vsix`. If it is missing, follow [Build and package](#build-and-package) first.

1. Open VS Code's **Extensions** view (`Cmd+Shift+X` on macOS; `Ctrl+Shift+X` on Windows/Linux).
2. Click **…** in the Extensions view, then select **Install from VSIX…**.
3. Select `siglo-workflow-explorer-1.0.0.vsix` from this repository's `plugins/vscode` directory.
4. Reload VS Code if prompted.
5. Open your project folder and trust the workspace to enable workflow analysis.

## Open and use the visualizer

1. Open a JavaScript or TypeScript file containing a Siglo workflow.
2. Open the Command Palette (`Cmd+Shift+P` on macOS; `Ctrl+Shift+P` on Windows/Linux) and run **Siglo: Open Workflow Visualizer**. This opens the graph in an editor panel. For the sidebar, select the **Siglo** activity bar icon and open **Siglo Workflows**.
3. Click a step to navigate to its source. Move the editor cursor into a step to highlight it. Edits refresh the graph after 250 ms; each view has its own **Auto-Reload** toggle and **Reload** button.
4. Run **Siglo: Discover Workspace Workflows** from the Command Palette to choose a workflow across workspace folders. Scans at most 100 source files, excluding `node_modules`, `dist`, `.git`, `coverage`, `build`, and `.idea`. The scan honors unsaved content in open documents and can be cancelled.

The shared renderer supports multi-flow canvases, fork/join combinators, unresolved dynamic expressions, ecosystem steps, structured input specs, and workflow properties. Analysis never imports or executes the application. The initial release does not execute workflows, connect to runtime monitors, or provide authoring diagnostics.

## Build and package

From the repository root (Node.js version per the root package manifest):

```sh
npm install
npm test --workspace=@siglo/vscode
npm run package --workspace=@siglo/vscode
```

Output: `plugins/vscode/siglo-workflow-explorer-1.0.0.vsix`.

The root explicitly registers `plugins/vscode` as an npm workspace. The build bundles the extension host and analyzer (including TypeScript) and copies the shared single-file HTML UI. Installation needs neither a separate Node executable nor workspace npm dependencies. The analyzer runs using the extension host executable in Node mode, also on remote hosts.

The npm workspace retains the name `@siglo/vscode`. Packaging stages an unscoped VS Code manifest (`siglo-workflow-explorer`) in a temporary directory because VS Code rejects scoped names. The installed extension ID is `jsoftgem.siglo-workflow-explorer`; no publishing is performed.

For local debugging, extract the VSIX into a temporary directory and launch its `extension` subdirectory as an Extension Development Host using VS Code's `--extensionDevelopmentPath` flag. Use the staged, unscoped manifest rather than the scoped npm source manifest.

## Lifecycle and security

The client uses newline-delimited JSON-RPC, monotonic request IDs, concurrent request correlation, a 10-second timeout, and automatic restart with exponential backoff (500 ms to 30 seconds). Failed in-flight requests are rejected; recovery refreshes the active document. Deactivation sends `siglo/shutdown`, with a forced-exit fallback.

Workspace trust is checked before launching the analyzer or scanning files. Only the bundled analyzer is used, with `NODE_OPTIONS` and `NODE_PATH` cleared. No workspace scripts or dependency executables are launched. Incoming card clicks are resolved against current host graph IDs and revisions; supplied locations are ignored. Edit responses are discarded when their editor, revision, or request generation is stale.

The webview disallows local resources and network connections. Scripts and style elements use per-view CSP nonces. `style-src-attr 'unsafe-inline'` permits React's calculated node positions; script execution remains nonce restricted. These controls follow the [VS Code webview guide](https://code.visualstudio.com/api/extension-guides/webview) and [workspace trust guide](https://code.visualstudio.com/api/extension-guides/workspace-trust).

## Verification and limitations

Automated tests exercise the packaged analyzer through the real stdio client, including trust gating, concurrent requests, RPC errors, restart, disposal, and 1,000 edit cycles with sampled RSS. Host tests use a VS Code API mock to verify ready messages, navigation, live edits, tab switching, and manual reload. The shared analyzer fixture suite remains the source of syntax coverage.

All 10 extension tests pass, including a regression check that CSP injection leaves the actual bundled JavaScript unchanged and syntactically valid. A targeted smoke test in an isolated macOS VS Code Extension Development Host confirmed that the packaged extension starts the analyzer and renders all five steps in `usecase-2-ai-rag-pipeline.ts`.

Full manual verification of navigation, trust transitions, sidebar layout, crash recovery, other operating systems, and remote hosts remains pending before declaring M0/M1 manually verified. RSS samples are environment dependent and currently tested with a small workflow, not a maximum-size graph. There is no cross-platform RSS watchdog yet.

### Blank visualizer after installing an earlier VSIX

An earlier 1.0.0 archive incorrectly inserted CSP nonces into tag-like strings inside React's bundled JavaScript, preventing the UI from starting. The rebuilt archive preserves script contents. Reinstall the current `plugins/vscode/siglo-workflow-explorer-1.0.0.vsix` using **Install from VSIX…**, then run **Developer: Reload Window** from the Command Palette to load the fix. The archive version remains 1.0.0.

If analysis fails, inspect **Output → Siglo Workflow Explorer**. Trust the workspace if analysis is blocked. On failure, the last graph remains visible; manual Reload retries analysis. A scan covers only its first 100 matching files; open a source file directly to inspect workflows outside that limit.
