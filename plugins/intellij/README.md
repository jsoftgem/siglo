# Siglo Workflows — IntelliJ IDEA Plugin

Visual static workflow explorer, real-time inspector, and developer tools for [Siglo](https://github.com/jsoftgem/siglo) workflows directly inside IntelliJ IDEA.

---

## 1. Overview & Capabilities

The **Siglo Workflows** IntelliJ plugin enables developers to visualize, inspect, and navigate complex asynchronous workflows directly within their IDE without executing user application code.

- **Visual Static Workflow Explorer**: Renders clear DAG topology layouts with longest-path layering, explicit fork/join hubs for parallel and race combinators, and styled directional edges (sequential, parallel, branch, compensation, fallback).
- **Live Debounced Typing Synchronization**: Listens for active editor document changes (`DocumentListener`) and refreshes the graph within 250ms of typing when Auto-Reload is active, using monotonic request counters to discard stale responses.
- **Bi-directional Navigation**:
  - **Graph $\rightarrow$ Code**: Clicking any step card in the visual graph navigates the IntelliJ editor to the exact line and character offset via `OpenFileDescriptor`.
  - **Code $\rightarrow$ Graph**: Switches active graph visualization automatically when switching editor tabs (`FileEditorManagerListener`).
- **Structured Step Input Contracts**: Extracts repeated `.spec(...)` and `.schema(...)` rules, grouping them into clean field cards detailing required fields, defaults, validators, transforms, and whole-input schemas.
- **Workflow-Level Configuration**: Inspects workflow deadlines (`.timeout(...)`), schema versions (`.version(...)`), network perimeter policies (`.networkPolicy(...)`), and monitor expressions with clickable workflow header badges.
- **Multi-Workflow Support**: Supports files declaring multiple workflows (e.g. `flow1`, `flow2`, and composed `flow3 = flow(flow1, flow2)`), providing an "All Flows" view with separate labeled canvases as well as individual workflow selectors.
- **Zero Application Execution**: Communicates with `@siglo/ide-analysis` over a JSON-RPC 2.0 stdio daemon using the TypeScript Compiler API. Top-level application code, database connections, and environment variables are **never** executed.
- **JCEF & Native Swing Fallback**: Renders rich interactive graphs via JCEF (`JBCefBrowser`). When running in remote development or headless environments where JCEF is unavailable, automatically falls back to a native Swing `JBTree` displaying the structured AST hierarchy.

---

## 2. Compatibility Matrix

| Dimension | Minimum Supported | Recommended Baseline | Verified Status |
|---|---|---|---|
| **IntelliJ Platform** | `2024.1` (Build 241.x) | `2024.2+` (Build 242.x / 243.x / 262.x) | ✅ Verified (Community & Ultimate) |
| **IntelliJ Editions** | Community & Ultimate | Community & Ultimate | ✅ Verified |
| **Node.js Runtime** | `18.0.0` (LTS) | `20.x` or `22.x` (Active LTS) | ✅ Node.js >= 18.0.0 |
| **TypeScript (Workspace)** | `~5.0.0` | `^5.5.0` | ✅ TypeScript 5.0+ |
| **Host JVM / Environment** | Java 17 | Java 21 | ✅ JDK 17, 21, and 25 supported (auto-managed via Daemon JVM criteria) |
| **Operating Systems** | macOS (Apple Silicon & Intel), Linux (x64), Windows 10/11 (x64) | All platforms | ✅ Cross-platform POSIX & Windows |

---

## 3. Architecture & Monorepo Integration

```mermaid
flowchart TD
    subgraph IntelliJPlugin["IntelliJ IDEA Plugin (plugins/intellij)"]
        ToolWindow["SigloToolWindowPanel (Swing/JCEF Container)"]
        AnalyzerService["SigloAnalyzerService (Process Manager)"]
        BrowserView["JcefBrowserView (JBCefBrowser + CefMessageRouter)"]
        SwingFallback["SwingFallbackView (JBTree Fallback)"]
        EditorListeners["FileEditorManagerListener & DocumentListener"]
    end

    subgraph AnalysisDaemon["Background Daemon (packages/ide-analysis)"]
        BinDaemon["bin.ts (Node JSON-RPC 2.0 stdio Server)"]
        Parser["parser.ts (TypeScript Compiler API AST Traversal)"]
        StepDetector["patterns/step-detector.ts (Factories & Specs)"]
        WorkflowDetector["patterns/workflow-detector.ts (Flows & Topology)"]
    end

    subgraph WebviewUI["Embedded UI Asset (packages/ide-ui)"]
        HtmlAsset["index.html (React + Tailwind Single-File Bundle)"]
    end

    EditorListeners --> ToolWindow
    ToolWindow <--> AnalyzerService
    AnalyzerService <-->|"JSON-RPC 2.0 (stdio)"| BinDaemon
    BinDaemon --> Parser --> StepDetector & WorkflowDetector
    ToolWindow --> BrowserView
    ToolWindow -.->|"JCEF Unavailable"| SwingFallback
    BrowserView -->|"Loads Resource"| HtmlAsset
    BrowserView <-->|"window.cefQuery"| HtmlAsset
```

---

## 4. Supported Syntax & Step Ecosystem

The static analyzer extracts graph topology across core Siglo patterns and ecosystem integrations:

| Category | Supported Syntax & Patterns |
|---|---|
| **Core Steps** | `Step.create(...)`, `new Step(...)`, compatibility `Func`/`Chain` constructors and `.create(...)`, inline functions |
| **Composition** | `flow(...)`, `pipe(...)`, `Step.flow(...)`, `Step.pipe(...)`, nested flows (e.g. `flow(flow1, flow2)`), sequential arrays |
| **Combinators** | `parallel(...)`, `all(...)`, `allSettled(...)`, `race(...)`, `branch(...)`, `when(...)`, `map(...)`, static helper equivalents (`Step.parallel`, etc.) |
| **Durable Waits** | `wait(...)`, `waitForEvent(...)`, static `Step.wait(...)`, `Step.waitForEvent(...)` |
| **HTTP** | `httpStep(...)`, `new HttpStep(...)` (mapped retries, timeout, origin display) |
| **AI** | `aiStep(...)`, `new AiStep(...)` (model, provider, repair options) |
| **Notifications** | `sendNotificationStep(...)`, `sendInteractiveApprovalStep(...)` |
| **Crypto** | `verifyWebhookStep(...)`, `encryptFieldsStep(...)`, `decryptFieldsStep(...)`, `maskFieldsStep(...)` |
| **Execution Options** | `.timeout(...)`, `.compensate(...)`, `.catch(...)`, `.retry(...)`, `.cache(...)`, `.idempotent(...)`, `.spec(...)`, `.schema(...)` |
| **Workflow Options** | `.timeout(...)` (workflow deadline), `.version(...)` (schema version), `.networkPolicy(...)`, `.monitor(...)` |

---

## 5. Building & Installing

### Step 1: Build Shared TypeScript Packages
From the repository root:
```bash
# 1. Build protocol schemas
npm run build --workspace=@siglo/ide-protocol

# 2. Build static analyzer daemon and run safety tests
npm test --workspace=@siglo/ide-analysis

# 3. Build single-file webview bundle
npm run build --workspace=@siglo/ide-ui

# 4. Copy webview bundle into IntelliJ resources
cp packages/ide-ui/dist/index.html plugins/intellij/src/main/resources/ide-ui/index.html
```

### Step 2: Build IntelliJ Plugin Distribution
From `plugins/intellij`:
```bash
./gradlew test buildPlugin
```
*(Note: If your system default Java is JDK 25+, Gradle automatically delegates to a compatible daemon JVM via `gradle/gradle-daemon-jvm.properties` without requiring manual environment switches).*

The resulting installable ZIP distribution is located at:
`plugins/intellij/build/distributions/siglo-intellij-plugin-1.0.0.zip`

### Step 3: Install in IntelliJ IDEA
1. Open IntelliJ IDEA $\rightarrow$ **Settings / Preferences** (`⌘,` on macOS, `Ctrl+Alt+S` on Linux/Windows).
2. Navigate to **Plugins** $\rightarrow$ Click the gear icon ⚙️ $\rightarrow$ **Install Plugin from Disk...**.
3. Select `plugins/intellij/build/distributions/siglo-intellij-plugin-1.0.0.zip`.
4. Click **Restart IDE**.
5. The **Siglo Workflows** tool window will be available on the right-hand stripe.

---

## 6. Analyzer Daemon Discovery

When the IntelliJ plugin activates, `SigloAnalyzerService` locates the `@siglo/ide-analysis` daemon binary in the following priority order:

1. **Explicit Environment / JVM Property**:
   - `SIGLO_ANALYZER_BIN` environment variable, or
   - `siglo.analyzer.bin` JVM system property.
2. **Local Workspace Dist**:
   - `<project-root>/packages/ide-analysis/dist/bin.js`
3. **Workspace Node Modules**:
   - `<project-root>/node_modules/@siglo/ide-analysis/dist/bin.js`

Node.js itself is located by probing IDE-configured interpreters, `$PATH`, and standard version managers (`~/.nvm`, `~/.volta`, `~/.asdf`, `~/.fnm`, Homebrew).

---

## 7. Troubleshooting

### Running on JDK 25 Environments
- The project includes `gradle/gradle-daemon-jvm.properties` configured for JDK 21. If your default shell uses JDK 25 (e.g. GraalVM CE 25), Gradle automatically launches its daemon using a compatible JDK on your machine, preventing `JavaVersion.parse` errors with Kotlin DSL.
- If no compatible JDK is installed on a new machine, Gradle can auto-provision one, or you can point `JAVA_HOME` to JDK 17 or 21:
  ```bash
  export JAVA_HOME=$(/usr/libexec/java_home -v 21)
  ./gradlew test buildPlugin
  ```

### "Node.js (>= 18.0.0) is not found" Notification
- Ensure Node.js 18+ is installed on your system.
- If using NVM, ensure default alias is set (`nvm alias default <version>`) or launch IntelliJ from a shell with Node in `PATH`.
- Alternatively, configure `SIGLO_ANALYZER_BIN` pointing directly to `node /path/to/bin.js`.

### JCEF Disabled / Showing AST Tree Fallback
- Certain JetBrains runtimes (e.g. customized headless or remote development agents) disable JCEF. The plugin automatically switches to a native Swing `JBTree` view, allowing full node exploration and click-to-navigation without crashing.
- To re-enable JCEF on desktop IntelliJ, ensure you are running on the bundled JetBrains Runtime (JBR) with JCEF enabled.

### Untrusted Workspace Gate
- IntelliJ's Trusted Projects framework gates the plugin. If a project is untrusted, the background Node.js daemon will not spawn until the project is marked trusted by the user.
