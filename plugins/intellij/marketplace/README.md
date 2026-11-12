# Siglo Workflows listing assets

**Plugin name:** Siglo Workflows

**Plugin ID:** `io.siglo.idea`

**Vendor:** Siglo

**Version:** Defined in `../build.gradle.kts` (currently `1.2.3`).

**Short summary:** Visualize Siglo workflows, inspect step contracts and settings, and jump from graph nodes to source in IntelliJ IDEA.

## Description

[description.html](description.html) contains the listing copy and supplies the description embedded in the built plugin. It covers features, requirements, setup, and the limits of static analysis.

The plugin targets IntelliJ Platform build 241+ and uses a separately available Node.js analyzer. This is a declared compatibility target; it does not imply that every later IDE release or operating system has been verified.

## Screenshots and captions

These PNGs capture the plugin's actual bundled webview in headless Chrome, with graph data produced by the static analyzer from [demo.workflow.ts](demo.workflow.ts). They show the embedded UI, without the surrounding IntelliJ editor. They do not demonstrate IDE source navigation or live execution.

| File | Suggested caption |
| --- | --- |
| [01-workflow-graph.png](screenshots/01-workflow-graph.png) | Explore parallel workflow paths and inspect a payment step's declared retries and timeout. |
| [02-step-input-contracts.png](screenshots/02-step-input-contracts.png) | Inspect required inputs, transforms, default values, and validation rules from source. |
| [03-workflow-settings.png](screenshots/03-workflow-settings.png) | Review workflow deadlines, schema versions, and allowed network hosts. |
| [04-all-workflows.png](screenshots/04-all-workflows.png) | Compare multiple workflows from the same file in the All Flows view. |
| [05-ecosystem-telemetry.png](screenshots/05-ecosystem-telemetry.png) | Inspect runtime telemetry with imported offline recordings (HTTP, Crypto, Notifications, AI) and fail-closed sanitization. |

Images are 1440 × 1080 pixels. Upload them in the order above when preparing the Marketplace listing. No listing has been published by adding these files.

## Regenerate the captures

From the repository root, with workspace dependencies already installed:

```sh
npm run build --workspace=@siglo/ide-protocol
npm run build --workspace=@siglo/ide-analysis
npm run build --workspace=@siglo/ide-ui
cp packages/ide-ui/dist/index.html plugins/intellij/src/main/resources/ide-ui/index.html
node plugins/intellij/marketplace/scripts/capture.mjs
```

The capture script requires Node.js 22+ and defaults to Google Chrome's macOS application path. On another platform, set `CHROME_BIN` to a Chrome or Chromium executable. It uses a temporary browser profile and removes it after capture. The fixture is parsed as source and is never executed.

For an additional screenshot demonstrating source navigation, run the plugin in IntelliJ IDEA, open `demo.workflow.ts`, choose **Visualize Siglo Workflow**, and select `authorizePayment`. Capture the editor and tool window together with the selected definition visible.
