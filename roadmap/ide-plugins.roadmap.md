# IDE Plugins Roadmap: VS Code & IntelliJ IDEA

> **Status: Approved for Development — Ready for Milestone 0 Execution (2026-11-04)**<br>
> Targets Visual Studio Code (1.90+) and IntelliJ IDEA (Community & Ultimate 2024.1+).<br>
> Cross-host architecture, shared JSON-RPC protocol contracts, static TypeScript analysis specifications, and security boundaries are fully specified below.

---

## 1. Objective and Scope

Make Siglo workflows easier to understand, author, and inspect directly inside the developer's primary editor. The initial release (M0/M1) visualizes workflow graphs statically and navigates bidirectionally between graph nodes and source code definitions. Subsequent releases connect this graph to live execution data, authoring templates, and ecosystem diagnostics.

### Supported Hosts
- **Visual Studio Code**: Version 1.90+ (Desktop; Web/Remote architectures gated separately).
- **IntelliJ IDEA**: Version 2024.1+ (Community and Ultimate editions; Android Studio, WebStorm, and other JetBrains IDEs deferred).
- **Explicit Negative Scope**: Do not expand this roadmap to other editors (Sublime, Eclipse, Neovim) or other JetBrains IDE products until the core IntelliJ IDEA plugin is stable and distributed.

### Initial Language & Framework Scope
- **Workflow Language**: TypeScript (TypeScript 5.0+ syntax).
- **Execution Engine**: Pure static AST parsing without runtime module imports or application code execution.
- **Dynamic Workflows**: Workflows constructed via arbitrary runtime loops or dynamic evaluation are represented with explicit `UnresolvedNode` placeholders rather than executing code.

---

## 2. Relationship to the Monorepo Baseline & Phase 4

Phase 4 (CLI Scaffolding, Live DevTools & Ecosystem Telemetry) is **fully completed and validated** in the monorepo. The IDE plugins build directly on top of Phase 4 deliverables rather than reinventing schemas or duplicating runtime logic:

| Monorepo Component | Status | Relationship to IDE Plugins |
|---|---|---|
| **Ecosystem CLI Generators** | Completed (Phase 4A) | Scaffolding actions in IDEs share pure generation templates (`createStepFileContents`). Plugins invoke pure template functions directly and **must not** parse CLI console stdout. |
| **Fail-Closed Telemetry** | Completed (Phase 4B) | The runtime's `EcosystemInspection` metadata contract is consumed directly for runtime inspectors (M4). Zero raw payloads, secrets, or cURL secrets are leaked. |
| **Web Monitor Dashboard** | Completed (Phase 4C) | The graph presentation and inspector panel contracts (`packages/monitor/ui`) are reused in the host-neutral webview (`packages/ide-ui`). |
| **Offline Integration Fixtures** | Completed (Phase 4D) | Reused as canonical test fixtures for the shared static analyzer and host adapters. |
| **Testing Subpaths** | Completed (Phase 4E) | Package-owned mocks (`@siglo/http/testing`, `@siglo/ai/testing`) provide offline test doubles for plugin integration tests. |

The plugins strictly reuse Siglo runtime semantics, schemas, and redaction policies; they **never** implement independent execution engines, custom retry loops, or ad-hoc event formats.

---

## 3. Baseline & Architectural Gaps

### 3.1 Static Analysis vs. Runtime Reflection
`@siglo/core` currently exposes graph inspection via `toGraph()`, `inspectGraph()`, and `validateGraph()`. However, these APIs operate exclusively on **already-instantiated** workflow objects in memory. Importing an arbitrary user file (e.g. `import('./workflow.ts')`) runs top-level module code (connecting to databases, reading environment variables, or executing side-effects).

**Architectural Gap**: Opening a file in an IDE must **never** execute application code. The IDE tooling requires a dedicated static AST analyzer (`packages/ide-analysis`) that extracts graph topology solely using the TypeScript Compiler API.

### 3.2 Stable IDE Protocol & Contract
`@siglo/monitor` provides HTTP snapshots and WebSocket/SSE streaming. However, this is an application-level monitoring feed, not an IDE language service protocol.

**Architectural Gap**: A standardized JSON-RPC 2.0 protocol (`packages/ide-protocol`) is required over standard I/O (stdio) to allow both the VS Code extension (Node.js host) and the IntelliJ plugin (JVM host) to interact with the static analyzer process identically.

### 3.3 Source-to-Graph Bidirectional Mapping
Existing runtime graph serializations only capture step names and dependency edges. They do not capture source file URIs, line/column coordinates, declaration spans, or AST node offsets.

**Architectural Gap**: The static analyzer must attach normalized, Unicode-safe source ranges (`SourceRange`) to every node and edge to power `Click-to-Definition` (Graph &rarr; Code) and `Cursor-Tracking` (Code &rarr; Graph).

---

## 4. Shared Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           HOST EDITORS (UI LAYER)                           │
│                                                                             │
│   ┌─────────────────────────────┐         ┌─────────────────────────────┐   │
│   │   VS Code Extension (TS)    │         │  IntelliJ IDEA Plugin (JVM) │   │
│   │   packages/vscode           │         │  plugins/intellij           │   │
│   │   • Webview Panel (CSP)     │         │  • JCEF Browser Tool Window │   │
│   │   • SecretStorage (Tokens)  │         │  • PasswordSafe (Tokens)    │   │
│   │   • Workspace Trust Gate    │         │  • TrustedProjects Gate     │   │
│   └──────────────┬──────────────┘         └──────────────┬──────────────┘   │
└──────────────────┼───────────────────────────────────────┼──────────────────┘
                   │                                       │
                   │ Standard I/O (JSON-RPC 2.0)           │ Standard I/O (JSON-RPC 2.0)
                   ▼                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   SHARED STATIC ANALYZER PROCESS (NODE DAEMON)               │
│                   packages/ide-analysis (CLI stdio entry point)              │
│                                                                             │
│   • TypeScript Compiler API (`ts.createSourceFile`, AST traversal)          │
│   • Zero module execution / Zero dynamic import()                           │
│   • Pure pattern matching: `flow(...)`, `Step.create(...)`, Ecosystem Steps  │
│   • Path normalization, Unicode offset calculation, stale result rejection  │
│   • Diagnostics engine (Syntax errors, cycles, missing compensation)        │
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
│   • Standard types: `GraphDocument`, `GraphNode`, `GraphEdge`, `Diagnostic` │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Language Analysis Service (`packages/ide-analysis`)

The language analysis service is a standalone Node.js process exposing a JSON-RPC 2.0 interface over `stdin`/`stdout`.

#### AST Parsing Strategy
- Uses the official `typescript` compiler API (`ts.createSourceFile`) in syntax-only mode (`ts.ScriptTarget.Latest`).
- Never instantiates `ts.createProgram` with full type-checking unless explicitly requested for deep type resolution, ensuring AST extraction finishes within `< 50ms`.
- Detects Siglo workflow declarations:
  - Imports matching `siglo` or `@siglo/*`.
  - Workflow construction calls: `flow(...)`, `workflow(...)`.
  - Step creation calls: `Step.create(...)`, `defineStep(...)`.
  - Ecosystem factory steps: `httpStep(...)`, `verifyWebhookStep(...)`, `sendNotificationStep(...)`, `sendInteractiveApprovalStep(...)`, `aiStep(...)`.
  - Graph composition chaining: `.then(...)`, `.parallel([...])`, `.branch(...)`, `.fallback(...)`, `.compensate(...)`.
- Dynamic and unsupported constructs: When encountering dynamic expressions that cannot be resolved statically (e.g. `flow.then(calculateDynamicStep())`), emit an `UnresolvedNode` with the source snippet rather than crashing or guessing.

#### Protocol Specification (`packages/ide-protocol`)

The service communicates using standard JSON-RPC 2.0 messages:

##### Methods
1. **`siglo/initialize`**:
   - *Params*: `{ clientName: string, clientVersion: string, rootUri: string, capabilities: { dynamicRefresh: boolean } }`
   - *Result*: `{ serverVersion: string, protocolVersion: '1.0.0', supportedSyntaxMatrix: string[] }`
2. **`siglo/discoverWorkflows`**:
   - *Params*: `{ documentUri?: string, workspaceUri?: string }`
   - *Result*: `{ workflows: Array<{ id: string, name: string, uri: string, range: SourceRange }> }`
3. **`siglo/getGraph`**:
   - *Params*: `{ uri: string, documentVersion: number, content?: string }`
   - *Result*: `GraphDocument`
4. **`siglo/resolveLocation`**:
   - *Params*: `{ uri: string, position: { line: number, character: number } }`
   - *Result*: `{ nodeId?: string, edgeId?: string, range: SourceRange }`
5. **`siglo/shutdown`**:
   - Cleanly closes open file handles and exits the process.

##### Core Type Contracts
```typescript
export interface SourcePosition {
  line: number;      // 0-indexed line number
  character: number; // 0-indexed UTF-16 code unit offset
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

export interface GraphNode {
  id: string;               // Deterministic AST node ID (e.g. "step_callStripe_L14_C5")
  name: string;             // Display label
  stepKind: 'generic' | 'http' | 'crypto' | 'notification' | 'ai' | 'custom';
  location: SourceRange;     // Precise definition range in source
  declarationRange: SourceRange; // Outer enclosing statement range
  executionConfig?: {
    retries?: number;
    timeoutMs?: number;
    hasCompensation?: boolean;
  };
}

export interface GraphEdge {
  id: string;
  from: string;             // Source node ID
  to: string;               // Target node ID
  type: 'sequential' | 'parallel' | 'branch' | 'fallback' | 'compensation';
  label?: string;           // Optional branch condition label
}

export interface Diagnostic {
  code: string;             // e.g. "SIGLO_STATIC_CYCLE", "SIGLO_MISSING_FALLBACK"
  message: string;
  severity: 'error' | 'warning' | 'info';
  range: SourceRange;
  fixAvailable?: boolean;
}

export interface UnresolvedNode {
  id: string;
  reason: 'dynamic-call' | 'external-factory' | 'unsupported-syntax';
  expressionSnippet: string;
  location: SourceRange;
}

export interface GraphDocument {
  uri: string;
  documentVersion: number;
  workflowName: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: UnresolvedNode[];
  diagnostics: Diagnostic[];
}
```

### 4.2 Host Adapters

#### VS Code Extension (`packages/vscode`)
- **Runtime Model**: Runs natively in VS Code's Node.js extension host process.
- **Process Management**: Spawns `packages/ide-analysis/dist/bin.js` via `child_process.spawn` using the bundled Node.js runtime.
- **UI Surface**: Webview Panel and Webview View (`vscode.window.registerWebviewViewProvider`) hosting the shared `@siglo/ide-ui` bundle.
- **Security & Sandboxing**:
  - Enforces strict Content Security Policy (CSP): `default-src 'none'; img-src data: vscode-resource:; script-src 'nonce-...'; style-src 'nonce-...';`.
  - Validates all message origins through `vscode.Webview.onDidReceiveMessage`.
  - Workspace Trust: Gated behind `vscode.workspace.isTrusted`. Unchecked workspaces only allow read-only file diagnostics; daemon startup is disabled.
  - Secret Storage: Uses `context.secrets` (`vscode.SecretStorage`) for monitor connection tokens.

#### IntelliJ IDEA Plugin (`plugins/intellij`)
- **Runtime Model**: Kotlin/Java plugin built with the modern IntelliJ Platform Gradle Plugin 2.x (`org.jetbrains.intellij.platform`).
- **Target Platform**: IntelliJ IDEA Community and Ultimate 2024.1+ (build `241.x` to `243.x`).
- **Process Management**:
  - Spawns the static analyzer using `com.intellij.execution.configurations.GeneralCommandLine` and `com.intellij.execution.process.OSProcessHandler`.
  - Communicates via JSON-RPC 2.0 over standard streams using IntelliJ's non-blocking `ProcessListener`.
- **Node.js Discovery Strategy**:
  1. Inspects IDE-configured Node.js interpreters (`NodeCommandLineConfigurator` when Ultimate/JS plugin is present).
  2. Probes user environment: `$PATH`, standard version managers (`~/.nvm`, `~/.volta`, `~/.asdf`, `~/.fnm`), and platform package paths (`/opt/homebrew/bin/node`, `/usr/local/bin/node`, `C:\Program Files\nodejs\node.exe`).
  3. If Node.js (>= 18.0.0) is not found, displays a non-modal notification banner with a "Configure Node.js Interpreter" action, maintaining an explicit "Node Unavailable" fallback state.
- **UI Surface**:
  - Registers a Tool Window (`com.intellij.openapi.wm.ToolWindowFactory`) labeled **Siglo Workflows**.
  - Renders graph visualization using JCEF (`com.intellij.ui.jcef.JBCefBrowser`).
  - **Graceful Fallback**: If JCEF is disabled or unsupported (e.g. running in remote development or headless CI), falls back to a native Swing component (`JBTree` / `JBTable`) displaying the structured workflow hierarchy.
- **Security & Sandboxing**:
  - Workspace Trust: Uses `com.intellij.ide.trustedProjects.TrustedProjects.isProjectTrusted(project)` before launching the analyzer process.
  - Secret Storage: Uses `com.intellij.ide.passwordSafe.PasswordSafe.getInstance()` for monitor credentials.

### 4.3 Shared UI Bundle (`packages/ide-ui`)

- Micro-bundle compiled with Vite, producing a standalone HTML/JS/CSS asset.
- Graph visualization powered by Cytoscape / SVG canvas matching the aesthetics of `@siglo/monitor/ui`.
- **Host Agnostic Bridge**: Communicates with the hosting editor via a lightweight adapter:
  ```typescript
  export interface HostBridge {
    postMessage(msg: { type: string; payload: unknown }): void;
    onMessage(callback: (msg: { type: string; payload: unknown }) => void): void;
  }
  ```
  - In VS Code: Wraps `acquireVsCodeApi().postMessage`.
  - In IntelliJ: Wraps `window.cefQuery` (JCEF IPC).

### 4.4 Monitor Connection & Real-Time Sync (M3/M4)

- **Connection**: Connects to the `@siglo/monitor` HTTP/WebSocket server using bearer authentication.
- **Reconciliation Protocol**:
  1. On initial connection and reconnect, issues an authoritative HTTP `GET /api/v1/workflows/:id` snapshot.
  2. Subscribes to live WebSocket events (`step:start`, `step:complete`, `step:retry`, `step:error`).
  3. Buffers incoming streaming events during reconnect; drops duplicate event IDs based on sequence numbers.
- **Source Correlation**: Matches running runtime step records to static graph nodes using the deterministic step ID (`step.id`). If the local source file has been modified since the run started (hash mismatch), displays a visible `⚠️ Run executed on different revision` indicator.
- **Data Protection**: Strictly inherits Phase 4 redaction rules. Step inputs, outputs, and tokens are rendered through Phase 4 multi-layer sanitization; raw secrets and bodies are never displayed.

---

## 5. Milestones & Acceptance Criteria

### M0 — Architecture and Compatibility Spike (Ready to Execute)

**Goal**: Prove cross-host process communication, synthetic graph rendering, and bidirectional source navigation without executing workspace code.

#### Actionable Developer Tasks
- [ ] **Task M0.1**: Scaffold `packages/ide-protocol` with TypeScript types for JSON-RPC messages (`GraphDocument`, `GraphNode`, `SourceRange`).
- [ ] **Task M0.2**: Scaffold `packages/ide-analysis` with a CLI stdio entry point that responds to `siglo/initialize` and parses a static fixture file using `ts.createSourceFile`.
- [ ] **Task M0.3**: Scaffold minimal VS Code extension in `packages/vscode` that spawns the analyzer daemon, sends `siglo/getGraph`, and logs the returned AST.
- [ ] **Task M0.4**: Scaffold minimal IntelliJ IDEA plugin in `plugins/intellij` using Gradle 8.x and IntelliJ Platform Gradle Plugin 2.x; launch the analyzer and display received node IDs in a tool window.
- [ ] **Task M0.5**: Build minimal `packages/ide-ui` webview; render synthetic graph nodes and dispatch a `nodeSelected` message.
- [ ] **Task M0.6**: Wire `nodeSelected` event to host navigation (`vscode.window.showTextDocument` / IntelliJ `FileEditorManager.openTextEditor`) opening the fixture file at the step's exact line and character.

#### Exit Criteria (Gate to M1)
1. Both VS Code and IntelliJ IDEA render the identical synthetic graph and navigate to line/column positions in a fixture file.
2. Analyzer process lifecycle (startup, ping, cancellation, shutdown) verified on macOS, Linux, and Windows.
3. Analyzer verified to **never** evaluate top-level JavaScript (fixture with `process.exit(1)` or top-level file writes must parse cleanly without executing).
4. Compatibility matrix recorded and committed.

---

### M1 — Static Workflow Explorer: First Useful Release

**Goal**: Deliver a fully functional, read-only static workflow explorer in both editors.

#### Acceptance Criteria
- [ ] **Workflow Discovery**: Automatically detects workflows containing `flow(...)` or `workflow(...)` in open files and workspace scans (bounded by explicit ignore lists: `node_modules`, `dist`, `.git`).
- [ ] **Topology Parsing**: Accurately extracts `.then()`, `.parallel()`, `.branch()`, `.fallback()`, and `.compensate()` edges.
- [ ] **Ecosystem Recognition**: Identifies `httpStep`, `verifyWebhookStep`, `sendNotificationStep`, and `aiStep` instances, assigning proper step kinds.
- [ ] **Bidirectional Navigation**:
  - Clicking a graph node moves editor cursor to the step definition.
  - Moving editor cursor inside a step definition highlights the corresponding graph node (debounced at 250ms).
- [ ] **Live Edit Refresh**: Updates graph AST within `< 200ms` upon buffer edits without requiring file save; rejects stale responses using monotonic document version counters.
- [ ] **Unresolved Syntax Handling**: Renders explicit dashed placeholders for dynamic steps with inline explanations.
- [ ] **Multi-Root Support**: Correctly handles multi-folder workspaces without cross-contaminating project roots.

#### Exit Criteria
- Both hosts pass the shared fixture test suite (`fixtures/static-analysis/**`).
- Analyzer memory footprint remains `< 150MB RSS` during 1,000 continuous edit cycles.
- Packaged `.vsix` and IntelliJ `.zip` distributions pass manual smoke tests on clean installations.

---

### M2 — Authoring & Static Diagnostics

**Goal**: Accelerate workflow authoring with scaffolding actions and proactive lint diagnostics.

#### Acceptance Criteria
- [ ] **Editor Actions**: Add "Create Siglo Step" and "Create Siglo Workflow" context menu actions.
- [ ] **Template Engine**: Reuses Phase 4 generator templates (`createStepFileContents`) to generate clean, offline-testable TypeScript steps.
- [ ] **Static Diagnostics**:
  - Warns on cyclic dependencies in DAG topology.
  - Warns on missing compensations for sagas with side-effect steps.
  - Warns on unhandled error branches in durable workflows.
  - Flags duplicate step IDs within the same workflow.
- [ ] **Preview & Undo**: All file generation actions support standard IDE Undo/Redo stacks.

#### Exit Criteria
- Diagnostic ranges precisely underline offending AST tokens in both editors.
- Generated steps pass `tsc --noEmit` and execute offline unit tests successfully.

---

### M3 — Read-Only Live Execution Monitoring

**Goal**: Connect the IDE graph to running workflows via `@siglo/monitor`.

#### Acceptance Criteria
- [ ] **Connection Manager**: Configures monitor endpoints (`http://localhost:4000`) and securely stores authentication tokens in host secret vaults.
- [ ] **Workflow Run List**: Displays active and historical workflow runs with status, execution time, and retry counts.
- [ ] **Live Graph Overlay**: Dynamically updates node badges:
  - ⚪ Pending &rarr; 🔵 Running &rarr; 🟢 Completed / 🔴 Failed / 🟡 Suspended (`waitForEvent`).
- [ ] **Resilience**: Gracefully handles network disconnects, buffers in-flight events, and reconciles state with authoritative snapshots upon reconnect.
- [ ] **Redaction Guarantee**: Verifies zero unredacted authorization tokens or sensitive headers appear in the webview DOM.

#### Exit Criteria
- Passes mock network failure test harness (reordered packets, dropped connections, expired tokens).
- No control-plane actions (resume/replay) exposed in this milestone.

---

### M4 — Ecosystem Deep-Dive Inspectors

**Goal**: Surface Phase 4 telemetry contracts directly in editor inspector panels.

#### Acceptance Criteria
- [ ] **HTTP Inspector**: Displays method, origin-only URL, status, retry attempts, `retryAfterMs` vs `retryDelayMs`, and copy origin-only cURL.
- [ ] **Crypto Inspector**: Displays verification category (`verified`, `invalid-payload`, `timestamp-rejected`, `replay-detected`) without exposing raw signatures or secrets.
- [ ] **Notification Inspector**: Displays delivery status, expiration, and isolated sandboxed preview of email/Slack payloads.
- [ ] **AI Inspector**: Displays provider, model ID, prompt/completion token metrics, repair loop counts, and fallback transitions. Displays unknown costs as `"Unavailable"`.

#### Exit Criteria
- Deep-dive panels render consistently in both VS Code Webviews and IntelliJ JCEF.
- Copy/export actions strictly preserve Phase 4 sanitization rules.

---

### M5 — Optional Execution Controls & Marketplace Distribution

**Goal**: Enable developer execution controls and publish plugins to official marketplaces.

#### Acceptance Criteria
- [ ] **Run/Debug Integration**: Trigger workflow runs using native IDE run configurations (`launch.json` in VS Code / Run Configurations in IntelliJ).
- [ ] **Interactive Resume**: Trigger `resumeWorkflow` events for durable workflows suspended on `waitForEvent`, with clear side-effect warning prompts.
- [ ] **Marketplace Packaging**:
  - Publish VS Code Extension to Visual Studio Marketplace and Open VSX Registry.
  - Publish IntelliJ Plugin to JetBrains Marketplace.
- [ ] **Documentation**: Complete getting-started guides, keyboard shortcut references, and troubleshooting documentation.

---

## 6. Monorepo Layout & Build Architecture

```text
fluid-func/
├── packages/
│   ├── ide-protocol/              # Shared JSON-RPC schemas, interfaces, and fixtures
│   │   ├── src/
│   │   │   ├── protocol.ts        # Wire methods and request/response types
│   │   │   └── types.ts           # GraphDocument, GraphNode, SourceRange
│   │   ├── test/                  # Protocol serialization & validation tests
│   │   └── package.json
│   │
│   ├── ide-analysis/              # Standalone TypeScript AST analyzer daemon
│   │   ├── src/
│   │   │   ├── bin.ts             # CLI entry point (stdio JSON-RPC runner)
│   │   │   ├── parser.ts          # ts.createSourceFile traversal engine
│   │   │   ├── patterns/          # AST pattern matchers (flow, steps, ecosystem)
│   │   │   └── mapper.ts          # Source range & position calculators
│   │   ├── test/                  # AST parsing & safety tests (zero-eval checks)
│   │   └── package.json
│   │
│   ├── ide-ui/                    # Host-neutral graph & inspector UI micro-bundle
│   │   ├── src/
│   │   │   ├── App.tsx            # Graph canvas & detail inspector views
│   │   │   ├── bridge.ts          # Host communication abstraction
│   │   │   └── components/        # Graph nodes, edges, and ecosystem cards
│   │   ├── vite.config.ts         # Single-file / embedded bundle configuration
│   │   └── package.json
│   │
│   └── vscode/                    # Visual Studio Code extension host adapter
│       ├── src/
│       │   ├── extension.ts       # Activation & command registration
│       │   ├── client.ts          # Process lifecycle manager for ide-analysis
│       │   └── webview.ts         # Webview panel provider with CSP
│       ├── package.json           # VS Code extension manifest & contributions
│       └── tsconfig.json
│
└── plugins/
    └── intellij/                  # IntelliJ IDEA JVM plugin (isolated Gradle build)
        ├── src/main/kotlin/
        │   └── io/siglo/idea/
        │       ├── SigloIcons.kt
        │       ├── process/       # OSProcessHandler & JSON-RPC client
        │       ├── toolwindow/    # ToolWindowFactory & JCEF browser integration
        │       └── actions/       # Editor navigation & context actions
        ├── src/main/resources/
        │   └── META-INF/
        │       └── plugin.xml     # IntelliJ plugin declaration & extensions
        ├── build.gradle.kts       # Gradle IntelliJ Platform Plugin 2.x
        └── settings.gradle.kts
```

### Build & Workspace Isolation Rules
1. **NPM Workspace Boundaries**: `packages/ide-protocol`, `packages/ide-analysis`, `packages/ide-ui`, and `packages/vscode` are registered npm packages under the monorepo root `package.json`.
2. **JVM Build Isolation**: `plugins/intellij` is a Gradle project managed independently via `./gradlew`. It is **never** added to npm workspace scripts.
3. **Distribution Packaging**:
   - VS Code: `npm run package --workspace=@siglo/vscode` runs `vsce package`.
   - IntelliJ: `cd plugins/intellij && ./gradlew buildPlugin` builds the distributable `.zip`.

---

## 7. Performance Budgets & Operational Limits

To prevent editor stutter, high CPU usage, or runaway memory consumption, the following hard limits are enforced:

| Metric | Target Budget | Hard Cap | Enforcement Mechanism |
|---|---|---|---|
| **Single-File AST Parsing** | `< 50 ms` | `200 ms` | Bounded AST walk; timeout cancels parsing. |
| **Typing Debounce Delay** | `250 ms` | `300 ms` | Timers reset on keypress; drops pending parsing tasks. |
| **Analyzer Process Memory** | `< 80 MB` | `150 MB RSS` | Daemon restarts automatically if RSS exceeds 150MB. |
| **Graph Rendering (UI)** | `< 30 ms` | `100 ms` | Virtualized SVG / Canvas viewport; capped at 250 nodes. |
| **Max Workspace Scan Files** | `100 files` | `500 files` | Strict exclusion of `node_modules`, `dist`, `.git`, `coverage`. |
| **Node.js Discovery Timeout** | `< 500 ms` | `2,000 ms` | Background check; non-blocking to IDE startup. |

---

## 8. Compatibility & Validation Matrix

### Matrix Requirements
| Dimension | Minimum Supported | Recommended Baseline |
|---|---|---|
| **VS Code Engine** | `^1.90.0` | `Latest stable` |
| **IntelliJ Platform** | `2024.1` (Build 241.x) | `2024.2+` (Build 242.x / 243.x) |
| **IntelliJ Editions** | Community & Ultimate | Community & Ultimate |
| **Node.js Runtime** | `18.0.0` (LTS) | `20.x` or `22.x` (Active LTS) |
| **TypeScript (Workspace)**| `~5.0.0` | `^5.5.0` |
| **Operating Systems** | macOS (ARM64/x64), Linux (x64), Windows 10/11 (x64) | All platforms |

### Test Harness Strategy
1. **Zero-Execution Assertion**: Automated test suite parses malicious fixture files containing top-level `process.exit(1)`, network calls, and file-system mutations. Tests fail if any side-effect executes.
2. **Cross-Platform Path Normalization**: Automated unit tests verify Windows backslashes (`\`), UNC paths, and POSIX URIs (`file:///...`) resolve to identical document ranges.
3. **Unicode Range Fixtures**: Test fixtures containing multi-byte Unicode characters (emojis, CJK glyphs) assert exact character and line offset calculations.
4. **Disconnection & Reconnect Simulation**: Host integration smoke tests simulate sudden daemon termination, verifying automatic restarts and error notifications.
