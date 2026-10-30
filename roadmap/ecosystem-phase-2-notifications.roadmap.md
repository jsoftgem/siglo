# Phase 2 Roadmap: `@siglo/notifications` (Human-in-the-Loop & Multi-Channel)

> Detailed implementation design, runtime contracts, TypeScript API signatures, and testing specifications for Siglo's multi-channel notification and durable resumption package.

---

## 1. Executive Overview

Phase 2 introduces **`@siglo/notifications`**, a channel-agnostic messaging step framework engineered specifically for workflow orchestrations. Beyond standard email and chat dispatch, `@siglo/notifications` provides first-class integration with Siglo’s durable execution engine (`waitForEvent()` and `resumeWorkflow()`).

Interactive notifications (such as Slack action blocks or approval emails) embed cryptographically signed callback links. When a user clicks "Approve" or "Reject", a lightweight webhook handler decodes the token and seamlessly awakens the suspended workflow.

---

## 2. Architecture & Runtime Lifecycle

```
[Workflow Starts]
       |
       v
+---------------------------------------------------------------------------------+
| sendInteractiveApprovalStep('managerApproval', { ... })                         |
|                                                                                 |
| 1. Idempotency Key Claim                                                        |
|    - Computes hash(workflowId, stepName, recipient)                             |
|    - Checks IdempotencyStore to prevent duplicate messages during retries       |
|                                                                                 |
| 2. Signed Action Token Generation                                               |
|    - Generates signed HMAC token with workflowId, expectedEvent, expiration     |
|                                                                                 |
| 3. Channel Transport Dispatch                                                   |
|    - Formats interactive payload (Slack Block Kit, Discord Embed, HTML Email)   |
|    - Dispatches via configured adapter (Slack, Resend, SendGrid, Twilio)        |
+---------------------------------------------------------------------------------+
       |
       v
+---------------------------------------------------------------------------------+
| waitForEvent('MANAGER_APPROVED', { timeout: '48h' })                            |
|                                                                                 |
| - Siglo suspends workflow execution into durable checkpoint (Postgres/Redis)    |
| - Execution halts with zero CPU or memory consumption                           |
+---------------------------------------------------------------------------------+
       |
       | ... Hours or days later: User clicks "Approve" in Slack / Email ...
       v
+---------------------------------------------------------------------------------+
| Siglo Callback Webhook (Express / Fastify / Hono adapter)                       |
|                                                                                 |
| 1. Decodes and verifies signed action token                                     |
| 2. Calls resumeWorkflow(workflowId, { event: 'MANAGER_APPROVED', ... })          |
| 3. Siglo rehydrates checkpoint and resumes next workflow step                   |
+---------------------------------------------------------------------------------+
```

---

## 3. Core Features & Capabilities

1. **Pluggable Multi-Channel Adapters**:
   - **Email**: Resend, SendGrid, Postmark, generic SMTP.
   - **Chat**: Slack Webhooks / Slack Web API (Block Kit), Discord Webhooks.
   - **SMS / Mobile**: Twilio, AWS SNS.
2. **Durable Interactive Approvals**:
   - Automatically pairs notification dispatch with Siglo's `waitForEvent()`.
   - Embeds secure tokens and action URLs without requiring custom database tracking.
3. **Automatic Deduplication & Idempotency**:
   - Integrates with Siglo's `IdempotencyStore`. Prevents duplicate notifications when a workflow recovers from a crash or retries an upstream failure.
4. **Typed Dynamic Templating**:
   - Context-aware template engines supporting Markdown, HTML, and Mustache-style interpolation with full TypeScript validation.

---

## 4. TypeScript API Signatures

```typescript
import { Step } from 'siglo';

export type NotificationChannel = 'email' | 'slack' | 'discord' | 'sms';

export interface NotificationTransport {
  send(message: ResolvedNotificationMessage): Promise<{ id: string; timestamp: number }>;
}

export interface SendNotificationOptions<TInput> {
  channel: NotificationChannel | ((ctx: TInput) => NotificationChannel);
  recipient: string | string[] | ((ctx: TInput) => string | string[]);
  subject?: string | ((ctx: TInput) => string);
  template: string | ((ctx: TInput) => string);
  data?: (ctx: TInput) => Record<string, unknown>;
  /** Optional idempotency TTL in seconds (default: 86400) */
  deduplicationTtl?: number;
}

export function sendNotificationStep<const TName extends string, TInput>(
  name: TName,
  options: SendNotificationOptions<TInput>
): Step<TInput, { notificationId: string; sentAt: number }>;

export interface InteractiveApprovalOptions<TInput> {
  channel: 'email' | 'slack';
  recipient: string | ((ctx: TInput) => string);
  title: string | ((ctx: TInput) => string);
  description?: string | ((ctx: TInput) => string);
  timeout: string; // e.g. '24h', '7d'
  onApproveEvent: string;
  onRejectEvent: string;
  /** Secret key used to sign callback tokens */
  signingSecret?: string;
  callbackBaseUrl: string; // e.g. 'https://api.acme.com/siglo/callback'
}

export function sendInteractiveApprovalStep<const TName extends string, TInput>(
  name: TName,
  options: InteractiveApprovalOptions<TInput>
): Step<TInput, { notificationId: string; approvalTokens: { approveUrl: string; rejectUrl: string } }>;

/** Fastify / Express / Hono router handler for resuming interactive workflows */
export function createNotificationCallbackHandler(options: {
  signingSecret: string;
  onSuccessRedirect?: string;
  onExpiredRedirect?: string;
}): (req: any, res: any) => Promise<void>;
```

---

## 5. Concrete Usage Example

```typescript
import { flow, waitForEvent } from 'siglo';
import { sendInteractiveApprovalStep } from '@siglo/notifications';

interface DeploymentContext {
  deploymentId: string;
  service: string;
  leadDevSlackId: string;
}

export const productionDeploymentFlow = flow(
  // 1. Dispatch interactive approval request with buttons
  sendInteractiveApprovalStep('requestApproval', {
    channel: 'slack',
    recipient: (ctx: DeploymentContext) => ctx.leadDevSlackId,
    title: (ctx: DeploymentContext) => `Production Deployment: ${ctx.service}`,
    description: 'Requires sign-off before canary routing begins.',
    timeout: '2h',
    onApproveEvent: 'DEPLOY_APPROVED',
    onRejectEvent: 'DEPLOY_REJECTED',
    callbackBaseUrl: 'https://orchestrator.acme.com/api/siglo-callback',
  }),

  // 2. Flow halts, persisting state to PostgreSQL/Redis checkpoint
  waitForEvent('DEPLOY_APPROVED', { timeout: '2h' }),

  // 3. Resumes here once approved
  deployCanaryStep
);
```

---

## 6. Testing Strategy

1. **Virtual Clock Verification**:
   - Use `@siglo/testing`'s `FakeClock` to fast-forward approval timeouts ('2h', '48h') and assert that expired approvals trigger `ExpiredWaitException`.
2. **Deterministic Mock Transports**:
   - Ship `@siglo/notifications/testing` with `MockNotificationTransport` to inspect dispatched emails, Slack payload structures, and signed URLs without external network access.
3. **Token Tampering Tests**:
   - Verify that forged, altered, or expired callback tokens are rejected by the callback handler with `ValidationException`.

---

## 7. Phase 2 Checklist & Deliverables

- [ ] Monorepo package directory setup: `packages/notifications`.
- [ ] Core notification interfaces and transport registry.
- [ ] Built-in adapters:
  - [ ] Slack (Block Kit & interactive action buttons).
  - [ ] Resend / SendGrid / SMTP (HTML emails with action links).
  - [ ] Twilio SMS.
- [ ] Signed callback token engine (HMAC signature + expiration timestamp).
- [ ] Fastify, Express, and Hono resumption callback middleware.
- [ ] Integration with `@siglo/core`'s `IdempotencyStore`.
- [ ] Deterministic test harness with `MockNotificationTransport`.
- [ ] Comprehensive documentation and end-to-end interactive workflow example.
