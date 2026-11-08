# Phase 4 Roadmap: Developer Experience, CLI & Live DevTools Integration

> **Status: Completed & Validated (2026-11-04)**<br>
> All required Phase 4 deliverables (**4A–4D**) are fully implemented, tested, and validated across the monorepo with 100% coverage requirements in `@siglo/core`.
> Optional conveniences under **4E** were evaluated and intentionally deferred or declined with documented rationale.
> Detailed developer guides and configuration instructions are documented in [docs/ecosystem-devtools.md](/ecosystem-devtools) and [packages/cli/ECOSYSTEM.md](https://github.com/jsoftgem/siglo/blob/main/packages/cli/ECOSYSTEM.md).

---

## 1. Project Baseline & Architectural Alignment

Phase 4 bridges Siglo's ecosystem packages (`@siglo/http`, `@siglo/crypto`, `@siglo/ai`, `@siglo/notifications`) with developer tooling (`@siglo/cli`, `@siglo/monitor`, and web dashboard). Rather than inventing isolated abstractions, Phase 4 builds directly upon existing core primitives (`AsyncLocalStorage`, `Step`, `emitMonitoringEvent`, and standard schema validation).

| Ecosystem Area | Baseline Implementation | Phase 4 Architecture & Deliverables |
|---|---|---|
| **CLI Generator** | `packages/cli/src/bin.ts` had basic `generate step <name>` for generic steps. | Extended with discriminated `--type={http,crypto,notification,ai}` options, input validation, collision guards, and offline companion test generation. |
| **HTTP Telemetry** | `httpStep` asserted network policy via ASL bridge; metadata was attached to step outputs. | Added non-intrusive `EcosystemInspection` telemetry, attempt timings, Retry-After parsing, backoff diagnostics, origin-only cURL exports, and opt-in body/header capture. |
| **Crypto Diagnostics** | `verifyWebhookStep` validated signatures, raw payloads, and replay windows. | Added safe categorical verification diagnostics (`verified`, `invalid-payload`, `payload-too-large`, `timestamp-rejected`, `replay-detected`, etc.) without capturing raw payloads, secrets, or signatures. |
| **Notifications & Approvals** | `sendNotificationStep` and `sendInteractiveApprovalStep` dispatched messages; callback tokens used HMAC-SHA256. | Added delivery status, UTC expiration tracking, sandboxed HTML previews with strict CSP, signed telemetry identity in action tokens, and correlated callback resolution telemetry. |
| **AI Completions** | `aiStep` executed models, repair loops, tool turns, and emitted `ai:complete`. | Reused `ai:complete` for zero-duplicate accounting; added per-attempt inference timelines, token consumption, fallback tracking, and opt-in prompt/completion capture. |
| **Testing Doubles** | `createWorkflowHarness` with isolated package mocks (`createMockHttpServer`, `MockAiProvider`, `MockNotificationTransport`). | Preserved package-owned test doubles; established canonical integration cookbook; verified serial execution and isolation under global fetch mocks. |
| **Monitor Server & UI** | Server stored step records; UI rendered generic node cards with basic status. | Unified `EcosystemInspection` schema across ingestion, store, WebSocket transport, and web UI (`StepDetailCard`, `EcosystemInspector`, `InspectionContent`). |

---

## 2. CLI Scaffolding & Code Generation (4A)

### Command Grammar & Options

The command grammar extends `siglo generate step` without breaking backward compatibility for generic steps:

```bash
# HTTP client step
siglo generate step callStripe --type=http --url=https://api.stripe.com/v1/charges

# Webhook signature verification step
siglo generate step verifyStripeWebhook --type=crypto --provider=stripe

# Omnichannel notification step
siglo generate step sendAlert --type=notification --channel=email

# Interactive durable approval step
siglo generate step managerApproval --type=notification --channel=slack --interactive=true

# Generative AI step with structured outputs
siglo generate step triageTicket --type=ai --provider=anthropic --model=claude-3-5-sonnet-20241022
```

### Key Design Decisions (4A)

1. **Scripted Over Interactive**: CLI generation is explicitly scripted via `--key=value` flags rather than interactive prompts. This ensures seamless invocation in CI pipelines, npm scripts, and automated agents. Interactive prompting is deferred to future work.
2. **Factory Pattern Exports**: Generated files export both the step instance and a `create<Name>Step` factory. This allows test suites to inject mock HTTP URLs, AI providers, or notification transports without monkey-patching or modifying generated files.
3. **Overwrite Safety**: Generation checks for existing files at both `<name>.step.ts` and `<name>.step.test.ts`. If either exists, generation halts with code 1, preventing accidental overwrites.
4. **Offline Test Scaffolding**: Every generated step includes a runnable offline unit test utilizing the corresponding package's testing subpath. Consumer test suites execute cleanly without external network access.

---

## 3. Telemetry Pipeline & Privacy Architecture (4B)

### Runtime Telemetry Principles

1. **Zero Impact on Execution**: Telemetry collection is wrapped in try/catch blocks and AsyncLocalStorage scopes. A telemetry failure, serialization error, or logging exception can never cause a workflow step to fail.
2. **Zero Default Content Capture**: Telemetry emits only structural metadata (HTTP methods, response codes, token counts, timestamps, and verification categories). Message bodies, prompts, raw outputs, and headers are never captured unless explicitly configured.
3. **Single AI Completion Event**: Each inference attempt (including retries, repairs, and fallbacks) emits diagnostic attempt records, but completion accounting is unified into the existing `ai:complete` event. This avoids double-counting tokens or misrepresenting workflow billing.
4. **Context Leak Suppression**: Once an ecosystem step runs within a workflow stack, generic context/output telemetry is suppressed for that stack (`hasEcosystemContent(stackId)`). This prevents later generic steps from inadvertently leaking earlier sensitive responses via merged workflow context.

### Fail-Closed Redaction & Bounded Capture

```
┌────────────────────────────────────────────────────────────────────────┐
│                     Multi-Layer Redaction Guardrails                   │
│                                                                        │
│  Step Output / Payload                                                 │
│     │                                                                  │
│     ▼                                                                  │
│  1. Check Field Allowlist (Must be in policy.fields)                   │
│     │                                                                  │
│     ▼                                                                  │
│  2. Deep Clone Value (structuredClone prevents in-flight mutation)     │
│     │                                                                  │
│     ▼                                                                  │
│  3. Application Redactor (policy.redact - required callback)          │
│     │                                                                  │
│     ▼                                                                  │
│  4. Core Automatic Sanitization                                        │
│     • Redact common credential keys (token, secret, apiKey, etc.)      │
│     • Strip embedded URLs -> [URL omitted]                             │
│     • Strip Bearer / Basic tokens -> [Credential omitted]              │
│     • Filter HTTP headers (accept, content-type, content-length,       │
│                            cache-control, retry-after only)            │
│     │                                                                  │
│     ▼                                                                  │
│  5. Bounded Unicode Truncation                                         │
│     • Strict cap at Math.min(maxBytes, 4096) UTF-8 bytes               │
│     • Iterates over complete Unicode code points (no surrogate split)  │
│     │                                                                  │
│     ▼                                                                  │
│  Emitted to Monitor Store / WebSocket Transport                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Web Inspectors & DevTools UI (4C)

The web dashboard (`packages/monitor/ui`) provides dedicated inspector panels rendered within `StepDetailCard`:

### Panel Specifications

- **HTTP Panel**:
  - Displays method, origin-only URL, status, duration, request attempt count, trace ID, and network egress policy.
  - Distinguishes between `retryAfterMs` (parsed from header) and `retryDelayMs` (actual sleep duration).
  - Identifies retry delay source (`'retry-after'` header vs exponential `'backoff'`).
  - Copy cURL button produces strictly origin-only commands (`curl --request POST --url 'https://api.stripe.com'`), omitting paths, query parameters, headers, and bodies.
- **Crypto Webhook Panel**:
  - Displays protocol provider, payload byte size, verification category, and timestamp/replay check outcomes.
  - Excludes raw signatures, webhook secrets, payloads, and internal stack traces.
- **AI Completion Panel**:
  - Displays provider, model ID, prompt tokens, completion tokens, total tokens, latency, repair counts, and fallback transitions.
  - Renders unknown costs explicitly as `"Unavailable"` rather than zero.
  - Provides expandable prompt and raw output timelines when capture is enabled.
- **Notification & Approval Panel**:
  - Displays channel, message ID, masked recipient (e.g., `u***`), approval status (`requested`, `approved`, `rejected`, etc.), and UTC expiration timestamp.
  - Sandboxed Email Preview: Rendered inside an `<iframe>` with empty sandbox (`sandbox=""`) and restrictive CSP (`default-src 'none'; base-uri 'none'; form-action 'none'`). Active HTML tags, scripts, images, links, styles, and attributes are stripped or escaped.
  - Slack messages rendered as safely escaped plaintext.

---

## 5. Offline Testing & Integration Cookbook (4D)

Package-owned testing subpaths provide comprehensive test doubles without introducing heavyweight external dependencies:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowHarness } from '@siglo/testing';
import { createMockHttpServer } from '@siglo/http/testing';
import { MockAiProvider } from '@siglo/ai/testing';
import { MockNotificationTransport } from '@siglo/notifications/testing';

test('Ecosystem pipeline executes offline with synthetic doubles', async () => {
  const http = createMockHttpServer();
  try {
    http.get('https://api.example.com').intercept({ path: '/orders', method: 'POST' }).reply(200, { ok: true });
    const ai = new MockAiProvider([{ text: '{"approved":true}', promptTokens: 10, completionTokens: 5 }]);
    const notifications = new MockNotificationTransport('slack');

    const harness = createWorkflowHarness(createMyWorkflow({ http, ai, notifications }));
    const result = await harness.run({ orderId: '123' });

    assert.equal(result.status, 'COMPLETED');
    http.assertDone();
    ai.assertDone();
  } finally {
    http.close(); // Clean up global fetch mock
  }
});
```

### Testing Rationale

1. **Independent Lifecycles**: HTTP mock replaces global `fetch`; AI provider is injected via model options; notification transport is passed to step options. These represent distinct lifecycles and should not be collapsed into a synthetic global array.
2. **Serial Execution for Global Fetch**: When tests intercept global `fetch`, they must run serially (`--test-concurrency=1`) to avoid cross-test contamination.
3. **Provider Replay vs Step Substitution**: Provider replay tests application logic against recorded network fixtures. Step substitution (`harness.mockStep`) bypasses step execution entirely. Durable continuation (`resumeWorkflow`) restores execution from persistent storage.

---

## 6. Deliverables & Traceability Matrix

### Deliverable Status Overview

| Item | Status | Key Artifacts | Test Suite & Validation |
|---|---|---|---|
| **4A — Scripted CLI Templates** | **Completed** | `packages/cli/src/bin.ts`<br>`packages/cli/src/step-templates.ts`<br>`packages/cli/ECOSYSTEM.md` | `packages/cli/src/step-templates.test.ts`<br>Validates options, collisions, hostile input, and executes 19 generated offline tests. |
| **4B — Safe Telemetry Plumbing** | **Completed** | `packages/core/src/features/events/capture.ts`<br>`packages/core/src/features/events/inspection.ts`<br>`packages/core/src/features/events/redaction.ts`<br>`packages/core/src/features/events/emitter.ts` | `packages/core/src/features/events/capture.test.ts`<br>`packages/core/src/features/events/inspection.test.ts`<br>Validates Unicode bounds, redaction, and error isolation. |
| **4C — Web Inspectors** | **Completed** | `packages/monitor/ui/src/components/workflows/Dag/EcosystemInspector.tsx`<br>`packages/monitor/ui/src/components/workflows/Dag/InspectionContent.tsx`<br>`packages/monitor/ui/src/components/workflows/Dag/curl.ts`<br>`packages/monitor/src/ui/dashboard.ts` | `packages/monitor/src/inspector-ui.test.ts`<br>`packages/monitor/src/websocket-inspection.test.ts`<br>Tests iframe CSP, escaped Slack text, origin-only cURL, and live updates. |
| **4D — Offline Integration & Cookbook** | **Completed** | `packages/monitor/src/ecosystem.integration.test.ts`<br>`packages/monitor/src/content.integration.test.ts`<br>`packages/monitor/src/wait-state.ts` | `packages/monitor/src/ecosystem.integration.test.ts`<br>Executes HTTP → AI → Notification pipeline, webhook rejection, and durable approval resume. |
| **4E — Optional Conveniences** | **Evaluated & Deferred** | N/A | **Decisions Documented Below**: Unified testing re-exports, interactive prompts, and terminal UI deferred. |

---

## 7. Architectural Decisions for 4E (Conveniences Evaluated)

1. **Package-Owned Testing Subpaths Retained (No Unified Re-export)**:
   - *Evaluation*: Considered re-exporting all mock utilities (`createMockHttpServer`, `MockAiProvider`, `MockNotificationTransport`) from `@siglo/testing`.
   - *Decision*: Rejected. `@siglo/testing` currently depends only on `@siglo/core`. Adding ecosystem dependencies to `@siglo/testing` would force every consumer of the test harness to install HTTP, AI, Crypto, and Notification dependencies regardless of whether they are used. Package-owned subpaths (`@siglo/http/testing`, `@siglo/ai/testing`, `@siglo/notifications/testing`) remain clean and idiomatic.
2. **Scripted CLI Maintained (Interactive Prompting Deferred)**:
   - *Evaluation*: Considered introducing an interactive Inquirer-style CLI prompt for step generation.
   - *Decision*: Deferred. Scripted generation using `--key=value` flags is essential for reproducible developer workflows, npm scripts, and automated agents. Interactive wizard prompts will be handled as an optional enhancement in a later release.
3. **Terminal Inspector Deferred**:
   - *Evaluation*: Considered building an in-terminal curses/blessed dashboard for live workflow inspection.
   - *Decision*: Deferred. The web monitor dashboard (`packages/monitor/ui`) provides superior support for graph DAG layouts, rich JSON formatting, copy actions, and sandboxed iframe previews. Terminal-based devtools are tracked separately under Phase 5/6 IDE plugins and CLI extensions.

---

## 8. Monorepo Validation Baseline

All test suites and package builds pass cleanly with 100% statement and line coverage enforced in core:

- **Core (`@siglo/core`)**: 635 unit and integration tests (100% coverage check).
- **Crypto (`@siglo/crypto`)**: 87 cryptographic and webhook verification tests.
- **HTTP (`@siglo/http`)**: 56 client, retry, backoff, and tracing tests.
- **AI (`@siglo/ai`)**: 38 inference, token cost, repair loop, and fallback tests.
- **Notifications (`@siglo/notifications`)**: 45 dispatch, approval, and callback tests.
- **Scheduler (`@siglo/scheduler`)**: 9 wait poller and cloud scheduler tests.
- **Monitor (`@siglo/monitor`)**: 52 server, store, WebSocket, and UI inspector tests.
- **CLI (`@siglo/cli`)**: 16 CLI and generator tests, compiling and running 19 generated offline consumer tests.
- **Code Style & Formatting**: `git diff --check` passes with zero errors or trailing whitespace.
