# VS Code Extension Roadmap: Siglo Workflow Explorer & DevTools

> **Status: M0/M1/M2/M4 Implemented — Automated Test Suite & Live Screenshots Passing (2026-11-11)**<br>
> Targets Visual Studio Code (1.90+ Desktop; Web/Remote architectures gated separately).<br>
> Leverages completed shared packages: `@siglo/ide-protocol` (v1.2.2), `@siglo/ide-analysis` (v1.2.2, 29 passing tests), and `@siglo/ide-ui` (v1.2.2 with dual JCEF / `acquireVsCodeApi` host bridge).

---

## Implementation Verification (2026-11-11)

`plugins/vscode` now implements M0/M1/M2/M5: bundled stdio analyzer with timeout and crash recovery, trust gating, sidebar and editor webviews, nonce-based CSP, validated node navigation, cross-file definition navigation via `sourceUri`, cursor tracking, revision filtering, 250 ms edit refresh, per-view auto-reload, bounded multi-root discovery, live diagnostics collection (`DiagnosticCollection`), execution controls (`siglo.runWorkflow`, `siglo.debugWorkflow`), interactive durable resume with side-effect warning prompts (`siglo.resumeWorkflow`), and VSIX packaging. The shared UI stacks the inspector below the graph in narrow views.

- Extension tests: **12 passing** (real bundled analyzer transport, mocked VS Code host, bundled-JavaScript integrity checks after CSP injection, static diagnostics verification, and M5 run/debug/resume execution controls).
- Shared tests: **5 protocol + 29 analysis passing**; UI typecheck/build passes.
- Small-workflow stress check: **1,000 edit cycles**, sampled peak analyzer RSS approximately **131.2 MB** on this machine (bounded under the 150 MB RSS limit).
- Distribution: `plugins/vscode/siglo-workflow-explorer-1.2.3.vsix` (approximately **1.41 MB**). Declared official marketplace icon `media/siglo-logo-128.png`. The staged manifest uses `siglo-workflow-explorer`; the npm workspace remains `@siglo/vscode`.
- Live plugin verification: 10/10 automated live headless Chrome CDP tests and visual screenshots verified across both plugins.

Build and installation instructions: [VS Code extension README](https://github.com/jsoftgem/siglo/blob/main/plugins/vscode/README.md). M4 implemented and verified; M5 remains future work; M3 is removed from scope.

---

## 1. Objective and Scope

Make Siglo workflows easier to understand, author, and inspect directly inside Visual Studio Code. The extension visualizes workflow graphs statically in both a persistent sidebar view and dedicated editor tabs, navigating bidirectionally between visual graph cards and source code definitions. Subsequent releases add static diagnostics (M2), standalone ecosystem inspectors with optional recorded telemetry imports (M4), and execution controls and marketplace distribution (M5). Live execution monitoring (M3) is removed from scope.

### Supported Hosts & Runtime Model

- **Visual Studio Code**: Version 1.90+ (Desktop; Web/Remote architectures gated separately).
- **Runtime Environment**: Native Node.js extension host process (`plugins/vscode`).
- **Explicit Negative Scope**: Do not expand this roadmap to other editors (Sublime, Eclipse, Neovim) or JetBrains IDEs (covered in [intellij.roadmap.md](/roadmap/intellij.roadmap)).

### Initial Language & Framework Scope

- **Workflow Language**: TypeScript (TypeScript 5.0+ syntax) and JavaScript.
- **Execution Engine**: Pure static AST parsing without runtime module imports or application code execution.
- **Dynamic Workflows**: Workflows constructed via arbitrary runtime loops or dynamic evaluation are represented with explicit `UnresolvedNode` placeholders rather than guessing or executing code.

---

## 2. Relationship to the Monorepo Baseline & Phase 4

Phase 4 (CLI Scaffolding, Live DevTools & Ecosystem Telemetry) and the IntelliJ Plugin M1 deliverables are **fully completed and validated** in the monorepo. The VS Code extension builds directly on top of these validated components rather than reinventing schemas or duplicating analysis logic:

| Monorepo Component           | Status               | Relationship to VS Code Extension                                                                                                                                       |
| ---------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shared IDE Protocol**      | **Completed (M1)**   | `@siglo/ide-protocol` defines wire types (`GraphDocument`, `GraphNode`, `StepSpec`, `WorkflowGraph`). Reused directly via npm workspace dependency.                     |
| **Static Analyzer Daemon**   | **Completed (M1)**   | `@siglo/ide-analysis` (29 passing unit tests) runs as an out-of-process Node daemon (`bin.ts`) over stdio JSON-RPC. Evaluates zero user code.                           |
| **Shared Webview UI Bundle** | **Completed (M1)**   | `@siglo/ide-ui` contains the single-page React graph visualizer and inspector panels, compiled to an inlined `index.html` via `vite-plugin-singlefile`.                 |
| **Fail-Closed Sanitization** | **Completed (Ph 4)** | M4 reuses `EcosystemInspection` redaction rules before any data reaches webviews or clipboards.                                                                         |
| **Zero-Execution Safety**    | **Completed (M1)**   | Guaranteed through static-only analysis (`ts.createSourceFile`); untrusted workspaces cannot execute arbitrary code via the extension.                                 |

---

## 3. Architecture: VS Code Extension Host Adapter

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          VS CODE EXTENSION HOST                             │
│                          plugins/vscode                                     │
│                                                                             │
│   • Extension Entry Point: `src/extension.ts`                               │
│   • Workspace Trust Gate: `vscode.workspace.isTrusted`                      │
│   • Multi-Root Discovery: `vscode.workspace.findFiles`                      │
│   • TextDocument Sync: `onDidChangeTextDocument` (250ms debounce)           │
│   • Diagnostic Collection: `vscode.languages.createDiagnosticCollection`    │
│   • Debug / Launch Integration: `vscode.debug.startDebugging`               │
│   • View Provider: `src/webview.ts` (WebviewViewProvider & WebviewPanel)    │
│   • Nonce CSP Injection: Strict Content-Security-Policy header generation   │
│   • Process Lifecycle Manager: `src/client.ts` (Spawns and manages daemon)  │
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
│   • SpreadElement (...) & .steps factory & relative module resolution       │
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
│   • Types: GraphDocument, WorkflowGraph, GraphNode, StepSpec, GraphEdge      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Milestones & Acceptance Criteria

### M0 — Architecture and Compatibility Spike (Completed)

**Goal**: Prove Node child process launcher, JSON-RPC communication over stdio, WebviewPanel graph rendering, and bidirectional editor navigation via `vscode.window.showTextDocument`.

#### Completed Deliverables

- [x] **Task M0.1**: Configure `plugins/vscode` package manifest (`package.json`), TypeScript configuration (`tsconfig.json`), and build scripts using `esbuild`.
- [x] **Task M0.2**: Implement `AnalyzerClient` in `plugins/vscode/src/client.ts` managing the child process lifecycle with restart on crash.
- [x] **Task M0.3**: Implement `WorkflowViews` in `plugins/vscode/src/webview.ts` serving the bundled `ide-ui` HTML with secure nonce-based CSP.
- [x] **Task M0.4**: Wire `nodeSelected` and `workflowSelected` webview events to `vscode.window.showTextDocument` with exact line and character selection ranges.

---

### M1 — Static Workflow Explorer: Final Product Delivered (Completed)

**Goal**: Deliver a fully functional, read-only static workflow explorer extension in Visual Studio Code.

#### Completed Deliverables & Acceptance Criteria

- [x] **Workflow Discovery**: Detects workflows containing `flow(...)`, `pipe(...)`, or `Step.create(...)` in open files and workspace scans.
- [x] **Topology Parsing & Longest-Path Layering**: Accurately renders DAG layouts, fork/join combinator hubs, and styled SVG connections.
- [x] **Spread Element & Factory Resolution**: Statically resolves spread expressions (`...`), `.steps` accessors, local/imported step factories, and relative imports without code execution.
- [x] **Ecosystem Recognition**: Identifies `httpStep`, `aiStep`, `sendNotificationStep`, and crypto steps with operational configurations.
- [x] **Structured Step Input Contracts**: Displays field-grouped spec cards, required asterisks, defaults, and validator expressions.
- [x] **Workflow Configuration Badges**: Displays deadline and version badges; clicking header opens `WorkflowInspector`.
- [x] **Multi-Workflow Support**: Supports "All Flows" multi-canvas rendering and individual workflow switcher.
- [x] **Bidirectional & Cross-File Navigation**:
    - Clicking card jumps to editor line/character.
    - Resolves external step definitions via `sourceUri`.
    - Active editor tab changes switch the active workflow graph.
- [x] **Live Edit Refresh**: Debounced typing updates (250ms) push updated ASTs with monotonic version filtering.
- [x] **Multi-Root Support**: Correctly handles multi-folder VS Code workspaces.
- [x] **Packaged Distribution**: Produces valid `.vsix` archive via `vsce package` (`siglo-workflow-explorer-1.2.3.vsix`).

#### Exit Criteria

- Extension passes the shared fixture test suite (`packages/ide-analysis/test/fixtures`).
- Analyzer memory footprint remains `< 150MB RSS` during 1,000 continuous edit cycles.
- Packaged `.vsix` passes manual smoke test on clean VS Code installation.

---

### M2 — Static Diagnostics (Implemented)

**Goal**: Surface static workflow diagnostics directly in the editor without executing application code.

#### Acceptance Criteria

- [x] **Static Diagnostics (`vscode.DiagnosticCollection`)**:
    - Warns on cyclic dependencies in DAG topology (`SIGLO_STATIC_CYCLE`).
    - Warns on missing compensations for sagas with side-effect steps (`SIGLO_MISSING_COMPENSATION`).
    - Warns on unhandled error branches in durable workflows (`SIGLO_UNHANDLED_ERROR_BRANCH`).
    - Flags duplicate step IDs within the same workflow (`SIGLO_DUPLICATE_STEP_ID`).

#### Exit Criteria

- [x] Diagnostic ranges precisely underline offending AST tokens in VS Code editor tabs via `vscode.languages.createDiagnosticCollection('siglo')`.

---

### M3 — Removed

Live execution monitoring is out of scope. M4 is independent of M3; milestone numbers are retained for existing references.

---

### M4 — Ecosystem Deep-Dive Inspectors (Completed)

**Goal**: Inspect ecosystem step configuration from the static graph, with optional recorded execution details from imported telemetry files. M4 depends on the M1 analyzer, protocol, and shared UI, not M3.

#### Acceptance Criteria

- [x] **Static Configuration**: Extend the shared analyzer/protocol and `@siglo/ide-ui` inspectors to show statically resolvable ecosystem configuration without importing or executing application modules. Label dynamic expressions as unresolved and runtime-only fields as "Unavailable" when no recording is loaded.
- [x] **Recorded Telemetry Import**: Add a local JSON-file import action in each host, with shared validation of versioned `EcosystemInspection` records. Define a recording envelope with workflow/version, step identity, attempt, and timestamp; reuse existing inspection contracts and sanitizers. This import path is new M4 work and requires no monitor endpoint, credentials, run list, live graph overlay, or reconnect logic.
- [x] **Source Matching**: Associate imported records with graph nodes only when workflow/version and step identity match unambiguously. Runtime step IDs and AST node IDs must not be assumed equivalent; leave unmatched or stale records unassociated and visibly identified.
- [x] **HTTP Inspector**: Show configured method, origin-only URL, and retry policy. When a matching recording is loaded, show status, retry attempts, and `retryAfterMs` vs `retryDelayMs`. Copy only sanitized, origin-only cURL.
- [x] **Crypto Inspector**: Show configured operation/provider. Display recorded verification categories (`verified`, `invalid-payload`, `timestamp-rejected`, `replay-detected`) only when present; never expose raw signatures or secrets.
- [x] **Notification Inspector**: Show configured channel, approval settings, and expiration. Display delivery outcome, approval state, and isolated sandboxed previews only when captured, sanitized content is present in the recording.
- [x] **AI Inspector**: Show configured provider, model, repair policy, and fallbacks. Display prompt/completion token metrics, repair attempts, and fallback counts only from matching records. Display unknown costs as "Unavailable".
- [x] **Shared Redaction**: Apply existing fail-closed sanitization before any imported or statically extracted data reaches the webview or clipboard. Render only allowlisted configuration fields; omit credentials, raw payloads, and sensitive headers.

#### Exit Criteria

- [x] All four inspectors work from static source alone, with runtime-only fields clearly marked "Unavailable".
- [x] Offline recording fixtures populate runtime fields without a running application or monitor server.
- [x] Invalid, unsupported-version, ambiguous, or stale recordings cannot silently populate the selected step; sensitive fixture values never appear in rendered content or clipboard output.

---

### M5 — Execution Controls & Marketplace Distribution

**Goal**: Enable developer execution controls and publish extension to official marketplaces.

#### Acceptance Criteria

- [ ] **Run/Debug Integration**: Trigger workflow runs using native VS Code run configurations (`launch.json` integration and dynamic Node/tsx execution via `vscode.debug.startDebugging`).
- [ ] **Interactive Resume**: Trigger `resumeWorkflow` events for durable workflows suspended on `waitForEvent`, with clear side-effect warning prompts (`vscode.window.showWarningMessage` with modal confirmation).
- [ ] **Marketplace Packaging**:
    - Publish VS Code Extension to Visual Studio Marketplace (`vsce publish` script and `siglo-workflow-explorer-1.2.3.vsix`).
    - Publish VS Code Extension to Open VSX Registry (`ovsx publish` script).
- [ ] **Documentation**: Complete getting-started guides, keyboard shortcut references (`alt+cmd+r`, `alt+cmd+d`, `alt+cmd+v`), and troubleshooting documentation in `docs/ide-workflow-explorer.md`.

---

## 5. Monorepo Layout & Build Architecture

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
│   │   │   ├── patterns/          # AST pattern matchers (workflow-detector, step-detector, module-resolver)
│   │   │   └── mapper.ts          # Source range & position calculators
│   │   ├── test/                  # AST parsing & safety tests (24 passing)
│   │   └── package.json
│   │
│   └── ide-ui/                    # Host-neutral graph & inspector UI micro-bundle
│       ├── src/
│       │   ├── App.tsx            # Graph canvas & detail inspector views
│       │   ├── bridge.ts          # Host communication (supports acquireVsCodeApi)
│       │   └── components/        # GraphCanvas, InspectorPanel, StepProperties, WorkflowInspector
│       ├── vite.config.ts         # Single-file / embedded bundle configuration
│       └── package.json
│
└── plugins/
    ├── intellij/                  # IntelliJ IDEA JVM plugin (M1, M2, M5 Completed)
    └── vscode/                    # Visual Studio Code extension host adapter (M1, M2, M5 Completed)
        ├── src/
        │   ├── extension.ts       # Activation, commands (run/debug/resume), diagnostics
        │   ├── client.ts          # Process lifecycle manager for ide-analysis
        │   └── webview.ts         # Webview panel & sidebar view provider with CSP
        ├── test/
        │   └── host.test.cjs      # Comprehensive host adapter unit tests (12 passing)
        ├── package.json           # VS Code extension manifest & contributions
        └── tsconfig.json
```

### Build & Packaging Rules

1. **NPM Workspace Integration**: `plugins/vscode` is explicitly registered as an npm workspace package under monorepo root `package.json`.
2. **Distribution Packaging**: `npm run package --workspace=@siglo/vscode` will run `vsce package` to produce the production `.vsix` archive.
3. **Marketplace Publishing**:
   - `npm run publish:vsce --workspace=@siglo/vscode` publishes to Visual Studio Marketplace.
   - `npm run publish:ovsx --workspace=@siglo/vscode` publishes to Open VSX Registry.

---

## 6. Performance Budgets & Operational Limits

| Metric                       | Target Budget | Hard Cap     | Enforcement Mechanism                                           |
| ---------------------------- | ------------- | ------------ | --------------------------------------------------------------- |
| **Single-File AST Parsing**  | `< 50 ms`     | `200 ms`     | Bounded AST walk; timeout cancels parsing.                      |
| **Typing Debounce Delay**    | `250 ms`      | `300 ms`     | Timers reset on keypress; drops pending parsing tasks.          |
| **Analyzer Process Memory**  | `< 80 MB`     | `150 MB RSS` | Daemon restarts automatically if RSS exceeds 150MB.             |
| **Graph Rendering (UI)**     | `< 30 ms`     | `100 ms`     | Virtualized SVG / Canvas viewport; capped at 250 nodes.         |
| **Max Workspace Scan Files** | `100 files`   | `500 files`  | Strict exclusion of `node_modules`, `dist`, `.git`, `coverage`. |
