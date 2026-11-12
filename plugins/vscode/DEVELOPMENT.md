# Developing Siglo Workflows

## Build and package

From the repository root (Node.js version per the root package manifest):

```sh
npm install
npm test --workspace=@siglo/vscode
npm run package --workspace=@siglo/vscode
```

Output: `plugins/vscode/siglo-workflows-1.2.3.vsix`.

The root explicitly registers `plugins/vscode` as an npm workspace. The build bundles the extension host and analyzer (including TypeScript) and copies the shared single-file HTML UI. Installation needs neither a separate Node executable nor workspace npm dependencies. The analyzer runs using the extension host executable in Node mode, also on remote hosts.

The npm workspace retains the name `@siglo/vscode`. Packaging stages an unscoped VS Code manifest (`siglo-workflows`) in a temporary directory because VS Code rejects scoped names. The installed extension ID is `Jsoftgem.siglo-workflows`.

### Marketplace Publishing

- **Visual Studio Marketplace**: Run the build and package command above, then upload `plugins/vscode/siglo-workflows-1.2.3.vsix` in the Marketplace publisher portal under **Jsoftgem**. The source manifest and generated VSIX must both declare `Jsoftgem` as the publisher. Upload the generated archive so it uses the staged, unscoped extension name.
- **Open VSX Registry**:
  ```sh
  npm run publish:ovsx --workspace=@siglo/vscode
  ```

For local debugging, extract the VSIX into a temporary directory and launch its `extension` subdirectory as an Extension Development Host using VS Code's `--extensionDevelopmentPath` flag. Use the staged, unscoped manifest rather than the scoped npm source manifest.

## Lifecycle and security

The client uses newline-delimited JSON-RPC, monotonic request IDs, concurrent request correlation, a 10-second timeout, and automatic restart with exponential backoff (500 ms to 30 seconds). Failed in-flight requests are rejected; recovery refreshes the active document. Deactivation sends `siglo/shutdown`, with a forced-exit fallback.

Workspace trust is checked before launching the analyzer or scanning files. Only the bundled analyzer is used, with `NODE_OPTIONS` and `NODE_PATH` cleared. No workspace scripts or dependency executables are launched. Incoming card clicks are resolved against current host graph IDs and revisions; supplied locations are ignored. Edit responses are discarded when their editor, revision, or request generation is stale.

The webview disallows local resources and network connections. Scripts and style elements use per-view CSP nonces. `style-src-attr 'unsafe-inline'` permits React's calculated node positions; script execution remains nonce restricted. These controls follow the [VS Code webview guide](https://code.visualstudio.com/api/extension-guides/webview) and [workspace trust guide](https://code.visualstudio.com/api/extension-guides/workspace-trust).

## Verification

Run `npm test --workspace=@siglo/vscode` from the repository root. The tests cover analyzer communication, restart and disposal, navigation, live edits, diagnostics, telemetry import, and manual reload. The shared analyzer fixture suite covers supported workflow syntax.

For a host smoke test, install the generated VSIX in VS Code, open a trusted project with a Siglo workflow, and verify the graph, source navigation, diagnostics, and telemetry import.

See [Marketplace listing assets](marketplace/README.md) for screenshot captions and capture instructions. The user-facing [README](README.md) supplies the Marketplace overview; keep build details, publishing instructions, and implementation notes in this document.
