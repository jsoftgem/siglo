# Phase 2 Roadmap: `@siglo/notifications` (Human-in-the-Loop, Multi-Channel & Resilient Approvals)

> Detailed implementation design, runtime contracts, TypeScript API signatures, and testing specifications for Siglo's multi-channel notification, cryptographic callback, and durable resumption package.

---

## 1. Executive Summary & Problem Space

In enterprise backend workflows, human intervention (e.g., invoice approvals, deployment sign-offs, manual fraud reviews) and multi-channel notifications (Slack, Discord, Email, SMS) are standard operational requirements. However, implementing notifications and interactive callbacks with ad-hoc scripts introduces critical failure modes:

| Ad-Hoc Notification Anti-Pattern | Operational Risk in Distributed Workflows | How `@siglo/notifications` Solves It |
|---|---|---|
| **Unregulated Network Egress** | Notification HTTP calls (Slack, Resend, Twilio) bypass the workflow security perimeter, leaving workflows vulnerable to SSRF or data exfiltration. | Enforces Siglo's AsyncLocalStorage (ASL) network egress perimeter (`allowNetwork`) with static host assertions (`slack.com`, `api.resend.com`, `api.twilio.com`) verified in the `BEFORE` phase. |
| **Split-Brain Dual-Worker Resumption** | Multiple workers behind a load balancer receive the same webhook approval callback simultaneously, resuming the same workflow twice and executing duplicate downstream side effects. | Integrates with Siglo's atomic storage claims (`claimWaitRecord`), CAS state transitions, and idempotency locks, rejecting redundant triggers with `WorkflowAlreadyResumedException` or `DuplicateEventException`. |
| **Dormant Zombie Workflows** | Workflows suspended on approval timeouts (`waitForEvent(..., { timeout: '48h' })`) remain dormant indefinitely if the process restarts or crashes. | Direct integration with `@siglo/scheduler` (`PostgresWaitPoller` with `FOR UPDATE SKIP LOCKED` or Cloud Scheduler dispatchers) to awaken expired approvals deterministically. |
| **Tampered / Replayed Approval Tokens** | Approval URLs in emails or Slack can be forged, manipulated, or replayed by unauthorized users. | Native integration with `@siglo/crypto`: constant-time HMAC tokens (`timingSafeEqual`), replay defense with timestamp tolerance (`toleranceSeconds`), and `KeyRing` key rotation. |
| **Orphaned Notifications on Downstream Failure** | If a workflow fails or cancels after an approval card is sent, users can still click buttons in Slack, triggering invalid state transitions. | Integrates with Siglo's Named Saga Compensation registry (`registerCompensationHandler('cancelNotification')`), updating the Slack card to "Workflow Cancelled" or invalidating the token. |
| **Duplicate Alerts on Step Retries** | Transient failures in downstream steps cause upstream retry re-executions, spamming recipients with duplicate emails or alerts. | Native integration with `@siglo/core`'s `IdempotencyStore` (`buildIdempotencyKey`), deduplicating messages based on workflow ID, step name, and recipient hash. |
| **PII & Credential Leaks** | Recipient emails, phone numbers, and bearer tokens leak into DevTools, OpenTelemetry traces, and server logs. | Automatic context redaction using `@siglo/crypto` path masking and `@siglo/core`'s `redactEvent` before telemetry dispatch. |

---

## 2. Architectural Design & Step Lifecycle Integration

Siglo executes steps through a formal 5-phase lifecycle: `BEFORE` &rarr; `VALIDATION` &rarr; `ACTION` &rarr; `AFTER` &rarr; `COMPENSATE`. `@siglo/notifications` hooks natively into every phase:

```
+---------------------------------------------------------------------------------------------------+
|                            sendInteractiveApprovalStep('managerApproval', ...)                    |
+---------------------------------------------------------------------------------------------------+
| 1. BEFORE Phase (Network Egress & Idempotency Check)                                              |
|    - Dynamically resolves channel, recipient, and template parameters from context.               |
|    - Validates target provider hostname against active AsyncLocalStorage (ASL) network policy     |
|      (e.g., 'slack.com', 'api.resend.com'). Throws NetworkPolicyViolationException if blocked.|
|    - Claims idempotency key via IdempotencyStore (hash of stackId + stepName + recipient).        |
|                                                                                                   |
| 2. VALIDATION Phase (Input & Template Validation)                                                 |
|    - Validates recipient format (RFC 5322 email, E.164 phone number, Slack ID).                  |
|    - Validates template context variables against optional Standard Schema (Zod / Valibot).       |
|                                                                                                   |
| 3. ACTION Phase (Cryptographic Token Generation & Dispatch)                                      |
|    - Generates signed callback action tokens via @siglo/crypto (HMAC-SHA256, expiration, nonce).   |
|    - Links Step timeout signal and Flow AbortSignal to transport HTTP dispatch.                   |
|    - Dispatches payload via configured adapter (Slack Block Kit, Resend HTML, Twilio SMS).        |
|    - Obtains dispatch acknowledgment (messageId, deliveryTimestamp).                              |
|                                                                                                   |
| 4. AFTER Phase (Telemetry & Context Enrichment)                                                   |
|    - Attaches $steps.<name>.notificationMetadata (notificationId, channel, recipientMasked).     |
|    - Emits 'notification:dispatched' and 'approval:requested' monitoring events to DevTools.     |
|                                                                                                   |
| 5. COMPENSATION Phase (Sagas & Interactive Card Invalidation)                                     |
|    - Registers named compensation handler ('cancelNotification') in CompensationManager.          |
|    - If downstream steps fail or workflow aborts, updates Slack card to 'Cancelled' or revokes     |
|      callback URL in storage.                                                                     |
+---------------------------------------------------------------------------------------------------+
                                               |
                                               v
+---------------------------------------------------------------------------------------------------+
|                              waitForEvent('APPROVAL_RECEIVED', { correlationKey, timeout })        |
|                                                                                                   |
| - Suspends workflow execution into durable storage checkpoint (PostgreSQL / Redis).               |
| - Process halts with zero CPU or memory footprint.                                                |
| - Expiration timer registered in siglo_wait_records (monitored by @siglo/scheduler).              |
+---------------------------------------------------------------------------------------------------+
                                               |
        ... Hours or days later: User clicks "Approve" or "Reject" in Slack / Email ...
                                               v
+---------------------------------------------------------------------------------------------------+
|                     Callback Router (@siglo/express / @siglo/fastify / @siglo/hono)               |
|                                                                                                   |
| 1. Verifies HMAC token signature with @siglo/crypto (timingSafeEqual, tolerance window).          |
| 2. Executes atomic resumption claim via storage adapter (claimWaitRecord).                        |
|    * If rowCount === 0: rejects duplicate click with WorkflowAlreadyResumedException (HTTP 409).  |
| 3. Calls resumeWorkflow(flowInstance, correlationKey, { approved: true, deciderId })              |
| 4. Siglo rehydrates checkpoint, checks version migrations, and resumes next step.                 |
+---------------------------------------------------------------------------------------------------+
```

---

## 3. Core Features & Capabilities

### 1. Pluggable Multi-Channel Transports
* **Email**: Resend, SendGrid, Postmark, and generic SMTP with responsive HTML action buttons.
* **Chat**: Slack Web API (interactive Block Kit buttons, modals) and Discord Webhooks (embeds with action links).
* **SMS / Push**: Twilio SMS (two-way SMS reply parsing) and generic mobile push webhooks.

### 2. Zero-Trust Cryptographic Action Tokens
* Leverages `@siglo/crypto` primitives to generate tamper-proof callback tokens without requiring an external database lookup for token verification:
  $$\text{Token} = \text{base64url}(\text{Payload}) \,\|\, \text{HMAC-SHA256}(\text{Payload}, \text{Secret})$$
* Embeds `stackId`, `correlationKey`, `expectedEvent`, and `expiresAt`.
* Verified using `timingSafeEqual` and timestamp tolerance windows to defeat replay and timing attacks.
* Supports secret rotation via `KeyRing` (accepts tokens signed with current or prior key).

### 3. Distributed Durable Resumption & Schedulers
* Seamlessly coordinates with `@siglo/core`'s durable execution:
  * Pairs `sendInteractiveApprovalStep` with `waitForEvent('APPROVAL_RESOLVED', { correlationKey, timeout })`.
  * Multi-worker safe: relies on atomic SQL `FOR UPDATE SKIP LOCKED` claims via `claimWaitRecord`.
  * Background timeouts managed by `@siglo/scheduler` (`PostgresWaitPoller`).

### 4. Sagas & Interactive Message Invalidation
* Implements named compensation handlers (`cancelNotification`).
* When a pipeline aborts or compensates, Siglo automatically calls the channel provider to update the Slack message (e.g., replacing interactive buttons with `"⚠️ Request cancelled due to timeout"`) or marks the token as invalid in storage.

### 5. Web Framework Middleware Adapters
* First-class middleware bindings for `@siglo/express`, `@siglo/fastify`, and `@siglo/hono`.
* Automatically decodes tokens, handles CORS, redirects to user-friendly confirmation pages, and passes resume payloads to `resumeWorkflow()`.

---

## 4. Complete TypeScript API Signatures

```typescript
import { Step, Flow } from 'siglo';
import type { KeyRing } from '@siglo/crypto';
import { StandardSchemaV1 } from '@siglo/http';

export type NotificationChannel = 'email' | 'slack' | 'discord' | 'sms';

export interface NotificationRecipient {
  email?: string;
  phone?: string;
  slackUserId?: string;
  slackChannelId?: string;
  discordWebhookUrl?: string;
}

export interface NotificationMetadata {
  notificationId: string;
  channel: NotificationChannel;
  dispatchedAt: number;
  recipientMasked: string;
}

export interface NotificationTransport {
  readonly channel: NotificationChannel;
  readonly allowedHosts: string[];
  send(message: ResolvedNotificationMessage): Promise<{ id: string; timestamp: number }>;
  cancel?(notificationId: string, reason: string): Promise<void>;
}

export interface ResolvedNotificationMessage {
  to: string | NotificationRecipient;
  subject?: string;
  content: string;
  interactiveActions?: {
    approveUrl: string;
    rejectUrl: string;
    title: string;
    description?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface SendNotificationOptions<TInput> {
  channel: NotificationChannel | ((ctx: TInput) => NotificationChannel);
  recipient: string | NotificationRecipient | ((ctx: TInput) => string | NotificationRecipient);
  subject?: string | ((ctx: TInput) => string);
  template: string | ((ctx: TInput) => string);
  dataSchema?: StandardSchemaV1;
  data?: (ctx: TInput) => Record<string, unknown>;
  /** Idempotency TTL in seconds (default: 86400) */
  deduplicationTtl?: number;
  /** Custom compensation handler if downstream fails */
  compensateOnFailure?: boolean;
}

export function sendNotificationStep<const TName extends string, TInput = any>(
  name: TName,
  options: SendNotificationOptions<TInput>
): Step<TInput, { notificationId: string; sentAt: number; $notificationMetadata: NotificationMetadata }, TName>;

export interface InteractiveApprovalOptions<TInput> {
  channel: 'email' | 'slack';
  recipient: string | NotificationRecipient | ((ctx: TInput) => string | NotificationRecipient);
  title: string | ((ctx: TInput) => string);
  description?: string | ((ctx: TInput) => string);
  /** Durable correlation key generator */
  correlationKey: string | ((ctx: TInput) => string);
  /** Human approval timeout (e.g. '24h', '7d') */
  timeout: string;
  onApproveEvent: string;
  onRejectEvent: string;
  /** Base URL for callback webhooks (e.g. 'https://api.acme.com/siglo/callback') */
  callbackBaseUrl: string;
  /** Secret key or KeyRing instance for HMAC signature */
  signingSecret: string | KeyRing;
  /** Whether to register compensation rollback to update/disable message on workflow failure */
  autoCompensate?: boolean;
}

export function sendInteractiveApprovalStep<const TName extends string, TInput = any>(
  name: TName,
  options: InteractiveApprovalOptions<TInput>
): Step<
  TInput,
  {
    notificationId: string;
    correlationKey: string;
    approvalTokens: { approveUrl: string; rejectUrl: string };
    $notificationMetadata: NotificationMetadata;
  },
  TName
>;

export interface CallbackHandlerOptions {
  signingSecret: string | KeyRing;
  /** Flow instance to resume upon valid webhook receipt */
  workflow: Flow<any, any>;
  onSuccessRedirect?: string;
  onExpiredRedirect?: string;
  onErrorRedirect?: string;
}

/** Express middleware for approval callback handling */
export function createNotificationExpressMiddleware(options: CallbackHandlerOptions): (req: any, res: any) => Promise<void>;

/** Fastify route plugin for approval callback handling */
export function createNotificationFastifyHandler(options: CallbackHandlerOptions): (req: any, reply: any) => Promise<void>;

/** Hono route handler for approval callback handling */
export function createNotificationHonoHandler(options: CallbackHandlerOptions): (c: any) => Promise<Response>;
```

---

## 5. Concrete Usage Scenarios & End-to-End Examples

### Scenario: Multi-Stage Production Deployment with Slack Approval & Schedulers

```typescript
import { flow, waitForEvent, Step } from 'siglo';
import { sendInteractiveApprovalStep } from '@siglo/notifications';
import { StaticKeyRing } from '@siglo/crypto';

interface DeploymentContext {
  deploymentId: string;
  service: string;
  version: string;
  leadDevSlackId: string;
  approved?: boolean;
  decider?: string;
}

const approvalKeyRing = new StaticKeyRing('current', {
  current: process.env.SIGLO_APPROVAL_SECRET_CURRENT!,
  previous: process.env.SIGLO_APPROVAL_SECRET_PREVIOUS!
});

export const productionDeploymentFlow = flow<DeploymentContext, any>(
  // Step 1: Send Slack Block Kit card with interactive HMAC-signed Approve/Reject buttons
  sendInteractiveApprovalStep('requestApproval', {
    channel: 'slack',
    recipient: (ctx) => ({ slackUserId: ctx.leadDevSlackId }),
    title: (ctx) => `Production Deployment Request: ${ctx.service}@${ctx.version}`,
    description: (ctx) => `Deployment ${ctx.deploymentId} requires human sign-off.`,
    correlationKey: (ctx) => `deploy:${ctx.deploymentId}`,
    timeout: '2h',
    onApproveEvent: 'DEPLOY_APPROVED',
    onRejectEvent: 'DEPLOY_REJECTED',
    callbackBaseUrl: 'https://orchestrator.acme.com/api/siglo/callback',
    signingSecret: approvalKeyRing,
    autoCompensate: true // Automatically updates Slack card to 'Cancelled' if downstream fails
  }),

  // Step 2: Flow suspends into PostgreSQL/Redis durable checkpoint with 2h expiration timer
  waitForEvent('DEPLOY_APPROVED', {
    correlationKey: (ctx) => `deploy:${ctx.deploymentId}`,
    timeout: '2h'
  }),

  // Both approval decisions and scheduler expiry resume this continuation.
  // Guard before executing any deployment side effect.
  new Step('requireApproval', async (ctx: DeploymentContext & { event?: { type: string } }) => {
    if (ctx.approved !== true || ctx.event?.type === 'timer:expired') {
      throw new Error('Deployment approval rejected or expired');
    }
    return {};
  }),
  deployToProductionStep
);
```

### Scenario: Setting Up the Express Resumption Endpoint

```typescript
import express from 'express';
import { createNotificationExpressMiddleware } from '@siglo/notifications';
import { productionDeploymentFlow } from './workflow';

const app = express();

app.get(
  '/api/siglo/callback',
  createNotificationExpressMiddleware({
    signingSecret: process.env.SIGLO_APPROVAL_SECRET_CURRENT!,
    workflow: productionDeploymentFlow,
    onSuccessRedirect: 'https://dashboard.acme.com/deployments/approved',
    onExpiredRedirect: 'https://dashboard.acme.com/deployments/expired',
    onErrorRedirect: 'https://dashboard.acme.com/deployments/error'
  })
);

app.listen(3000);
```

---

## 6. Testing Strategy & Zero-Network Verification

1. **Virtual Clock Fast-Forwarding (`@siglo/testing`)**:
   * Uses `@siglo/testing`'s `FakeClock` to fast-forward approval timeouts (`'2h'`, `'48h'`) without real-time delays.
   * Asserts that expired approvals trigger `ExpiredWaitException` and are reclaimed properly.
2. **Deterministic Mock Transports (`MockNotificationTransport`)**:
   * Ships with `@siglo/notifications/testing` containing `MockNotificationTransport`.
   * Records all dispatched payloads, Slack Block Kit structures, and generated action URLs without external network traffic.
3. **Cryptographic Tamper & Replay Validation**:
   * Verifies that tampered payloads, altered correlation keys, or expired timestamps are rejected with `ValidationException`.
   * Tests key rotation: verifies tokens signed with `previous` keys in `KeyRing` are accepted while unknown secrets are rejected.
4. **Atomic Concurrent Resumption Test**:
   * Simulates two concurrent HTTP callbacks hitting the handler with identical tokens simultaneously.
   * Asserts Worker 1 claims the record (`200 OK`) and Worker 2 receives `WorkflowAlreadyResumedException` (`409 Conflict`).
5. **ASL Network Perimeter Egress Assertion**:
   * Asserts that unlisted notification transport hostnames throw `NetworkPolicyViolationException` in the `BEFORE` phase.

---

## 7. Phase 2 Checklist & Deliverables

- [x] Monorepo package directory setup: `packages/notifications`.
- [x] Core notification interfaces and transport registry.
- [x] Network policy static host assertions (`allowNetwork`) on all transports.
- [x] Built-in adapters:
  - [x] Slack (Block Kit interactive cards and message updater).
  - [x] Resend, SendGrid, and SMTP (HTML email action templates).
  - [x] Twilio SMS.
  - [x] Discord Webhooks.
- [x] Cryptographic action token engine integrated with `@siglo/crypto` (`timingSafeEqual`, `KeyRing`, replay defense).
- [x] Resumption web framework adapters:
  - [x] `@siglo/express` callback middleware.
  - [x] `@siglo/fastify` callback plugin.
  - [x] `@siglo/hono` callback handler.
- [x] Named Saga Compensation handler (`cancelNotification`) for revoking stale messages.
- [x] Integration with `@siglo/core`'s `IdempotencyStore`.
- [x] Real PostgreSQL multi-worker/restart integration validation (independent callback workers, persisted revocations, and fresh-process timeout resumption; PostgreSQL 16 verified locally and configured in CI).
- [x] Integration with `@siglo/scheduler` (`PostgresWaitPoller`).
- [x] Deterministic test suite with `MockNotificationTransport` and `@siglo/testing` harness (zero provider network egress; 100% line, statement, function, and branch coverage enforced by `test:coverage`).

### Implementation notes

Implemented in `packages/notifications`. The existing `@siglo/crypto` key provider is
`StaticKeyRing` (`KeyRing` is its provider interface). Callback handlers use the existing atomic core resumption API, and durable
waits are processed by the existing scheduler; applications must configure storage,
register transports and the revocation store, and start their scheduler explicitly.
`PostgresApprovalRevocationStore` supplies shared cancellation state. SMTP uses an
injected client. Confirmation HTML and allowlisted CORS are optional callback settings.
Twilio inbound reply parsing verifies signed form fields but leaves sender/request
authorization to the application. Provider credentials and standard recipient/approval
fields are redacted before monitoring dispatch. Domain-specific PII keys still require
custom redaction configuration.

Validation: notification coverage suite, all core tests, all package tests, monorepo
build, and lint. PostgreSQL unit tests use injected clients; real PostgreSQL 16 integration tests also
verify independent-process callback claims, persisted revocations and timeout recovery.
Live provider and browser end-to-end tests are not included.

Additional capabilities now implemented: Postmark, configurable HTTPS push webhooks,
Slack modal opening from interaction triggers, Discord action embeds, responsive email
markup, and `NotificationMonitor` using crypto wildcard path masking. Notification
validation uses native schemas and notification events use the after hook. Core runs
schema validation before `onBefore`; the lifecycle diagram above is conceptual and
does not reflect that pre-existing runtime ordering.

The PostgreSQL integration suite (`npm run test:postgres --workspace=@siglo/notifications`)
uses separate Node processes and a dedicated `SIGLO_TEST_POSTGRES_URL`. CI supplies a
PostgreSQL 16 service. This is distinct from the zero-provider-network unit suite.
