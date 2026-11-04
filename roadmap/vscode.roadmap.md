# VS Code Extension Roadmap: Siglo Workflow Explorer & DevTools

> **Status: Ready for Implementation — Building on Validated Shared M1 Foundation (2026-11-05)**<br>
> Targets Visual Studio Code (1.90+ Desktop; Web/Remote architectures gated separately).<br>
> Leverages completed shared packages: `@siglo/ide-protocol` (v1.0.0), `@siglo/ide-analysis` (v1.0.0, 19 passing tests), and `@siglo/ide-ui` (v1.0.0 with dual JCEF / `acquireVsCodeApi` host bridge).

---

## 1. Objective and Scope

Make Siglo workflows easier to understand, author, and inspect directly inside Visual Studio Code. The extension visualizes workflow graphs statically in both a persistent sidebar view and dedicated editor tabs, navigating bidirectionally between visual graph cards and source code definitions. Subsequent releases connect this graph to live execution data via `@siglo/monitor`, authoring templates, and ecosystem diagnostics.

### Supported Hosts & Runtime Model
- **Visual Studio Code**: Version 1.90+ (Desktop; Web/Remote architectures gated separately).
- **Runtime Environment**: Native Node.js extension host process (`packages/vscode`).
- **Explicit Negative Scope**: Do not expand this roadmap to other editors (Sublime, Eclipse, Neovim) or JetBrains IDEs (covered in [intellij.roadmap.md](file:///Users/jericodeguzman/Projects/fluid-func/roadmap/intellij.roadmap.md)).

### Initial Language & Framework Scope
- **Workflow Language**: TypeScript (TypeScript 5.0+ syntax) and JavaScript.
- **Execution Engine**: Pure static AST parsing without runtime module imports or application code execution.
- **Dynamic Workflows**: Workflows constructed via arbitrary runtime loops or dynamic evaluation are represented with explicit `UnresolvedNode` placeholders rather than guessing or executing code.

---

## 2. Relationship to the Monorepo Baseline & Phase 4

Phase 4 (CLI Scaffolding, Live DevTools & Ecosystem Telemetry) and the IntelliJ Plugin M1 deliverables are **fully completed and validated** in the monorepo. The VS Code extension builds directly on top of these validated components rather than reinventing schemas or duplicating analysis logic:

| Monorepo Component | Status | Relationship to VS Code Extension |
|---|---|---|
| **Shared IDE Protocol** | **Completed (M1)** | `@siglo/ide-protocol` defines wire types (`GraphDocument`, `GraphNode`, `StepSpec`, `WorkflowGraph`). Reused directly via npm workspace dependency. |
| **Static Analyzer Daemon** | **Completed (M1)** | `@siglo/ide-analysis` (19 passing unit tests) runs as an out-of-process Node daemon (`bin.ts`) over stdio JSON-RPC. Evaluates zero user code. |
| **Shared Webview UI** | **Completed (M1)** | `@siglo/ide-ui` (`dist/index.html`) includes longest-path layout, multi-flow canvases, structured spec inspector, and a host bridge pre-wired for `acquireVsCodeApi()`. |
| **Ecosystem CLI Generators** | Completed (Phase 4A) | Scaffolding commands in VS Code share pure generation templates (`createStepFileContents`). Invokes pure template functions directly without parsing console stdout. |
| **Fail-Closed Telemetry** | Completed (Phase 4B) | The runtime's `EcosystemInspection` metadata contract is consumed directly for runtime inspectors (M4). Zero raw payloads, secrets, or cURL secrets are leaked. |
| **Offline Test Fixtures** | Completed (Phase 4D) | Canonical test fixtures in `packages/ide-analysis/test/fixtures` validate zero-eval safety and edge parsing. |

The extension strictly reuses Siglo runtime semantics, schemas, and redaction policies; it **never** implements independent execution engines, custom retry loops, or ad-hoc event formats.

---

## 3. Baseline & Architectural Gaps Addressed

### 3.1 Static Analysis vs. Runtime Reflection
`@siglo/core` exposes runtime graph inspection (`toGraph()`), but this requires executing top-level module code. The VS Code extension resolves this by launching `@siglo/ide-analysis`, which traverses the AST using `ts.createSourceFile` with **zero application execution**.

### 3.2 Stable IDE Protocol & Contract
The formal JSON-RPC 2.0 stdio protocol (`@siglo/ide-protocol`) ensures identical behavior between IntelliJ and VS Code hosts.

### 3.3 Source-to-Graph Bidirectional Mapping
Every node and edge carries Unicode-safe `SourceRange` coordinates:
- **Click-to-Definition**: Clicking a card sends a `nodeSelected` message to VS Code, navigating the active editor via `vscode.window.showTextDocument` with an active selection range.
- **Cursor Tracking**: Moving the editor cursor debounces and posts a `selectNode` message to the webview.

---

## 4. Architecture: VS Code Extension

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       VS CODE EXTENSION (UI LAYER)                          │
│                       packages/vscode                                       │
│                                                                             │
│   • Extension Host Process (Node.js / TypeScript)                           │
│   • Webview Panel (Full Editor Tab: "Siglo: Open Workflow Visualizer")      │
│   • Webview View Provider (Persistent Sidebar Explorer: "Siglo Workflows")  │
│   • Strict Content Security Policy (CSP + Nonce-guarded scripts/styles)     │
│   • SecretStorage (context.secrets for monitor bearer tokens)               │
│   • Workspace Trust Gate (vscode.workspace.isTrusted)                       │
│   • ChildProcess stdio client (JSON-RPC 2.0 to @siglo/ide-analysis daemon)  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       │ Standard I/O (JSON-RPC 2.0)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   SHARED STATIC ANALYZER PROCESS (NODE DAEMON)               │
│                   packages/ide-analysis (CLI stdio entry point: bin.ts)      │
│                                                                             │
│   • TypeScript Compiler API (`ts.createSourceFile`, AST traversal)          │
│   • Zero module execution / Zero dynamic import()                           │
│   • Combinator expansion: parallel, allSettled, race, branch, when, map     │
│   • Durable pause extraction: wait, waitForEvent                            │
│   • Package steps: httpStep, aiStep, sendNotificationStep, crypto steps     │
│   • Structured spec extraction: .spec(...) & .schema(...) rules             │
│   • Workflow properties: .timeout(...), .version(...), .networkPolicy(...)  │
│   • Subflow stitching and route normalization (SUBPRIME / default)          │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       │ Implements
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SHARED PROTOCOL & SCHEMAS (CONTRACT)                     │
│                    packages/ide-protocol                                    │
│                                                                             │
│   • `siglo/initialize`, `siglo/shutdown`                                    │
│   • `siglo/discoverWorkflows`, `siglo/getGraph`, `siglo/resolveLocation`     │
│   • Standard types: GraphDocument, WorkflowGraph, GraphNode, StepSpec       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Language Analysis Service (`packages/ide-analysis`)
The language analysis service is already built and packaged. It runs as a background Node.js process:
- Spawns via `child_process.spawn(process.execPath, [binPath], { stdio: ['pipe', 'pipe', 'pipe'] })`.
- Exposes `siglo/initialize`, `siglo/discoverWorkflows`, `siglo/getGraph`, `siglo/resolveLocation`, and `siglo/shutdown`.
- Tested across 19 unit test cases proving zero-execution safety, combinator recursion, structured specs, and property badging.

### 4.2 VS Code Host Adapter (`packages/vscode`)
- **Lifecycle Manager (`client.ts`)**: Manages the child process, sends JSON-RPC requests, tracks monotonic request IDs, and restarts the daemon if it crashes.
- **Webview Provider (`webview.ts`)**:
  - Registers `WebviewViewProvider` for the activity bar sidebar.
  - Registers command `siglo.openVisualizer` for a dedicated editor tab (`vscode.window.createWebviewPanel`).
  - Serves `packages/ide-ui/dist/index.html` with strict CSP nonces and local resource roots.
- **Bidirectional Synchronization**:
  - Webview $\rightarrow$ Editor: When webview sends `nodeSelected`, calls `vscode.window.showTextDocument` focusing the target line and column.
  - Editor $\rightarrow$ Webview: Listens to `vscode.workspace.onDidChangeTextDocument` (debounced at 250ms) and `vscode.window.onDidChangeActiveTextEditor` to push updated ASTs via `webview.postMessage({ type: 'setGraph', document })`.
- **Security & Sandboxing**:
  - Gated behind `vscode.workspace.isTrusted`. In untrusted workspaces, daemon launch is blocked.
  - Strict Content Security Policy: `default-src 'none'; img-src data: vscode-resource: https:; script-src 'nonce-...'; style-src 'nonce-...' 'unsafe-inline';`.

### 4.3 Shared UI Bundle (`packages/ide-ui`)
- Reuses the Vite single-file HTML build directly.
- `packages/ide-ui/src/bridge.ts` includes built-in support for `acquireVsCodeApi()`:
  ```typescript
  if (typeof window.acquireVsCodeApi === 'function') {
    this.vscodeApi = window.acquireVsCodeApi();
  }
  ```
  Sending messages to the extension invokes `this.vscodeApi.postMessage(payload)`.
  Receiving messages from the extension listens on `window.addEventListener('message')`.

---

## 5. Milestones & Actionable Plan

### M0 — Architecture and Compatibility Spike (Ready to Implement)

**Goal**: Scaffold `packages/vscode`, launch the analyzer daemon via `child_process.spawn`, render `@siglo/ide-ui` in a webview panel, and navigate to source code upon clicking a node.

#### Actionable Developer Tasks
- [x] **Task M0.1**: Scaffold `@siglo/ide-protocol` with TypeScript types for JSON-RPC messages (Completed in shared foundation).
- [x] **Task M0.2**: Scaffold `@siglo/ide-analysis` with stdio daemon `bin.ts` (Completed in shared foundation, 19 passing tests).
- [x] **Task M0.3**: Equip `@siglo/ide-ui/src/bridge.ts` with `acquireVsCodeApi()` integration (Completed in shared UI bundle).
- [ ] **Task M0.4**: Scaffold `packages/vscode` directory, `package.json` extension manifest with `contributes.viewsContainers`, `contributes.views`, and `contributes.commands`.
- [ ] **Task M0.5**: Implement `client.ts` in `packages/vscode` to manage the Node.js daemon lifecycle (`siglo/initialize`, `siglo/getGraph`, `siglo/shutdown`).
- [ ] **Task M0.6**: Implement `webview.ts` embedding `@siglo/ide-ui/dist/index.html` with CSP headers and `postMessage` routing.
- [ ] **Task M0.7**: Wire `nodeSelected` message to `vscode.window.showTextDocument` opening the target file at exact line and character coordinates.

#### Exit Criteria (Gate to M1)
1. Opening a workflow file in VS Code and running `Siglo: Open Workflow Visualizer` renders the interactive DAG.
2. Clicking a step node navigates the editor cursor to the exact line/character coordinates in the source file.
3. Analyzer daemon restarts transparently if killed.
4. Untrusted workspace gate verified: daemon is blocked until workspace is trusted.

---

### M1 — Static Workflow Explorer: First Useful Release

**Goal**: Deliver a fully functional, read-only static workflow explorer in VS Code.

#### Acceptance Criteria
- [ ] **Workflow Discovery**: Automatically detects workflows containing `flow(...)`, `pipe(...)`, or `workflow(...)` in open files and workspace scans (ignoring `node_modules`, `dist`, `.git`).
- [ ] **Topology Parsing & Longest-Path Layering**: Accurately renders DAG layouts, fork/join combinator hubs, and styled SVG connections.
- [ ] **Ecosystem Recognition**: Identifies `httpStep`, `aiStep`, `sendNotificationStep`, and crypto steps with operational configurations.
- [ ] **Structured Step Input Contracts**: Displays field-grouped spec cards, required asterisks, defaults, and validator expressions.
- [ ] **Workflow Configuration Badges**: Displays deadline and version badges; clicking header opens `WorkflowInspector`.
- [ ] **Multi-Workflow Support**: Supports "All Flows" multi-canvas rendering and individual workflow switcher.
- [ ] **Bidirectional Navigation**:
  - Clicking card jumps to editor line/character.
  - Active editor tab changes switch the active workflow graph.
- [ ] **Live Edit Refresh**: Debounced typing updates (250ms) push updated ASTs with monotonic version filtering.
- [ ] **Multi-Root Support**: Correctly handles multi-folder VS Code workspaces.
- [ ] **Packaged Distribution**: Produces valid `.vsix` archive via `vsce package`.

#### Exit Criteria
- Extension passes the shared fixture test suite (`packages/ide-analysis/test/fixtures`).
- Analyzer memory footprint remains `< 150MB RSS` during 1,000 continuous edit cycles.
- Packaged `.vsix` passes manual smoke test on clean VS Code installation.

---

### M2 — Authoring & Static Diagnostics

**Goal**: Accelerate workflow authoring with scaffolding actions and proactive lint diagnostics.

#### Acceptance Criteria
- [ ] **Editor Commands**: Add "Siglo: Create Step" and "Siglo: Create Workflow" commands in Command Palette and file context menus.
- [ ] **Template Engine**: Reuses Phase 4 generator templates (`createStepFileContents`) to generate clean, offline-testable TypeScript steps.
- [ ] **Static Diagnostics (`vscode.DiagnosticCollection`)**:
  - Warns on cyclic dependencies in DAG topology.
  - Warns on missing compensations for sagas with side-effect steps.
  - Warns on unhandled error branches in durable workflows.
  - Flags duplicate step IDs within the same workflow.
- [ ] **Preview & Undo**: All file generation actions support standard VS Code Undo/Redo stacks.

---

### M3 — Read-Only Live Execution Monitoring

**Goal**: Connect the VS Code graph to running workflows via `@siglo/monitor`.

#### Acceptance Criteria
- [ ] **Connection Manager**: Configures monitor endpoints (`http://localhost:4000`) and securely stores authentication tokens in `vscode.SecretStorage`.
- [ ] **Workflow Run List**: Displays active and historical workflow runs in a custom VS Code TreeDataProvider / Webview View with status, execution time, and retry counts.
- [ ] **Live Graph Overlay**: Dynamically updates node badges (Pending, Running, Completed, Failed, Suspended).
- [ ] **Resilience**: Gracefully handles network disconnects, buffers in-flight events, and reconciles state with authoritative snapshots upon reconnect.
- [ ] **Redaction Guarantee**: Verifies zero unredacted authorization tokens or sensitive headers appear in the webview DOM.

---

### M4 — Ecosystem Deep-Dive Inspectors

**Goal**: Surface Phase 4 telemetry contracts directly in VS Code inspector panels.

#### Acceptance Criteria
- [ ] **HTTP Inspector**: Displays method, origin-only URL, status, retry attempts, `retryAfterMs` vs `retryDelayMs`, and copy origin-only cURL.
- [ ] **Crypto Inspector**: Displays verification category (`verified`, `invalid-payload`, `timestamp-rejected`, `replay-detected`) without exposing raw signatures or secrets.
- [ ] **Notification Inspector**: Displays delivery status, expiration, and isolated sandboxed preview of email/Slack payloads.
- [ ] **AI Inspector**: Displays provider, model ID, prompt/completion token metrics, repair loop counts, and fallback transitions.

---

### M5 — Execution Controls & Marketplace Distribution

**Goal**: Enable developer execution controls and publish extension to official marketplaces.

#### Acceptance Criteria
- [ ] **Run/Debug Integration**: Trigger workflow runs using native VS Code run configurations (`launch.json` integration for debugging workflows).
- [ ] **Interactive Resume**: Trigger `resumeWorkflow` events for durable workflows suspended on `waitForEvent`, with clear side-effect warning prompts.
- [ ] **Marketplace Packaging**:
  - Publish VS Code Extension to Visual Studio Marketplace (`vsce publish`).
  - Publish VS Code Extension to Open VSX Registry (`ovsx publish`).
- [ ] **Documentation**: Complete getting-started guides, keyboard shortcut references, and troubleshooting documentation.

---

## 6. Monorepo Layout & Build Architecture

```text
fluid-func/
├── packages/
│   ├── ide-protocol/              # Shared JSON-RPC schemas, interfaces, and fixtures
│   │   ├── src/
│   │   │   ├── protocol.ts        # Wire methods and request/response types
│   │   │   └── types.ts           # GraphDocument, GraphNode, StepSpec, SourceRange
│   │   ├── test/                  # Protocol serialization & validation tests (5 passing)
│   │   └── package.json
│   │
│   ├── ide-analysis/              # Standalone TypeScript AST analyzer daemon
│   │   ├── src/
│   │   │   ├── bin.ts             # CLI entry point (stdio JSON-RPC runner)
│   │   │   ├── parser.ts          # ts.createSourceFile traversal engine
│   │   │   ├── patterns/          # AST pattern matchers (workflow-detector, step-detector)
│   │   │   └── mapper.ts          # Source range & position calculators
│   │   ├── test/                  # AST parsing & safety tests (19 passing)
│   │   └── package.json
│   │
│   ├── ide-ui/                    # Host-neutral graph & inspector UI micro-bundle
│   │   ├── src/
│   │   │   ├── App.tsx            # Graph canvas & detail inspector views
│   │   │   ├── bridge.ts          # Host communication (supports acquireVsCodeApi)
│   │   │   └── components/        # GraphCanvas, InspectorPanel, StepProperties, WorkflowInspector
│   │   ├── vite.config.ts         # Single-file / embedded bundle configuration
│   │   └── package.json
│   │
│   └── vscode/                    # Visual Studio Code extension host adapter (Next Up)
│       ├── src/
│       │   ├── extension.ts       # Activation & command registration
│       │   ├── client.ts          # Process lifecycle manager for ide-analysis
│       │   └── webview.ts         # Webview panel & sidebar view provider with CSP
│       ├── package.json           # VS Code extension manifest & contributions
│       └── tsconfig.json
│
└── plugins/
    └── intellij/                  # IntelliJ IDEA JVM plugin (M1 Completed)
```

### Build & Packaging Rules
1. **NPM Workspace Integration**: `packages/vscode` will be registered as an npm workspace package under monorepo root `package.json`.
2. **Distribution Packaging**: `npm run package --workspace=@siglo/vscode` will run `vsce package` to produce the production `.vsix` archive.

---

## 7. Performance Budgets & Operational Limits

| Metric | Target Budget | Hard Cap | Enforcement Mechanism |
|---|---|---|---|
| **Single-File AST Parsing** | `< 50 ms` | `200 ms` | Bounded AST walk; timeout cancels parsing. |
| **Typing Debounce Delay** | `250 ms` | `300 ms` | Timers reset on keypress; drops pending parsing tasks. |
| **Analyzer Process Memory** | `< 80 MB` | `150 MB RSS` | Daemon restarts automatically if RSS exceeds 150MB. |
| **Graph Rendering (UI)** | `< 30 ms` | `100 ms` | Virtualized SVG / Canvas viewport; capped at 250 nodes. |
| **Max Workspace Scan Files** | `100 files` | `500 files` | Strict exclusion of `node_modules`, `dist`, `.git`, `coverage`. |
