# Phase 4 Roadmap: Developer Experience, CLI & Live DevTools Integration

> Revised against the repository on 2026-11-04. Status: design revision complete;
> Phase 4 runtime, generator, and UI work remains unimplemented.

## 1. Current project baseline

Phase 4 is feasible, but the original design cannot be implemented literally.
Use the existing package APIs and deliver telemetry before adding inspectors.

| Area | Existing implementation | Required Phase 4 change |
|---|---|---|
| CLI | `packages/cli/src/bin.ts` supports `generate step <name>`; `generateStep` in `src/index.ts` writes a generic step and test. Options currently use `--key=value`. | Extend this command and function without breaking generic generation. |
| HTTP | `httpStep` automatically declares a static URL hostname with `allowNetwork`; results include `data`, `$httpMetadata`, and `httpMetadata`. | Generate against these contracts; add sanitized request/attempt telemetry for inspectors. |
| Crypto | `verifyWebhookStep` accepts raw payload, signature, secret, and provider resolvers; returns verification metadata and throws on invalid input/signatures. | Generate actual verification steps and signed fixtures; add safe failure diagnostics. |
| Notifications | `sendNotificationStep` and `sendInteractiveApprovalStep` are distinct APIs. `NotificationMonitor` masks configured event paths. | Distinguish delivery from durable approval and preserve existing masking. |
| AI | `aiStep` accepts `model: { provider, model, adapter? }`; returns `{ data, $aiMetrics, aiMetrics }`. `recordAiCompletion` emits `ai:complete` with token, cost, repair, and fallback metrics. | Reuse this event; add opt-in content/attempt capture only where needed. |
| Testing | `createWorkflowHarness` accepts `services`, clock, storage, and trace options. It supports `mockStep`; no `createTestHarness` or `providers` array exists. | Compose existing mocks explicitly; do not invent a second injection mechanism. |
| Monitor | Server `StepRunRecord` stores `outputSummary`; UI `StepRun` lacks it. `StepDetailCard` shows generic status, attempts, duration, and errors. | Carry typed ecosystem data through ingestion, store, API, WebSocket updates, and UI. |

Existing offline utilities are `createMockHttpServer` from `@siglo/http/testing`,
`MockAiProvider` from `@siglo/ai/testing`, and `MockNotificationTransport` from
`@siglo/notifications/testing`. The HTTP mock replaces global fetch and must be
closed in `finally`; AI adapters are injected through model configuration.
Notification mocks are supplied at the transport boundary. These are different
lifecycles, not interchangeable provider registrations.

## 2. CLI scaffolding

### Command contract

Extend the current grammar, keeping generic generation as the default:

```bash
siglo generate step callStripe --type=http --url=https://api.stripe.com/v1/charges
siglo generate step verifyStripeWebhook --type=crypto --provider=stripe
siglo generate step managerApproval --type=notification --channel=slack --interactive=true
siglo generate step triageTicket --type=ai --provider=anthropic --model=<model-id>
```

These are proposed extensions, not commands available today. Do not introduce
`generate:step` unless an explicit compatibility alias is desired. Interactive
prompting is a later enhancement; scripted generation is the first deliverable.
Model IDs are caller supplied and should not be pinned to the original example.

Extend `generateStep(name, targetDir, options?)` with a discriminated options
union and retain its current return shape. Validate options before writing files.
Reject unsupported providers/channels, invalid identifiers, missing required
options, and destination collisions without overwriting user files. Treat URL,
name, model, and provider values as data when emitting TypeScript literals.

### Generated artifacts

- HTTP: use `httpStep` with explicit method and request/response schema examples.
  Preserve static host declaration and explain dynamic URL egress configuration.
- Crypto: use `verifyWebhookStep` with raw bytes/string input, signature headers,
  and a runtime secret resolver. Tests generate a valid local signature and cover
  rejection; never embed production secrets or reserialize the signed body.
- Notifications: generate delivery by default, approval only with the explicit
  interactive option. Supply transport construction and callback/durable storage
  setup instructions appropriate to the selected channel.
- AI: use `aiStep` and its model configuration object; offer a concrete Standard
  Schema compatible validator example and assert the wrapped `data` output.
  A Zod example must declare the dependency rather than assuming it exists.

Each template includes an offline test using the existing package testing
subpath. Document runtime, validator, test runner, and testing dependencies.
Schema imports are needed where validation is used, not indiscriminately in all
four templates. Generated code and tests must compile and execute in a temporary
consumer project; text snapshots alone are insufficient verification.

## 3. Telemetry contracts before inspectors

### Delivery order

1. Define optional, versioned, discriminated ecosystem inspection data in the
   core monitoring contract. Keep existing events and generic steps compatible.
2. Emit sanitized diagnostics from package execution paths, including failures.
   Reuse `ai:complete` instead of emitting duplicate completion metrics.
3. Update monitor ingestion validation/redaction, store records, API snapshots,
   WebSocket handling, and frontend types/reducers together. Correlate by stack,
   runtime step identity, and attempt; verify repeated step names and nested flows.
4. Add dedicated sections to `StepDetailCard`, selecting by explicit ecosystem
   kind. AST inspection can advertise capabilities but cannot supply runtime
   request/response data. Missing diagnostics must remain a supported state.

Keep observation best effort: telemetry failures must not alter execution.
Capture bounded summaries by default. Bodies, prompts, and outputs require an
explicit capture policy, byte limits, and truncation markers. Redact before
storage and transport, including errors, URLs/query strings, headers, callback
URLs, signatures, and copied snippets. A UI masking toggle must never reveal
values already redacted at the server.

### Inspector scope

| Inspector | Initial display | Additional capture needed |
|---|---|---|
| HTTP | Method, sanitized URL, status, duration, attempt count, trace correlation, known policy outcome | Per-attempt timings, retry delays/Retry-After, bounded request/response headers and bodies, sanitized cURL export |
| Crypto | Provider, verification success/failure category, timestamp/replay outcome, payload size | Explicit safe diagnostic events; exclude secrets, raw signatures and payloads. Timing-safe comparison implementation is not a measurable security guarantee in the UI. |
| Notifications | Channel, delivery status, message ID, approval wait/callback lifecycle and expiry | Sanitized preview and durable expiry metadata. Show token status only, never callback credentials. Render HTML in an isolated sandbox and Slack content as escaped structured data. |
| AI | Existing token counts, estimated cost when known, model/provider, latency, repairs and fallbacks | Opt-in prompt timeline, bounded raw/parsed output, individual attempt events. Label unknown cost as unavailable, not zero. |

The initial UI target is the existing web dashboard in `packages/monitor/ui`.
A terminal inspector is a separate future project; the current CLI does not
provide a terminal dashboard to extend. Rebuild the bundled dashboard through
its build process; do not edit generated `packages/monitor/src/ui/dashboard.ts`.

## 4. Offline testing and replay

Retain package-owned mock APIs and show explicit wiring in workflow factories:

```typescript
import { createWorkflowHarness } from '@siglo/testing';
import { createMockHttpServer } from '@siglo/http/testing';
import { MockAiProvider } from '@siglo/ai/testing';
import { MockNotificationTransport } from '@siglo/notifications/testing';

// Application-defined factory: inject adapter into aiStep's model config,
// and transport into notification configuration.
import { createMyEcosystemFlow } from './myFlow';

const http = createMockHttpServer();
try {
  http.get('https://api.example.test')
    .intercept({ path: '/charges', method: 'POST' })
    .reply(200, { chargeId: 'ch_123' });
  const ai = new MockAiProvider([{
    text: '{"recommendedAction":"APPROVE"}',
    promptTokens: 10,
    completionTokens: 5,
  }]);
  const notifications = new MockNotificationTransport('email');
  const harness = createWorkflowHarness(createMyEcosystemFlow({ ai, notifications }));
  const result = await harness.run({ customerId: 'cust_99' });
  // Assert application-specific output mapping, including AI's data wrapper.
  http.assertDone();
  ai.assertDone();
} finally {
  http.close();
}
```

This illustrates proposed cookbook wiring; the application factory is not a
library export. Do not promise complete network isolation merely from installing
an HTTP fetch mock: cover each transport/adapter used and reject unexpected calls.
Tests using the global HTTP mock must run serially and verify restoration after
failure. Inject supported clocks/sleep hooks; the harness fake clock does not
replace every package's wall clock automatically.

Build integration examples on `MockAiProvider` recording/replay and existing
`replayExecution` fixture substitution. Specify what replay validates: executing
with provider fixtures, substituting entire steps, and resuming a durable
checkpoint are different operations. Sanitized recordings may omit data needed
for exact replay; use synthetic fixtures for reproducible examples.

Unified testing exports are optional convenience work after these examples.
If introduced, prefer a dedicated ecosystem subpath with explicit dependency
handling; `@siglo/testing` currently depends only on `siglo`. Avoid adding all
ecosystem packages to every harness consumer simply for re-exports.

## 5. Implementation sequence and acceptance criteria

- [ ] **4A — Scripted CLI templates.** Extend the existing command/options API;
  preserve generic output; validate input and refuse overwrite. Compile and run
  all generated offline tests in a consumer fixture. Test command errors and
  hostile literal values as well as successful generation.
- [ ] **4B — Safe telemetry plumbing.** Define compatible events and inspection
  records; connect emitters through store/API/WebSocket/UI types. Verify failure,
  retry, repeated-name, nested-flow and missing-data behavior. Test redaction
  before persistence and transmission, truncation, and observer failures.
- [ ] **4C — Web inspectors.** Deliver HTTP, crypto, notification, and AI panels
  on the shared contract. Verify sanitized cURL, isolated previews, unavailable
  fields, unknown cost, and updates during execution. Test malicious preview
  content and ensure secrets cannot be recovered through copy/export actions.
- [ ] **4D — Offline integration and cookbook.** Add a complete synthetic
  HTTP → AI → notification example, webhook signature rejection, AI queue
  exhaustion/replay mismatch, notification failure, and durable approval resume.
  Verify no unexpected outbound calls and cleanup on exceptions.
- [ ] **4E — Optional conveniences.** Evaluate ecosystem testing re-exports and
  interactive generation after 4A–4D. Track terminal tooling separately.

Validation must include targeted package tests and builds for changed packages,
plus monitor UI and bundled server dashboard builds when inspector work lands.
This revision changes the implementation plan only; it does not mark the
runtime deliverables above complete.
