# @siglo/notifications

> Security migration: read [approval authorization, POST confirmation, durable recovery and delivery guarantees](../../docs/adapters/notification-hardening.md). GET is read-only; configure `authorize` or explicitly opt into `allowBearerApproval`.

Enterprise multi-channel notifications, tamper-proof cryptographic approval tokens, and durable human-in-the-loop callback resumption for Siglo workflows.

[![npm version](https://img.shields.io/npm/v/@siglo/notifications.svg)](https://www.npmjs.com/package/@siglo/notifications)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Coverage: 100%](https://img.shields.io/badge/Coverage-100%25-brightgreen.svg)](https://github.com/jsoftgem/siglo)

---

## 1. Overview & Architecture

In enterprise backend workflows, human intervention (e.g. invoice approvals, production deployment gates, manual fraud reviews) and notifications across Slack, Email, Discord, and SMS are critical. `@siglo/notifications` integrates these patterns directly into Siglo's 5-phase step lifecycle:

```mermaid
flowchart TD
    subgraph Execution["1. Workflow Dispatch & Suspension"]
        Step["sendInteractiveApprovalStep('managerApproval', ...)"]
        EgressCheck["Assert Transport Host in ASL Network Policy"]
        IdempCheck["Claim Idempotency Key (stackId:stepName:recipientHash)"]
        TokenGen["Generate HMAC-SHA256 Signed Action URLs (KeyRing)"]
        Dispatch["Dispatch via Provider (Slack Block Kit / HTML Email)"]
        Wait["waitForEvent('APPROVAL_RESOLVED', { correlationKey, timeout })"]
        Suspend["Checkpoint to PostgreSQL / Redis (Zero Memory Footprint)"]

        Step --> EgressCheck --> IdempCheck --> TokenGen --> Dispatch --> Wait --> Suspend
    end

    subgraph Resumption["2. Webhook Callback & Distributed Resumption"]
        User(["Human Approver clicks 'Approve' or 'Reject'"])
        Router["Callback Router (@siglo/express, fastify, hono)"]
        Verify["verifyActionToken() (timingSafeCompare, tolerance window)"]
        RevokeCheck{"isRevoked(correlationKey)?"}
        ClaimWait["Atomic Storage Claim: claimWaitRecord(correlationKey)"]
        ResumeFlow["resumeWorkflow(flow, correlationKey, { approved: true })"]
        Duplicate["Reject with 409 Conflict (WorkflowAlreadyResumedException)"]

        User --> Router --> Verify --> RevokeCheck
        RevokeCheck -- Yes (Cancelled) --> Duplicate
        RevokeCheck -- No --> ClaimWait
        ClaimWait -- Claim Won (200 OK) --> ResumeFlow
        ClaimWait -- Already Claimed (409) --> Duplicate
    end

    subgraph Scheduler["3. Timeout Awakening (Dormant Resumption)"]
        ExpiredWait["Approval Timeout Elapsed ('2h', '48h')"]
        Poller["@siglo/scheduler (PostgresWaitPoller / session locks)"]
        TimeoutResume["resumeWorkflow(..., { event: 'timer:expired', allowExpired: true })"]

        ExpiredWait --> Poller --> TimeoutResume
    end
```

---

## 2. Installation & Requirements

Install `@siglo/notifications` alongside `@siglo/core`, `@siglo/crypto`, and `@siglo/http`:

```bash
npm install @siglo/notifications @siglo/crypto @siglo/http @siglo/core
```

Peer dependencies:

- `@siglo/core`: `^1.0.0`
- `@siglo/crypto`: `^1.0.0`
- `@siglo/http`: `^1.0.0`
- `@siglo/scheduler` (optional, for background timeout polling): `^1.0.0`
- `@siglo/postgres` (optional, for persistent checkpoints and shared revocation): `^1.0.0`

---

## 3. Quick Start: Interactive Human Approval Flow

```typescript
import express from 'express';
import { flow, waitForEvent, Step, useStorage } from '@siglo/core';
import { PostgresStorageAdapter } from '@siglo/postgres';
import { StaticKeyRing } from '@siglo/crypto';
import {
    registerNotificationTransport,
    SlackTransport,
    sendInteractiveApprovalStep,
    createNotificationExpressMiddleware,
    configureApprovalRevocationStore,
    PostgresApprovalRevocationStore,
    PostgresNotificationDispatchStore,
    configureNotificationDispatchStore,
} from '@siglo/notifications';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const storage = new PostgresStorageAdapter({ client: pool });
await storage.ensureTables();
useStorage(storage);

// 1. Shared revocation store across workers
const revocationStore = new PostgresApprovalRevocationStore(pool);
await revocationStore.initialize();
configureApprovalRevocationStore(revocationStore);
const dispatchStore = new PostgresNotificationDispatchStore(pool);
await dispatchStore.initialize();
configureNotificationDispatchStore(dispatchStore);

// 2. Register transports globally (or pass per-step)
registerNotificationTransport(
    new SlackTransport({
        apiKey: process.env.SLACK_BOT_TOKEN!,
    }),
);

// 3. Define KeyRing for HMAC signing and key rotation
const approvalKeyRing = new StaticKeyRing('primary', {
    primary: process.env.APPROVAL_SECRET_CURRENT!,
    previous: process.env.APPROVAL_SECRET_PREVIOUS!,
});

// 4. Define the approval workflow
export const deploymentWorkflow = flow(
    // Step 1: Send Slack Block Kit card with signed Approve/Reject buttons
    sendInteractiveApprovalStep('requestApproval', {
        channel: 'slack',
        recipient: (ctx: { leadDevSlackId: string }) => ({ slackUserId: ctx.leadDevSlackId }),
        title: (ctx: { service: string; version: string }) => `Deploy ${ctx.service}@${ctx.version}?`,
        description: (ctx: { deploymentId: string }) => `Deployment ID: ${ctx.deploymentId}`,
        correlationKey: (ctx: { deploymentId: string }) => `deploy:${ctx.deploymentId}`,
        timeout: '2h',
        onApproveEvent: 'APPROVAL_RESOLVED',
        onRejectEvent: 'APPROVAL_RESOLVED',
        callbackBaseUrl: 'https://orchestrator.acme.com/api/siglo/callback',
        signingSecret: approvalKeyRing,
        autoCompensate: true, // Updates Slack card to 'Cancelled' on failure or rollback
    }),

    // Step 2: Suspends workflow into PostgreSQL durable checkpoint with a 2h timer
    waitForEvent('APPROVAL_RESOLVED', {
        correlationKey: (ctx: { deploymentId: string }) => `deploy:${ctx.deploymentId}`,
        timeout: '2h',
    }),

    // Step 3: Guard on approved decision before executing side effects
    new Step('verifyDecision', async (ctx: { approved?: boolean; event?: { type: string } }) => {
        if (ctx.approved !== true || ctx.event?.type === 'timer:expired') {
            throw new Error('Deployment approval was rejected or expired');
        }
        return { verified: true };
    }),

    deployServiceStep,
);

// 5. Expose callback endpoint in Express
const app = express();
app.use(express.urlencoded({ extended: false }));
app.all(
    '/api/siglo/callback',
    createNotificationExpressMiddleware({
        workflow: deploymentWorkflow,
        signingSecret: approvalKeyRing,
        authorize: authorizeApproval, // Application identity and CSRF check; see migration guide.
        responseFormat: 'html',
        allowedOrigins: ['https://orchestrator.acme.com', 'https://dashboard.acme.com'],
    }),
);
app.listen(3000);
```

---

## 4. Multi-Channel Transports

`@siglo/notifications` ships with built-in adapters that adhere to Siglo's AsyncLocalStorage (ASL) network egress perimeter and require zero third-party SDK dependencies (using native HTTPS with validated socket DNS resolution):

| Transport              | Channel   | Allowed Hosts         | Key Features                                                                                  |
| ---------------------- | --------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `SlackTransport`       | `slack`   | `slack.com`           | Block Kit action buttons, message cancellation via `chat.update`, modal forms via `openModal` |
| `ResendTransport`      | `email`   | `api.resend.com`      | Responsive HTML email action templates                                                        |
| `SendGridTransport`    | `email`   | `api.sendgrid.com`    | HTML email dispatch with `x-message-id` tracking                                              |
| `PostmarkTransport`    | `email`   | `api.postmarkapp.com` | HTML + plain-text email with server token auth                                                |
| `SmtpTransport`        | `email`   | User-defined host     | Injected SMTP client (`sendMail`) without bundled dependencies                                |
| `DiscordTransport`     | `discord` | `discord.com`         | Webhook embeds with clickable action links                                                    |
| `TwilioTransport`      | `sms`     | `api.twilio.com`      | Basic SMS dispatch and two-way signed webhook parsing                                         |
| `PushWebhookTransport` | `push`    | Webhook hostname      | Provider-neutral JSON push payloads over HTTPS                                                |

### Transport Configuration Examples

```typescript
import {
    SlackTransport,
    ResendTransport,
    SendGridTransport,
    PostmarkTransport,
    DiscordTransport,
    TwilioTransport,
    SmtpTransport,
    PushWebhookTransport,
    registerNotificationTransport,
} from '@siglo/notifications';

// Slack
registerNotificationTransport(
    new SlackTransport({
        apiKey: process.env.SLACK_BOT_TOKEN!,
    }),
);

// Resend Email
registerNotificationTransport(
    new ResendTransport({
        apiKey: process.env.RESEND_API_KEY!,
        from: 'ops@acme.com',
    }),
);

// SendGrid Email
registerNotificationTransport(
    new SendGridTransport({
        apiKey: process.env.SENDGRID_API_KEY!,
        from: 'ops@acme.com',
    }),
);

// Postmark Email
registerNotificationTransport(
    new PostmarkTransport({
        apiKey: process.env.POSTMARK_SERVER_TOKEN!,
        from: 'ops@acme.com',
    }),
);

// Discord
registerNotificationTransport(new DiscordTransport());

// Twilio SMS
registerNotificationTransport(
    new TwilioTransport({
        accountSid: process.env.TWILIO_ACCOUNT_SID!,
        authToken: process.env.TWILIO_AUTH_TOKEN!,
        from: '+15551234567',
    }),
);

// Generic SMTP (e.g. Nodemailer)
registerNotificationTransport(
    new SmtpTransport({
        host: 'smtp.mailgun.org',
        from: 'no-reply@acme.com',
        sendMail: async mail => nodemailerTransport.sendMail(mail),
    }),
);

// Generic HTTPS Push Webhook
registerNotificationTransport(
    new PushWebhookTransport({
        url: 'https://push.acme.com/v1/notify',
        headers: { 'X-Service-Token': process.env.PUSH_SERVICE_TOKEN! },
    }),
);
```

---

## 5. Workflow Step API

### `sendNotificationStep(name, options)`

Dispatches one-way alerts (email, chat, SMS, push) with automatic idempotency deduplication and context redaction:

```typescript
import { sendNotificationStep } from '@siglo/notifications';

const alertOps = sendNotificationStep('alertOps', {
    channel: 'slack',
    recipient: { slackChannelId: 'C_OPS_ALERTS' },
    template: ctx => `High latency detected on ${ctx.serviceName}: ${ctx.p99}ms`,
    deduplicationTtl: 3600, // Suppresses duplicate alerts within 1 hour
});
```

### `sendInteractiveApprovalStep(name, options)`

Generates signed action tokens, formats interactive cards/emails, registers compensation rollbacks, and attaches approval metadata:

```typescript
import { sendInteractiveApprovalStep } from '@siglo/notifications';

const approvalStep = sendInteractiveApprovalStep('legalApproval', {
    channel: 'email',
    recipient: ctx => ({ email: ctx.legalReviewerEmail }),
    title: ctx => `Contract Review Required: ${ctx.contractTitle}`,
    description: ctx => `Value: $${ctx.contractValue}`,
    correlationKey: ctx => `contract:${ctx.contractId}`,
    timeout: '72h',
    onApproveEvent: 'CONTRACT_APPROVED',
    onRejectEvent: 'CONTRACT_REJECTED',
    callbackBaseUrl: 'https://api.acme.com/siglo/callback',
    signingSecret: process.env.APPROVAL_SECRET!,
    autoCompensate: true,
});
```

---

## 6. Cryptographic Action Tokens & Secret Rotation

Action tokens embed callback metadata in a compact URL-safe format:

$$\text{Token} = \text{base64url}(\text{Payload}) \,\|\, \text{base64url}(\text{HMAC-SHA256}(\text{Payload}, \text{Secret}))$$

### Features:

- **No Database Lookup on Verification**: Validates authenticity and expiration instantly before accessing storage.
- **Constant-Time Verification**: Uses `@siglo/crypto`'s `timingSafeCompare` to defeat timing attacks.
- **Replay handling**: Durable claims reject completed requests. `toleranceSeconds` checks future issuance only; nonces are not independently consumed.
- **Key Rotation**: Compatible with `@siglo/crypto`'s `StaticKeyRing` to verify tokens signed with previous keys during rotation windows.

```typescript
import { StaticKeyRing } from '@siglo/crypto';
import { signActionToken, verifyActionToken } from '@siglo/notifications';

const keyRing = new StaticKeyRing('v2', {
    v2: 'current-secret-key-2026',
    v1: 'legacy-secret-key-2025',
});

// Verify token
const payload = await verifyActionToken(tokenString, keyRing, {
    toleranceSeconds: 60, // Allow 60s future clock skew
});
```

---

## 7. Web Framework Resumption Handlers

First-class route handlers are provided for `@siglo/express`, `@siglo/fastify`, and `@siglo/hono` with built-in security headers, CORS preflight handling, and response customization:

### Supported Security Headers

- `Cache-Control: no-store`
- `Referrer-Policy: no-referrer`
- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`

### Express Example

```typescript
import express from 'express';
import { createNotificationExpressMiddleware } from '@siglo/notifications';

const app = express();
app.use(express.urlencoded({ extended: false }));

app.all(
    '/api/siglo/callback',
    createNotificationExpressMiddleware({
        workflow: orderFlow,
        signingSecret: process.env.APPROVAL_SECRET!,
        authorize: authorizeApproval, // Application identity and CSRF check; see migration guide.
        responseFormat: 'html', // Renders accessible confirmation page
        allowedOrigins: ['https://orchestrator.acme.com', 'https://dashboard.acme.com'],
        onSuccessRedirect: 'https://dashboard.acme.com/approvals/success',
        onExpiredRedirect: 'https://dashboard.acme.com/approvals/expired',
        onErrorRedirect: 'https://dashboard.acme.com/approvals/error',
    }),
);
```

### Fastify Example

```typescript
import Fastify from 'fastify';
import { createNotificationFastifyHandler } from '@siglo/notifications';

const fastify = Fastify();
const handler = createNotificationFastifyHandler({
    workflow: orderFlow,
    signingSecret: process.env.APPROVAL_SECRET!,
    authorize: authorizeApproval, // Application authentication and CSRF check.
});
fastify.route({ method: ['GET', 'POST'], url: '/api/siglo/callback', handler });
```

### Hono Example (Node)

```typescript
import { Hono } from 'hono';
import { createNotificationHonoHandler } from '@siglo/notifications';

const app = new Hono();
app.all(
    '/api/siglo/callback',
    createNotificationHonoHandler({
        workflow: orderFlow,
        signingSecret: process.env.APPROVAL_SECRET!,
        authorize: authorizeApproval,
    }),
);
```

---

## 8. Inbound Twilio SMS Two-Way Approvals

Parse and cryptographically verify inbound SMS approval webhooks (`APPROVE <ref>` or `REJECT <ref>`) adhering to Twilio's signed form specification:

```typescript
import { parseTwilioSmsReply } from '@siglo/notifications';

app.post('/api/twilio/sms', express.urlencoded({ extended: false }), async (req, res) => {
    const reply = parseTwilioSmsReply(req.body, {
        publicUrl: 'https://api.acme.com/api/twilio/sms',
        authToken: process.env.TWILIO_AUTH_TOKEN!,
        signature: req.headers['x-twilio-signature'] as string,
    });

    // reply: { approved: true, reference: 'deploy:123', from: '+15550001', messageId: 'SM...' }
    // Validate a persisted, unpredictable challenge and expected sender first.
    // Atomically consume the pending request and deduplicate MessageSid in your
    // application approval service. See the security migration guide.
    await approvalService.acceptVerifiedSmsReply(reply);

    res.type('text/xml').send('<Response></Response>');
});
```

---

## 9. Saga Compensation & Shared Revocations

When a downstream step fails or a workflow times out, Siglo triggers Named Saga Compensation (`cancelNotification`):

1. **Chat Channels (Slack)**: Calls `chat.update` to replace interactive buttons with an alert (e.g. `"Workflow Cancelled"`).
2. **Email & SMS**: Records the `correlationKey` into the revocation store so any future clicks on existing email links return `409 Conflict`.

### Configuring Shared PostgreSQL Revocation Store

```typescript
import { configureApprovalRevocationStore, PostgresApprovalRevocationStore } from '@siglo/notifications';

const revocationStore = new PostgresApprovalRevocationStore(pgPool);
await revocationStore.initialize();
configureApprovalRevocationStore(revocationStore);
```

---

## 10. Observability & PII Redaction

Standard recipient identifiers, credentials, and tokens are automatically redacted by Siglo core before telemetry dispatch. For fine-grained domain PII masking, attach a `NotificationMonitor`:

```typescript
import { NotificationMonitor } from '@siglo/notifications';

const monitor = new NotificationMonitor(['outputSummary.customers.*.contact', 'order.shippingAddress.phone']);

workflow.run(input, { monitor });
```

---

## 11. Testing & Verification

`@siglo/notifications` ships with a zero-network mock transport in `@siglo/notifications/testing`:

```typescript
import { MockNotificationTransport } from '@siglo/notifications/testing';
import { sendNotificationStep } from '@siglo/notifications';

const mock = new MockNotificationTransport();
const step = sendNotificationStep('notify', {
    channel: 'email',
    recipient: 'user@example.com',
    template: 'Hello world',
    transport: mock,
});

await step.execute({});
console.log(mock.messages.length); // 1
console.log(mock.messages[0].to); // 'user@example.com'
```

### Running Test Suites

```bash
# Run unit suite (zero network egress)
npm test --workspace=@siglo/notifications

# Run 100% coverage verification
npm run test:coverage --workspace=@siglo/notifications

# Run multi-worker PostgreSQL integration suite
SIGLO_TEST_POSTGRES_URL=postgres://siglo:siglo_test@localhost:5432/siglo_notifications_test \
npm run test:postgres --workspace=@siglo/notifications
```

---

## 12. License

MIT © [Jerico de Guzman](https://github.com/jsoftgem/siglo)
