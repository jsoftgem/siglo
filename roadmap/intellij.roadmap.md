# IntelliJ IDEA Plugin Roadmap: Siglo Workflow Explorer & DevTools

> **Status: Milestone 1 Completed — Ready for Milestone 2 Development (2026-11-05)**<br>
> Targets IntelliJ IDEA (Community & Ultimate 2024.1+ / Build 241.x to 243.x / 262.x).<br>
> Final product delivered in Milestone 1: Distributable plugin package (`siglo-intellij-plugin-1.0.0.zip`), shared JSON-RPC stdio protocol, zero-execution AST daemon, longest-path SVG graph renderer, structured step specs inspector, and workflow property badging.

---

## 1. Objective and Scope

Make Siglo workflows easier to understand, author, and inspect directly inside IntelliJ IDEA. Milestone 1 (M1) delivers a production-ready, read-only static workflow explorer in a dedicated Tool Window, with bidirectional navigation between visual graph cards and source code definitions. Subsequent releases connect this visual graph to authoring templates (M2), live execution data via `@siglo/monitor` (M3), ecosystem telemetry inspectors (M4), and marketplace distribution (M5).

### Supported Hosts & Runtime Model
- **IntelliJ IDEA**: Version 2024.1+ (Community and Ultimate editions; tested through modern 2026.2 EAP / Build 262.x).
- **Runtime Environment**: Kotlin/Java JVM plugin running on the IntelliJ Platform SDK (`plugins/intellij`).
- **Explicit Negative Scope**: JetBrains IDEs outside core IntelliJ IDEA are deferred until marketplace distribution. The companion VS Code extension is covered in [vscode.roadmap.md](file:///Users/jericodeguzman/Projects/fluid-func/roadmap/vscode.roadmap.md).

### Language & Framework Scope
- **Workflow Language**: TypeScript (TypeScript 5.0+ syntax) and JavaScript.
- **Execution Engine**: Pure static AST parsing using the TypeScript Compiler API (`ts.createSourceFile`) without runtime module imports or application code execution.
- **Dynamic Workflows**: Workflows constructed via arbitrary runtime loops or dynamic evaluation are represented with explicit `UnresolvedNode` placeholders rather than guessing or executing code.

---

## 2. Relationship to the Monorepo Baseline & Phase 4

Phase 4 (CLI Scaffolding, Live DevTools & Ecosystem Telemetry) is **fully completed and validated** in the monorepo. The IntelliJ plugin builds directly on top of Phase 4 deliverables:

| Monorepo Component | Status | Relationship to IntelliJ Plugin |
|---|---|---|
| **Ecosystem CLI Generators** | Completed (Phase 4A) | Scaffolding actions in IntelliJ share pure generation templates (`createStepFileContents`). The plugin invokes pure template functions directly and **must not** parse CLI console stdout. |
| **Fail-Closed Telemetry** | Completed (Phase 4B) | The runtime's `EcosystemInspection` metadata contract is consumed directly for runtime inspectors (M4). Zero raw payloads, secrets, or cURL secrets are leaked. |
| **Web Monitor Dashboard** | Completed (Phase 4C) | The graph presentation and inspector panel design principles (`packages/monitor/ui`) are reused in the host-neutral webview (`packages/ide-ui`) rendered via JCEF. |
| **Offline Integration Fixtures** | Completed (Phase 4D) | Reused as canonical test fixtures for the shared static analyzer and the IntelliJ host adapter. |
| **Testing Subpaths** | Completed (Phase 4E) | Package-owned mocks (`@siglo/http/testing`, `@siglo/ai/testing`) provide offline test doubles for plugin integration tests. |

The plugin strictly reuses Siglo runtime semantics, schemas, and redaction policies; it **never** implements independent execution engines, custom retry loops, or ad-hoc event formats.

---

## 3. Baseline & Architectural Gaps Addressed in M1

### 3.1 Static Analysis vs. Runtime Reflection
`@siglo/core` exposes runtime graph inspection (`toGraph()`), but this requires executing top-level module code. The plugin solves this with `@siglo/ide-analysis`, an out-of-process Node.js daemon using `ts.createSourceFile` with **zero application execution**.

### 3.2 Stable IDE Protocol & Contract
A formal JSON-RPC 2.0 stdio protocol (`@siglo/ide-protocol`) standardizes communication across all hosts, mirrored in Kotlin data models (`ProtocolModels.kt`) to prevent state loss during GSON serialization.

### 3.3 Source-to-Graph Bidirectional Mapping
Every node, edge, combinator hub, and spec is tagged with Unicode-normalized `SourceRange` coordinates. Clicking cards navigates IntelliJ editor tabs via `OpenFileDescriptor`; buffer typing refreshes the graph debounced at 250ms with monotonic version tracking.

---

## 4. Architecture: IntelliJ IDEA Plugin

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       INTELLIJ IDEA PLUGIN (JVM LAYER)                      │
│                       plugins/intellij                                      │
│                                                                             │
│   • Kotlin / Java Runtime (IntelliJ Platform SDK 2024.1+, Build 241+)        │
│   • Tool Window ("Siglo Workflows" via ToolWindowFactory)                   │
│   • JCEF Browser (JBCefBrowser) with window.cefQuery IPC                    │
│   • Graceful Swing Fallback (JBTree when JCEF is disabled / headless)       │
│   • Editor Sync: DocumentListener (250ms debounce) & FileEditorManager      │
│   • Source Revision Tracking: Document 'rN' display & stale response filter │
│   • TrustedProjects Gate (com.intellij.ide.trustedProjects.TrustedProjects) │
│   • GeneralCommandLine + OSProcessHandler (JSON-RPC stdio daemon client)   │
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
│   • Types: GraphDocument, WorkflowGraph, GraphNode, StepSpec, GraphEdge      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Language Analysis Service (`packages/ide-analysis`)
The language analysis service runs as an independent Node.js process exposing JSON-RPC 2.0 over `stdin`/`stdout`. It extracts:
- Core steps: `Step.create`, `new Step`, `Func.create`, `Chain.create`, inline lambdas.
- Workflow composition: `flow(...)`, `pipe(...)`, nested subflows.
- Combinators: `parallel`, `all`, `allSettled`, `race`, `branch`, `when`, `map`.
- Durable steps: `wait`, `waitForEvent`.
- Ecosystem steps: `httpStep`, `aiStep`, `sendNotificationStep`, `sendInteractiveApprovalStep`, `verifyWebhookStep`, `encryptFieldsStep`, `decryptFieldsStep`, `maskFieldsStep`.
- Structured specs: Preserves repeated `.spec(...)` calls in order, rule normalization (`default`, `validate`, `transform`, `translate`), and whole-input `$root$` schemas.
- Workflow properties: `.timeout(...)` (deadlines), `.version(...)` (schema versions), `.networkPolicy(...)`, `.monitor(...)`.

### 4.2 IntelliJ IDEA Host Adapter (`plugins/intellij`)
- Tool Window: `SigloToolWindowPanel.kt` registers on the right-hand stripe under "Siglo Workflows".
- Thread Safety: JCEF queries are executed outside EDT and wrapped in `ApplicationManager.getApplication().runReadAction`; UI mutations invoke `invokeLater`.
- File Protection: Document edit refresh verifies active editor tab matching both before scheduling and after debounce, preventing background edits from hijacking the view.
- Swing Fallback: Gracefully switches to `JBTree` displaying AST hierarchy when JCEF runtime is unavailable.

### 4.3 Shared UI Bundle (`packages/ide-ui`)
- Built with React 18, Tailwind CSS, Lucide icons, and inlined via `vite-plugin-singlefile`.
- Layout: Deterministic longest-path layering with explicit fork/join nodes and cubic bezier SVG edges.
- Canvas Isolation: Unique SVG marker IDs (`arrow-${canvasId}`) prevent cross-canvas arrow clip paths in "All Flows" mode.
- Interactive Panels: `InspectorPanel` (step configuration), `StepProperties` (field contract cards), and `WorkflowInspector` (workflow metadata, network perimeter, monitor expression).
- Host Bridge: `bridge.ts` supports both IntelliJ JCEF (`window.cefQuery`) and VS Code (`acquireVsCodeApi`).

---

## 5. Milestones & Acceptance Criteria

### M0 — Architecture and Compatibility Spike (Completed)

**Goal**: Prove Kotlin process launcher, JSON-RPC communication over stdio, JCEF graph rendering in a Tool Window, and bidirectional editor navigation via `FileEditorManager`.

#### Completed Deliverables
- [x] **Task M0.1**: Scaffold `packages/ide-protocol` with TypeScript types for JSON-RPC messages (`GraphDocument`, `GraphNode`, `SourceRange`).
- [x] **Task M0.2**: Scaffold `packages/ide-analysis` with a CLI stdio entry point (`bin.ts`) that responds to `siglo/initialize` and parses static files using `ts.createSourceFile`.
- [x] **Task M0.3**: Scaffold IntelliJ IDEA plugin in `plugins/intellij` using Gradle 8.10.2 and IntelliJ Platform Gradle Plugin 2.x; configure `plugin.xml` and register the `Siglo Workflows` Tool Window.
- [x] **Task M0.4**: Implement `OSProcessHandler` JSON-RPC runner and Node.js discovery service in Kotlin (`io.siglo.idea.process.SigloAnalyzerService`).
- [x] **Task M0.5**: Embed `packages/ide-ui` inside `JBCefBrowser` with `CefMessageRouterHandler`; render synthetic graph nodes and dispatch `nodeSelected` query.
- [x] **Task M0.6**: Wire `nodeSelected` event to `FileEditorManager.getInstance(project).openTextEditor()` opening the fixture file at the step's exact line and character coordinates.

---

### M1 — Static Workflow Explorer: Final Product Delivered (Completed)

**Goal**: Deliver a fully functional, read-only static workflow explorer in IntelliJ IDEA.

#### Completed Deliverables & Acceptance Criteria
- [x] **Workflow Discovery**: Automatically detects workflows containing `flow(...)`, `pipe(...)`, or `workflow(...)` in open files and workspace scans (ignoring `node_modules`, `dist`, `.git`).
- [x] **Topology Parsing & Longest-Path Layering**:
  - Accurately parses sequential, parallel, race, allSettled, branch, when, and map combinators into layered DAG structures.
  - Generates explicit visual hubs for forks and joins with differentiated SVG connections.
  - Derives clean edge labels for shared routes (e.g. `SUBPRIME / default`).
- [x] **Ecosystem Recognition**: Identifies `httpStep`, `aiStep`, `sendNotificationStep`, `sendInteractiveApprovalStep`, `verifyWebhookStep`, and crypto steps, mapping operational properties and retry policies without executing code.
- [x] **Structured Step Input Contracts**:
  - Extracts repeated `.spec(...)` and `.schema(...)` rules in declaration order.
  - Groups rules by field name, rendering required asterisks, defaults, and validator exceptions.
  - Provides expandable source views for transformers and whole-input schemas (`$root$`).
- [x] **Workflow Configuration Badges & Inspector**:
  - Displays workflow deadline (`.timeout(...)`) and schema version (`.version(...)`) badges above canvas.
  - Clicking workflow header opens `WorkflowInspector`, showing network policy permissions (`hosts`, `allowLocalhost`), monitor configurations, and a clickable node catalog.
- [x] **Multi-Workflow Support**:
  - Files defining multiple workflows can be viewed individually or collectively in "All Flows" mode.
  - Each workflow in "All Flows" renders in an isolated, labeled canvas with unique SVG marker IDs.
- [x] **Bidirectional Navigation**:
  - Clicking any graph card or hub navigates editor cursor to the exact line/character coordinates via `OpenFileDescriptor`.
  - Switching editor tabs immediately switches the active workflow graph.
- [x] **Live Edit Refresh**:
  - Updates graph AST within `< 200ms` upon buffer typing via `DocumentListener` (250ms debounce).
  - Uses monotonic request counters to discard stale responses and displays source revisions (`rN`).
- [x] **Graceful Swing Fallback**:
  - Automatically switches to Swing `JBTree` when JCEF is disabled or running headless/remote, maintaining full click-to-navigation functionality.
- [x] **Packaged Distribution**:
  - `siglo-intellij-plugin-1.0.0.zip` built and verified locally on IntelliJ IDEA 2024.1+ (Build 241+).
  - Automated tests pass across TypeScript packages (19 analysis tests, 5 protocol tests) and Kotlin plugin (4 Gradle unit tests).

---

### M2 — Authoring & Static Diagnostics (Next Milestone)

**Goal**: Accelerate workflow authoring with scaffolding actions and proactive lint diagnostics.

#### Acceptance Criteria
- [ ] **Editor Actions**: Add "New Siglo Step" and "New Siglo Workflow" file template actions under the Project View and Editor `New...` context menu (`com.intellij.openapi.actionSystem.AnAction`).
- [ ] **Template Engine**: Reuses Phase 4 generator templates (`createStepFileContents`) to generate clean, offline-testable TypeScript steps.
- [ ] **Static Diagnostics (`LocalInspectionTool` / Annotator)**:
  - Warns on cyclic dependencies in DAG topology.
  - Warns on missing compensations for sagas with side-effect steps.
  - Warns on unhandled error branches in durable workflows.
  - Flags duplicate step IDs within the same workflow.
- [ ] **Preview & Undo**: All file generation actions integrate with IntelliJ `CommandProcessor` supporting standard Undo/Redo stacks.

#### Exit Criteria
- Diagnostic ranges precisely underline offending AST tokens in IntelliJ editor tabs.
- Generated steps pass `tsc --noEmit` and execute offline unit tests successfully.

---

### M3 — Read-Only Live Execution Monitoring

**Goal**: Connect the IntelliJ graph to running workflows via `@siglo/monitor`.

#### Acceptance Criteria
- [ ] **Connection Manager**: Configures monitor endpoints in IDE Settings (`Settings > Tools > Siglo`) and securely stores authentication tokens in `PasswordSafe`.
- [ ] **Workflow Run List**: Displays active and historical workflow runs in a custom Tool Window tab with status, execution time, and retry counts.
- [ ] **Live Graph Overlay**: Dynamically updates node badges:
  - ⚪ Pending &rarr; 🔵 Running &rarr; 🟢 Completed / 🔴 Failed / 🟡 Suspended (`waitForEvent`).
- [ ] **Resilience**: Gracefully handles network disconnects, buffers in-flight events, and reconciles state with authoritative snapshots upon reconnect.
- [ ] **Redaction Guarantee**: Verifies zero unredacted authorization tokens or sensitive headers appear in the webview DOM.

---

### M4 — Ecosystem Deep-Dive Inspectors

**Goal**: Surface Phase 4 telemetry contracts directly in IntelliJ inspector panels.

#### Acceptance Criteria
- [ ] **HTTP Inspector**: Displays method, origin-only URL, status, retry attempts, `retryAfterMs` vs `retryDelayMs`, and copy origin-only cURL.
- [ ] **Crypto Inspector**: Displays verification category (`verified`, `invalid-payload`, `timestamp-rejected`, `replay-detected`) without exposing raw signatures or secrets.
- [ ] **Notification Inspector**: Displays delivery status, expiration, and isolated sandboxed preview of email/Slack payloads.
- [ ] **AI Inspector**: Displays provider, model ID, prompt/completion token metrics, repair loop counts, and fallback transitions. Displays unknown costs as `"Unavailable"`.

---

### M5 — Execution Controls & Marketplace Distribution

**Goal**: Enable developer execution controls and publish plugin to JetBrains Marketplace.

#### Acceptance Criteria
- [ ] **Run/Debug Integration**: Trigger workflow runs using native IntelliJ Run Configurations (`com.intellij.execution.configurations.ConfigurationType`).
- [ ] **Interactive Resume**: Trigger `resumeWorkflow` events for durable workflows suspended on `waitForEvent`, with clear side-effect warning prompts.
- [ ] **Marketplace Packaging**:
  - Publish IntelliJ Plugin to JetBrains Marketplace (`publishPlugin` Gradle task).
  - Verify compliance with JetBrains Marketplace approval guidelines.
- [ ] **Documentation**: Complete getting-started guides, keyboard shortcut references, and troubleshooting documentation.

---

## 6. Monorepo Layout & Build Instructions

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
│   │   │   ├── patterns/          # AST matchers (workflow-detector, step-detector)
│   │   │   └── mapper.ts          # Source range & position calculators
│   │   ├── test/                  # AST parsing & safety tests (19 passing)
│   │   └── package.json
│   │
│   └── ide-ui/                    # Host-neutral graph & inspector UI micro-bundle
│       ├── src/
│       │   ├── App.tsx            # Graph canvas & detail inspector views
│       │   ├── bridge.ts          # Host communication (supports cefQuery & VS Code)
│       │   └── components/        # GraphCanvas, InspectorPanel, StepProperties, WorkflowInspector
│       ├── vite.config.ts         # Single-file / embedded bundle configuration
│       └── package.json
│
└── plugins/
    └── intellij/                  # IntelliJ IDEA JVM plugin (isolated Gradle build)
        ├── src/main/kotlin/
        │   └── io/siglo/idea/
        │       ├── SigloIcons.kt  # Dark/light theme aligned SVG icons
        │       ├── process/       # SigloAnalyzerService, OSProcessHandler, ProtocolModels
        │       └── toolwindow/    # SigloToolWindowPanel, JcefBrowserView, SwingFallbackView
        ├── src/main/resources/
        │   ├── ide-ui/index.html  # Copied Vite single-file production webview asset
        │   └── META-INF/
        │       └── plugin.xml     # IntelliJ plugin declaration & tool window
        ├── src/test/kotlin/       # ProtocolModelsTest (4 passing tests)
        ├── build.gradle.kts       # Gradle IntelliJ Platform Plugin 2.x
        └── settings.gradle.kts
```

### Complete Build Commands
```bash
# 1. Build and verify TypeScript packages
npm run build --workspace=@siglo/ide-protocol
npm test --workspace=@siglo/ide-analysis
npm run build --workspace=@siglo/ide-ui

# 2. Copy embedded webview into plugin resources
cp packages/ide-ui/dist/index.html plugins/intellij/src/main/resources/ide-ui/index.html

# 3. Build and package IntelliJ plugin ZIP
cd plugins/intellij
./gradlew test buildPlugin
```

Latest distributable package: `plugins/intellij/build/distributions/siglo-intellij-plugin-1.0.0.zip`.

---

## 7. Performance Budgets & Operational Limits

| Metric | Target Budget | Hard Cap | Verified Status |
|---|---|---|---|
| **Single-File AST Parsing** | `< 50 ms` | `200 ms` | ✅ ~10-25ms average across test fixtures |
| **Typing Debounce Delay** | `250 ms` | `300 ms` | ✅ 250ms IntelliJ Alarm timer |
| **Analyzer Process Memory** | `< 80 MB` | `150 MB RSS` | ✅ Bounded syntax-only AST traversal |
| **Graph Rendering (UI)** | `< 30 ms` | `100 ms` | ✅ Instant DOM updates via React + SVG |
| **Max Workspace Scan Files** | `100 files` | `500 files` | ✅ Strict ignore lists (`node_modules`, `dist`, `.git`) |
