# IDE Plugins Roadmap: VS Code & IntelliJ IDEA

> Status: proposed. Targets only Visual Studio Code and IntelliJ IDEA.
> No plugin implementation or marketplace release is implied by this document.

## 1. Objective and scope

Make Siglo workflows easier to understand, author, and inspect inside the editor.
The first useful release opens a workflow graph and navigates from its nodes to
step definitions. Later releases connect that graph to live execution data.

Supported hosts are VS Code and IntelliJ IDEA. Do not expand this roadmap to
other editors or JetBrains products. Specify and test supported IDE versions
and IntelliJ editions during the compatibility milestone, before distribution.

Initial workflow language support is TypeScript. JavaScript, arbitrary dynamic
workflow construction, and remote development are separate compatibility gates,
not implicit promises of the first release.

## 2. Relationship to the existing roadmap

This work does not require completing all of Phase 4 first.

| Existing work | Relationship to IDE plugins |
|---|---|
| CLI ecosystem generators | Optional. IDE authoring actions can eventually share pure templates; plugins must not depend on parsing CLI console output. |
| Offline integration examples | Reuse as plugin fixtures and end-to-end demonstrations. |
| Safe ecosystem telemetry | Required before rich runtime inspectors; unnecessary for the initial static graph. |
| Web dashboard | Reuse graph presentation and inspection contracts where practical. Keep the existing dashboard usable independently. |
| Terminal dashboard | Outside this roadmap. |
| Unified testing exports | Not a prerequisite. Use existing package-owned mocks. |

The plugins should reuse Siglo runtime behavior and validation rather than
creating independent execution engines, retry implementations, or replay rules.

## 3. Current baseline and architectural gaps

The runtime exposes graph inspection/validation used by `@siglo/cli` through
`toGraph`, `inspectGraph`, and `validateGraph`. These operate on constructed
workflows. Importing a workflow module can execute application code; they are
not a safe static analysis API for arbitrary files opened in an editor.

`@siglo/monitor` already provides workflow snapshots over HTTP and live delivery
through SSE/WebSocket infrastructure, with read/ingest/control authentication
scopes. The monitor server contains workflow listing/detail and resume/replay
routes. Their presence does not establish a stable IDE protocol: contract
versioning, capability discovery, reconnect behavior, and compatibility need to
be defined and tested.

The existing web UI and core graph output do not constitute a source-navigation
contract. Phase 4 also identifies missing ecosystem inspection plumbing. Both
gaps must be addressed explicitly instead of inferred from step names.

## 4. Shared architecture

### 4.1 Language analysis and source navigation

Build a shared TypeScript analysis service that reads source without importing
or running workspace modules. Use compiler syntax/type information to recognize
Siglo imports, aliases, step definitions, and supported flow composition.

Produce a versioned graph document containing:

- Stable document-local node IDs, display names, edges, and step kind when known.
- Workspace-relative source locations, declaration ranges, and definition links.
- Diagnostics with severity, source range, explanation, and diagnostic code.
- Explicit unresolved/dynamic nodes and analysis limitations.

Define positions consistently across hosts, including Unicode offsets, path
normalization, and conversion to each editor's document coordinates. Never use
display names alone as node identity. Track document versions so stale analysis
does not navigate to incorrect locations after edits.

Start with direct `Step.create`, ecosystem factories, and straightforward
`flow(...)` composition. Publish a supported-syntax matrix. Expand to imports,
branches, nested flows, and factory patterns incrementally; show partial graphs
when static resolution is incomplete rather than executing the application.

Expose the service through a versioned, documented process protocol with bounded
messages, cancellation, and structured errors. Use LSP for applicable language
features if it fits; graph retrieval may use a documented custom request.
Select the transport during the initial spike and keep host-specific APIs out
of the analysis core. Bundle a compatible analyzer; resolve project TypeScript
and module settings deliberately instead of downloading tools on file open.

### 4.2 Host adapters

| Host | Responsibilities |
|---|---|
| VS Code extension | Register commands and editor actions, diagnostics, graph webview, definition navigation, settings, credential storage, and analyzer lifecycle. |
| IntelliJ IDEA plugin | Provide tool window/actions, editor navigation, diagnostics integration, settings, credential storage, and analyzer process lifecycle through JVM host code. |

The IntelliJ adapter must define Node.js discovery and a clear unavailable-runtime
state. Do not assume every installation has JavaScript/TypeScript plugin APIs;
record any required dependencies and edition restrictions before choosing them.
Neither host should require a paid capability unless explicitly documented in
the compatibility matrix.

Share protocol schemas, graph semantics, fixtures, and a host-neutral graph UI
where feasible. Prove browser/JCEF embedding during the spike before committing
to a shared renderer; keep native navigation and actions in host adapters.
Provide a useful unavailable-renderer fallback and avoid duplicating the runtime
or copying the entire monitor application into each plugin.

### 4.3 Monitor connection

Use a shared client contract for read-only snapshots and one live transport first.
Discover server version/capabilities before enabling optional features. Support
explicit endpoint configuration and namespace filtering; do not probe networks
or start workspace processes automatically.

Fetch an authoritative snapshot on connection and after reconnect. Define how
buffered events reconcile with that snapshot, handle duplicates and out-of-order
delivery, bound buffers, and mark stale/disconnected data visibly. Negotiate or
disable unsupported fields instead of assuming server/plugin versions match.

Map runtime steps to source only when identity metadata provides a reliable
match. If the deployed workflow differs from local source, show that uncertainty
and keep the runtime inspector usable without a source link.

### 4.4 Trust and data boundaries

Static graph viewing must not execute workspace code. Any later action that
runs a workflow or launches a monitor requires an explicit user command and
host trust checks. Start with read-only monitoring; resume/replay is a separate
control-plane milestone, since replay can repeat external side effects.

Keep credentials in host-provided secret storage, send them in authorization
headers, and exclude them from graph documents, webviews, logs, and shared
settings. Use the server's read credential for read-only features. Preserve
server-side redaction; never provide a UI action that restores redacted data.

Restrict webview resources and message handling, validate source-navigation
paths against workspace roots, and treat labels, errors, prompts, URLs, and
notification previews as untrusted content. Do not collect workflow content or
credentials through plugin analytics.

## 5. Milestones and acceptance criteria

### M0 — Architecture and compatibility spike

- [ ] Create minimal VS Code extension and IntelliJ IDEA plugin shells.
- [ ] Display the same synthetic graph and navigate to a fixture step in both.
- [ ] Prove analyzer startup, cancellation, shutdown, and missing-runtime handling.
- [ ] Decide protocol transport and shared renderer feasibility.
- [ ] Record minimum IDE versions, IntelliJ editions/dependencies, Node runtime,
  Siglo versions, and supported local operating systems in a compatibility matrix.

Exit: both hosts demonstrate the same graph-to-source interaction without
executing workspace application code. Document packaging and runtime decisions.

### M1 — Static workflow explorer: first useful release

- [ ] Discover candidate workflows on demand with explicit include/exclude rules.
- [ ] Open a graph for the current file or selected workflow.
- [ ] Support direct steps, ecosystem factories, and basic flow composition.
- [ ] Navigate node → definition and editor selection → corresponding node.
- [ ] Refresh after edits with debounce, cancellation, and stale-result rejection.
- [ ] Explain unsupported syntax and dynamic nodes; handle empty/error states.
- [ ] Support multi-root path resolution without mixing projects.

Exit: both hosts pass shared fixtures covering import aliases, repeated step
names, unsaved edits, Unicode source positions, and unresolved dynamic flows.
Opening a fixture with import-time side effects must never execute those effects.

### M2 — Authoring and diagnostics

- [ ] Add step/workflow creation actions using shared pure templates where useful.
- [ ] Respect project formatting and imports; preview edits and support undo.
- [ ] Detect a deliberately bounded set of static issues with source diagnostics.
- [ ] Reuse runtime graph validation only where equivalent graph semantics can be
  established; do not present partial static analysis as definitive validation.
- [ ] Add HTTP/crypto/notification/AI examples matching actual package contracts.

Exit: generated artifacts compile and run offline in consumer fixtures; editor
edits do not overwrite existing files. Runtime-dependent issues are identified
as unresolved rather than reported as certain errors. Define which completions
add value beyond the editor's existing TypeScript language support.

### M3 — Read-only live execution

- [ ] Connect to a configured monitor with scoped authentication.
- [ ] List runs and inspect status, attempts, duration, errors, and context changes.
- [ ] Overlay runtime status on graphs when source correlation is reliable.
- [ ] Handle disconnects, reconnect/resync, incompatible servers, and disposal.
- [ ] Keep credentials and redacted values out of renderer messages and logs.

Exit: both hosts pass the same monitor contract fixtures, including reordered
and duplicate events, expired authentication, unavailable server, and mismatched
local/deployed workflow definitions. No control-plane actions are exposed yet.

### M4 — Ecosystem inspectors

- [ ] Consume the safe telemetry contract from Phase 4 rather than inventing
  IDE-specific HTTP, AI, crypto, or notification event formats.
- [ ] Show HTTP metadata/retries and sanitized request export where available.
- [ ] Show crypto verification outcomes without secrets or raw signatures.
- [ ] Show notification delivery/approval state and isolated previews.
- [ ] Show AI token usage, known estimated cost, repairs, and fallback metrics.
- [ ] Gate prompt/body capture on the runtime's explicit capture policy.

Exit: missing telemetry remains usable, unknown cost stays unavailable, previews
cannot execute untrusted content, and copy/export preserves redaction. This
milestone depends on Phase 4 telemetry plumbing, not CLI generation.

### M5 — Optional execution controls and distribution

- [ ] Evaluate explicit run/debug actions using existing host run configurations.
- [ ] Add resume/replay only with advertised server capabilities, control-scoped
  credentials, clear side-effect disclosure, and deliberate user invocation.
- [ ] Package installable VS Code and IntelliJ IDEA artifacts with reproducible
  build/version metadata, licenses, changelogs, and compatibility checks.
- [ ] Test fresh install, upgrade, disable/uninstall, and process/resource cleanup.
- [ ] Prepare marketplace descriptions and release checklist; publishing is a
  separate release action, not implied by completing implementation.

A static explorer can ship after M1; authoring and live monitoring need not delay
that release. M5 controls are optional and need not block read-only distribution.

## 6. Proposed repository layout

Confirm names during M0; these directories are proposals, not existing packages.

```text
packages/ide-protocol/        Versioned schemas and shared contract fixtures
packages/ide-analysis/        Static TypeScript analysis and process entry point
packages/ide-ui/              Host-neutral graph/inspector UI, if spike succeeds
packages/vscode/              VS Code host adapter and extension packaging
plugins/intellij/            IntelliJ IDEA JVM adapter and plugin packaging
```

Keep plugin build tooling isolated from runtime publication. A JVM plugin should
not be added to npm workspace scripts as if it were an npm package. Share the
monitor client only if the existing client surface can support both hosts cleanly.

## 7. Validation and completion definition

Use shared fixtures to prevent graph and diagnostic behavior diverging between
hosts. Add analyzer tests for supported syntax, source ranges, cancellation,
malformed projects, and partial results. Add host smoke tests for graph display,
navigation, trust boundaries, and disposal, plus monitor contract tests for live
features. Verify large-workspace scanning is bounded and cancellable; establish
measured startup/update budgets during M0 rather than inventing unsupported
performance guarantees.

Each milestone is complete only when its functionality works in both VS Code
and IntelliJ IDEA within the declared compatibility matrix. Document platform
limitations and partial analysis explicitly. No additional IDEs, custom debugger,
new workflow runtime, or automatic workspace execution are in scope.
