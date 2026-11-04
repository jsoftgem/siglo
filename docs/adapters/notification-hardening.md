# Notification approval security and recovery

This describes the implemented defenses following `../../grill/notification-grill.md`. It replaces the original assumptions about scanner detection, nonce tracking, leases and provider guarantees.

## Callback migration

GET and HEAD never accept decisions, regardless of `responseFormat`. GET renders a confirmation form; only POST accepts its body token. OPTIONS handles preflight, and other methods return 405. POST ignores query tokens. Register both GET and POST and install a URL-encoded body parser for the confirmation form. Hono also accepts JSON POST bodies; Fastify requires a form body parser such as `@fastify/formbody`.

Approval acceptance requires an `authorize(payload, request)` callback. Authenticate the request in application middleware, then look up the pending request by correlation key and compare the authenticated principal with its expected approver. Validate session CSRF protection there as well. The framework request (Hono context for Hono) is passed to this callback. Direct calls to `handleNotificationCallback` can use an authorization closure.

```typescript
app.use(express.urlencoded({ extended: false }));
app.all('/approval', createNotificationExpressMiddleware({
  workflow,
  signingSecret,
  responseFormat: 'html',
  allowedOrigins: ['https://orchestrator.example.com'],
  authorize: async (payload, req) => {
    const pending = await approvals.find(payload.correlationKey);
    return !!req.user && !!pending &&
      pending.stackId === payload.stackId &&
      pending.approverId === req.user.id &&
      await csrf.isValid(req);
  }
}));
```

The identity lookup and CSRF service above belong to the application. For low-risk link-possession authorization, explicitly set `allowBearerApproval: true`; anyone with that URL can act. Tokens are signed, readable bearer credentials. `toleranceSeconds` checks future issuance, not replay. Nonces are not separately consumed: durable request state prevents a completed request from being accepted again. Never consume an approval on preview, and never reuse a correlation key for a different request.

## Shared PostgreSQL setup

```typescript
const storage = new PostgresStorageAdapter({ client: pool });
await storage.ensureTables(); // Adds resume_payload to existing wait tables.
useStorage(storage);
const revocations = new PostgresApprovalRevocationStore(pool);
await revocations.initialize();
configureApprovalRevocationStore(revocations);
const dispatches = new PostgresNotificationDispatchStore(pool);
await dispatches.initialize();
configureNotificationDispatchStore(dispatches);
```

Configure these stores on every worker and scheduler against the same database. Defaults are process-local and unsuitable for distributed production. `dispatchStore` may also be passed per notification step. Use a PostgreSQL Pool with enough connections: each active callback holds an approval-lock connection and a workflow-lock connection, in addition to application queries. Session advisory locks require session affinity; transaction-pooling proxies are unsupported.

## Durable acceptance and cancellation

Approval callbacks and revocation share a per-correlation-key lock. Continuation execution and compensation share a per-stack lock. These are PostgreSQL session advisory locks, not time-based leases. Conflicting callers receive a conflict and must retry. Cancellation must be retried on conflict; it has not completed merely because an attempt was made. Already-started external actions cannot be retroactively prevented.

Claims atomically enforce durable wait expiry and persist the first accepted event in `resume_payload` while changing WAITING to RESUMING. Completion changes RESUMING to RESUMED only after continuation/checkpoint writes settle. A worker dying after acceptance leaves RESUMING with the original event intact. The scheduler selects these records even before the human approval deadline and replays that event after acquiring the stack lock. Only an expired, unaccepted WAITING record receives `timer:expired`. There is no unsafe SELECT/UPDATE fallback on a database error.

Compensation sets durable waits and the stack checkpoint to cancelled before running LIFO handlers. Cancelled waits cannot be resurrected by late wait-record writes. `cancelNotification` revokes before touching the external message. Retrying a cancelled stack is rejected even without a notification-token revocation row.

Recovery can re-execute continuation steps after a crash. Make external effects idempotent; a database session lock does not make an external service transaction atomic. Connection loss can leave an external request in flight. The implementation does not promise exactly-once external side effects or provider-independent delivery.

## Dispatch retries

Dispatch intents persist the exact rendered input, approval URLs and deterministic provider key before sending. Retries reuse them. A shared `PostgresNotificationDispatchStore` preserves this across restarts and workers. Retain intents through the entire retry/reconciliation window; they contain approval URLs and recipient data and need restricted database access and an application retention policy.

Resend receives `Idempotency-Key`. Its provider deduplication window is 24 hours, so do not blindly retry ambiguous sends after that window. Push webhooks receive the same header but must implement deduplication themselves. Other transports retain at-least-once dispatch semantics on ambiguous failures; SendGrid batch IDs and Twilio friendly names are not generic deduplication mechanisms. A durable intent alone does not close the provider acceptance/acknowledgement gap.

## Egress

Built-in HTTP transports use native HTTPS. The socket's DNS lookup validates every returned address and passes only those validated addresses to the connection, preserving hostname certificate verification and SNI. Private, loopback, metadata, mapped, multicast and selected reserved/transition address ranges are rejected; redirects are rejected. Responses are bounded to 1 MiB, requests have an inactivity timeout, and workflow abort signals are forwarded.

Injected `fetch`, SMTP clients and custom transports are trusted escape hatches and must provide equivalent network controls. Tests inject these explicitly; replacing global `fetch` no longer intercepts the native default transport. These Node transports require Node even when using the Hono routing adapter.

## SMS

`parseTwilioSmsReply` authenticates Twilio's webhook, not the human sender. Generate a challenge once with `createSmsApprovalReference('deploy:101')` (128 random bits) and persist it with the expected sender, receiving number, pending request and expiry. `validateSmsApprovalReply(reply, pending)` checks those bindings and expiry; it does not consume the request.

The application must atomically accept the decision, deduplicate MessageSid and resume through its durable request protocol. Require an authenticated second factor for sensitive approvals. Sender matching and random challenges cannot protect a challenge intercepted through the SMS channel itself. Do not call `resumeWorkflow` directly from parsed sender/reference fields.
