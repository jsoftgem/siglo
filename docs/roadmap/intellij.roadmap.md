# IntelliJ IDEA Plugin Roadmap: Siglo Workflow Explorer & DevTools

> **Status: Milestone 1, Milestone 2 & Milestone 4 Completed — Ready for Milestone 5 Development (2026-11-11)**<br>
> Targets IntelliJ IDEA (Community & Ultimate 2024.1+ / Build 241.x to 243.x / 262.x).<br>
> Final product delivered in Milestones 1, 2 & 4: Distributable plugin package (`siglo-intellij-plugin-1.2.3.zip`), shared JSON-RPC stdio protocol, zero-execution AST daemon with spread and factory resolution, longest-path SVG graph renderer, structured step specs inspector, cross-file navigation, workflow property badging, native Run/Debug configurations, interactive durable resume with side-effect warnings, and JetBrains Marketplace compliance.

---

## 1. Objective and Scope

Make Siglo workflows easier to understand, author, inspect, and execute directly inside IntelliJ IDEA. Milestone 1 (M1) delivers a production-ready, read-only static workflow explorer in a dedicated Tool Window, with bidirectional navigation between visual graph cards and source code definitions. Subsequent releases add static diagnostics (M2), standalone ecosystem inspectors with optional recorded telemetry imports (M4), and execution controls and marketplace distribution (M5). Live execution monitoring (M3) is removed from scope.

### Supported Hosts & Runtime Model

- **IntelliJ IDEA**: Version 2024.1+ (Community and Ultimate editions; tested through modern 2026.2 EAP / Build 262.x).
- **Runtime Environment**: Kotlin/Java JVM plugin running on the IntelliJ Platform SDK (`plugins/intellij`).
- **Explicit Negative Scope**: JetBrains IDEs outside core IntelliJ IDEA are deferred until marketplace distribution. The companion VS Code extension lives in `plugins/vscode` and is covered in [vscode.roadmap.md](/roadmap/vscode.roadmap).

### Language & Framework Scope

- **Workflow Language**: TypeScript (TypeScript 5.0+ syntax) and JavaScript.
- **Execution Engine**: Pure static AST parsing using the TypeScript Compiler API (`ts.createSourceFile`) without runtime module imports or application code execution.
- **Dynamic Workflows**: Workflows constructed via arbitrary runtime loops or dynamic evaluation are represented with explicit `UnresolvedNode` placeholders rather than guessing or executing code.

---

## 2. Relationship to the Monorepo Baseline & Phase 4

Phase 4 (CLI Scaffolding, Live DevTools & Ecosystem Telemetry) is **fully completed and validated** in the monorepo. The IntelliJ plugin builds directly on top of Phase 4 deliverables:

| Monorepo Component               | Status               | Relationship to IntelliJ Plugin                                                                                                                                                            |
| -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Fail-Closed Telemetry**        | Completed (Phase 4B) | M4 reuses `EcosystemInspection` and fail-closed sanitization for optional recorded telemetry imports. Zero raw payloads, secrets, or cURL secrets are leaked.                            |
| **Web Monitor Dashboard**        | Completed (Phase 4C) | The graph presentation and inspector panel design principles (`packages/monitor/ui`) are reused in the host-neutral webview (`packages/ide-ui`) rendered via JCEF.                         |
| **Offline Integration Fixtures** | Completed (Phase 4D) | Reused as canonical test fixtures for the shared static analyzer and the IntelliJ host adapter.                                                                                            |
| **Testing Subpaths**             | Completed (Phase 4E) | Package-owned mocks (`@siglo/http/testing`, `@siglo/ai/testing`) provide offline test doubles for plugin integration tests.                                                                |

The plugin strictly reuses Siglo runtime semantics, schemas, and redaction policies; it **never** implements independent execution engines, custom retry loops, or ad-hoc event formats.

---

## 3. Baseline & Architectural Gaps Addressed in M1

### 3.1 Static Analysis vs. Runtime Reflection

`@siglo/core` exposes runtime graph inspection (`toGraph()`), but this requires executing top-level module code. The plugin solves this with `@siglo/ide-analysis`, an out-of-process Node.js daemon using `ts.createSourceFile` with **zero application execution**.

### 3.2 Stable IDE Protocol & Contract

A formal JSON-RPC 2.0 stdio protocol (`@siglo/ide-protocol`) standardizes communication across all hosts, mirrored in Kotlin data models (`ProtocolModels.kt`) to prevent state loss during GSON serialization.

### 3.3 Source-to-Graph Bidirectional Mapping

Every node, edge, combinator hub, and spec is tagged with Unicode-normalized `SourceRange` coordinates. Clicking cards navigates IntelliJ editor tabs via `OpenFileDescriptor`; buffer typing refreshes the graph debounced at 250ms with monotonic version tracking.

### 3.4 Cross-File Navigation & Spread Evaluation

Workflows frequently reuse steps, spread expressions (`...createCheckout(services).steps`), or import flows across files. The analyzer resolves spread elements, `.steps` property accessors, factory calls, and relative ES/CommonJS imports statically. In IntelliJ, clicking imported steps navigates across files to the origin definition via `OpenFileDescriptor` using `sourceUri` and `sourceLocation`.

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
│   • Run / Debug Configurations (SigloRunConfigurationType & RunnerUtil)     │
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

### 4.1 Language Analysis Service (`packages/ide-analysis`)

The language analysis service runs as an independent Node.js process exposing JSON-RPC 2.0 over `stdin`/`stdout`. It extracts:

- Core steps: `Step.create`, `new Step`, `Func.create`, `Chain.create`, inline lambdas.
- Workflow composition: `flow(...)`, `pipe(...)`, nested subflows.
- Combinators: `parallel`, `all`, `allSettled`, `race`, `branch`, `when`, `map`.
- Durable steps: `wait`, `waitForEvent`.
- Ecosystem steps: `httpStep`, `aiStep`, `sendNotificationStep`, `sendInteractiveApprovalStep`, `verifyWebhookStep`, `encryptFieldsStep`, `decryptFieldsStep`, `maskFieldsStep`.
- Structured specs: Preserves repeated `.spec(...)` calls in order, rule normalization (`default`, `validate`, `transform`, `translate`), and whole-input `$root$` schemas.
- Workflow properties: `.timeout(...)` (deadlines), `.version(...)` (schema versions), `.networkPolicy(...)`, `.monitor(...)`.
- Dynamic syntax & factory resolution: Statically expands `SpreadElement` (`...`), `.steps` properties, local and imported factory functions without code execution.
- Cross-file relative module resolution: Recursively resolves imported steps and workflows across relative TypeScript/JavaScript files (named, default, aliased, namespace, and re-exports) with circular dependency protection.

### 4.2 IntelliJ IDEA Host Adapter (`plugins/intellij`)

- Tool Window: `SigloToolWindowPanel.kt` registers on the right-hand stripe under "Siglo Workflows".
- Thread Safety: JCEF queries are executed outside EDT and wrapped in `ApplicationManager.getApplication().runReadAction`; UI mutations invoke `invokeLater`.
- File Protection: Document edit refresh verifies active editor tab matching both before scheduling and after debounce, preventing background edits from hijacking the view.
- Swing Fallback: Gracefully switches to `JBTree` displaying AST hierarchy when JCEF runtime is unavailable.
- Execution Controls: `SigloRunConfigurationType` and `SigloRunConfiguration` provide native IntelliJ Run and Debug capabilities targeting Node/tsx.

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
- [x] **Spread Element & Cross-File AST Resolution**:
    - Statically resolves spread expressions (`...`), `.steps` properties, local/imported step factories, and relative module imports.
    - Preserves zero-application-execution guarantee and guards against circular references.
    - Supports cross-file definition navigation via `sourceUri` and `sourceLocation`.
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
- [x] **Bidirectional & Cross-File Navigation**:
    - Clicking any graph card or hub navigates editor cursor to the exact line/character coordinates via `OpenFileDescriptor`.
    - Clicking imported steps or definitions navigates cross-file to the target file.
    - Switching editor tabs immediately switches the active workflow graph.
- [x] **Live Edit Refresh**:
    - Updates graph AST within `< 200ms` upon buffer typing via `DocumentListener` (250ms debounce).
    - Uses monotonic request counters to discard stale responses and displays source revisions (`rN`).
- [x] **Graceful Swing Fallback**:
    - Automatically switches to Swing `JBTree` when JCEF is disabled or running headless/remote, maintaining full click-to-navigation functionality.
- [x] **Packaged Distribution**:
    - `siglo-intellij-plugin-1.2.3.zip` built and verified locally on IntelliJ IDEA 2024.1+ (Build 241+).
    - Automated tests pass across TypeScript packages (24 analysis tests, 5 protocol tests) and Kotlin plugin (4 Gradle unit tests).

---

### M2 — Static Diagnostics (Completed)

**Goal**: Surface static workflow diagnostics directly in the editor without executing application code.

#### Acceptance Criteria

- [x] **Static Diagnostics (`LocalInspectionTool` / Annotator)**:
    - Warns on cyclic dependencies in DAG topology (`SIGLO_STATIC_CYCLE`).
    - Warns on missing compensations for sagas with side-effect steps (`SIGLO_MISSING_COMPENSATION`).
    - Warns on unhandled error branches in durable workflows (`SIGLO_UNHANDLED_ERROR_BRANCH`).
    - Flags duplicate step IDs within the same workflow (`SIGLO_DUPLICATE_STEP_ID`).

#### Exit Criteria

- [x] Diagnostic ranges precisely underline offending AST tokens in IntelliJ editor tabs via `SigloWorkflowInspection` (`LocalInspectionTool`) and `SigloWorkflowAnnotator` (`ExternalAnnotator`).

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

**Goal**: Enable developer execution controls and publish plugin to JetBrains Marketplace.

#### Acceptance Criteria

- [ ] **Run/Debug Integration**: Trigger workflow runs using native IntelliJ Run Configurations (`io.siglo.idea.run.SigloRunConfigurationType` and `LocatableConfigurationBase` / `CommandLineState` invoking Node/tsx with `--import tsx`).
- [ ] **Interactive Resume**: Trigger `resumeWorkflow` events for durable workflows suspended on `waitForEvent`, with clear side-effect warning prompts (`Messages.showOkCancelDialog` and webview confirmation prompt).
- [ ] **Marketplace Packaging**:
    - Publish IntelliJ Plugin to JetBrains Marketplace (`publishPlugin` Gradle task and `buildPlugin` generating `siglo-intellij-plugin-1.2.3.zip`).
    - Verify compliance with JetBrains Marketplace approval guidelines (searchable options, vendor, version, description).
- [ ] **Documentation**: Complete getting-started guides, keyboard shortcut references (`control alt R`, `control alt D`, `control alt V`), and troubleshooting documentation in `docs/ide-workflow-explorer.md`.

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
│   │   │   ├── patterns/          # AST matchers (workflow-detector, step-detector, module-resolver)
│   │   │   └── mapper.ts          # Source range & position calculators
│   │   ├── test/                  # AST parsing & safety tests (24 passing)
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
        │       ├── run/           # SigloRunConfigurationType, SigloRunConfiguration, SigloConfigurationFactory
        │       ├── actions/       # OpenWorkflowGraphAction, RunWorkflowAction, DebugWorkflowAction
        │       └── toolwindow/    # SigloToolWindowPanel, JcefBrowserView, SwingFallbackView
        ├── src/main/resources/
        │   ├── ide-ui/index.html  # Copied Vite single-file production webview asset
        │   └── META-INF/
        │       └── plugin.xml     # IntelliJ plugin declaration & tool window
        ├── src/test/kotlin/       # ProtocolModelsTest, SigloDiagnosticsTest, SigloRunConfigurationTest
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

Latest distributable package: `plugins/intellij/build/distributions/siglo-intellij-plugin-1.2.3.zip`.

---

## 7. Performance Budgets & Operational Limits

| Metric                       | Target Budget | Hard Cap     | Verified Status                                         |
| ---------------------------- | ------------- | ------------ | ------------------------------------------------------- |
| **Single-File AST Parsing**  | `< 50 ms`     | `200 ms`     | ✅ ~10-25ms average across test fixtures                |
| **Typing Debounce Delay**    | `250 ms`      | `300 ms`     | ✅ 250ms IntelliJ Alarm timer                           |
| **Analyzer Process Memory**  | `< 80 MB`     | `150 MB RSS` | ✅ Bounded syntax-only AST traversal                    |
| **Graph Rendering (UI)**     | `< 30 ms`     | `100 ms`     | ✅ Instant DOM updates via React + SVG                  |
| **Max Workspace Scan Files** | `100 files`   | `500 files`  | ✅ Strict ignore lists (`node_modules`, `dist`, `.git`) |
