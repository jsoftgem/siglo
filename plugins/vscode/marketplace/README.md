# Siglo Workflow Explorer listing assets

| Field | Value |
| --- | --- |
| Display name | Siglo Workflow Explorer |
| Installed extension ID | `jsoftgem.siglo-workflow-explorer` |
| Publisher | `jsoftgem` |
| Version | Defined in `../package.json` (currently `1.2.2`) |
| VS Code target | `^1.90.0` |
| License | MIT |

**Short summary:** Visualize Siglo workflows, inspect step contracts and settings, and navigate between graphs and source.

## Description and setup

The extension's [README](../README.md) supplies its Marketplace description and is included in the VSIX together with these assets. It covers features, screenshots, installation, commands, requirements, and static-analysis limitations. The short description and search keywords are defined in [package.json](../package.json).

Packaging rewrites README links and image URLs to the repository's `plugins/vscode` directory. Push these files to the repository before publishing so those hosted images and links are available.

Install the VSIX, open a trusted workspace, then run **Siglo: Open Workflow Visualizer** with a workflow source file open. Use **Siglo: Discover Workspace Workflows** to choose a workflow across workspace folders. The analyzer is bundled with the extension and uses the extension host runtime; users do not need a separate Node.js installation or analyzer package.

Desktop and remote workspace hosts are supported targets. Browser-only VS Code and virtual workspaces are unsupported. See the main README for the scope of completed verification.

## Screenshots and captions

The PNGs capture the extension's actual bundled webview in headless Chrome. Their data comes from static analysis of [demo.workflow.ts](demo.workflow.ts), which is never executed. They show the shared UI without surrounding VS Code editor chrome and do not demonstrate host navigation or runtime execution.

| File | Suggested caption |
| --- | --- |
| [01-workflow-graph.png](screenshots/01-workflow-graph.png) | Explore parallel workflow paths and inspect a payment step's declared retries and timeout. |
| [02-step-input-contracts.png](screenshots/02-step-input-contracts.png) | Inspect required inputs, transforms, default values, and validation rules from source. |
| [03-workflow-settings.png](screenshots/03-workflow-settings.png) | Review workflow deadlines, schema versions, and allowed network hosts. |
| [04-all-workflows.png](screenshots/04-all-workflows.png) | Compare multiple workflows from the same file in the All Flows view. |

Images are 1440 × 1080 pixels. Use the order above when preparing the listing. Adding or packaging these assets does not publish the extension.

## Regenerate the captures

From the repository root, with workspace dependencies installed:

```sh
npm run screenshots --workspace=@siglo/vscode
```

This builds the extension and shared packages, then runs the shared capture script at `plugins/intellij/marketplace/scripts/capture.mjs` with the `vscode` argument. The script loads `plugins/vscode/dist/index.html`, uses this directory's fixture, and saves images here.

The capture script requires Node.js 22+ and defaults to Google Chrome's macOS application path. Set `CHROME_BIN` to a Chrome or Chromium executable on other platforms. It uses a temporary browser profile and removes it after capture.

For an additional screenshot demonstrating editor integration, install the VSIX, open `demo.workflow.ts`, run **Siglo: Open Workflow Visualizer**, and select `authorizePayment`. Capture the editor and visualizer together with the selected definition visible.
