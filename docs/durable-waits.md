# Durable Waits and External Events

Long-running workflows frequently need to pause execution for minutes, hours, or days awaiting an external event (such as human approval, webhook verification, or payment clearance) or a duration timer.

`Siglo` v1.0.0 supports durable suspension and resumption without keeping active event listeners or worker processes running in memory.

---

## 1. Durable Execution Mode (`durable: true`)

When a workflow runs with `{ durable: true }`, encounter of a wait node halts execution cleanly, creates a state checkpoint, records a waiting descriptor, and returns execution control:

```typescript
import { Step, flow, waitForEvent, wait } from '@siglo/core';

const userRegistrationFlow = flow(
  registerAccount,
  waitForEvent('email.verified', {
    correlationKey: (ctx) => `user:${ctx.userId}`,
    timeout: '48h'
  }),
  activateAccount
).version('1.0.0');

// Starts and runs until email.verified wait node
const suspension = await userRegistrationFlow.run(
  { userId: 'u_101', email: 'user@example.com' },
  { durable: true, pojo: true }
);

console.log(suspension.status);         // 'waiting'
console.log(suspension.correlationKey); // 'user:u_101'
console.log(suspension.stackId);        // Execution stack UUID
```

---

## 2. Wait Combinators

### `waitForEvent(eventName, options)`
Waits for an incoming event correlated by key:
- `correlationKey`: String or `(ctx) => string`.
- `timeout` / `timeoutMs`: Duration string (e.g. `'2h'`, `'30m'`, `'1d'`) or milliseconds.

### `wait(duration, options?)`
Durable sleep/timer:
- `duration`: Duration string or numeric milliseconds.

---

## 3. Resuming Workflows (`flow.resume` / `resumeWorkflow`)

When the external event occurs (e.g. from an HTTP webhook), resume the workflow by passing the correlation key or `stackId` and the external event payload:

```typescript
// Incoming webhook handler
app.post('/webhooks/email-verified', async (req, res) => {
  const { userId, verificationToken } = req.body;

  const result = await userRegistrationFlow.resume(
    `user:${userId}`,
    { verificationToken },
    { pojo: true }
  );

  res.json({ success: true, result });
});
```

The orchestrator:
1. Validates the wait record in `DurableManager`.
2. Restores the state snapshot from the storage checkpoint.
3. Merges the event payload into context.
4. Executes the remaining continuation steps to completion.

---

## 4. Event Safety Guarantees

- **Duplicate Events**: Attempting to resume a workflow that is not waiting or has already resumed throws `DuplicateEventException`.
- **Expired Waits**: If an event arrives after the declared `timeout` has elapsed, `ExpiredWaitException` is thrown.
- **Resource Efficiency**: In-memory timers and context bindings are released while waiting, permitting thousands of long-running workflows to pause concurrently.

---

## 5. Human-in-the-Loop Approvals

For production human intervention flows (interactive Slack Block Kit cards, responsive HTML emails, signed HMAC action URLs, two-way Twilio SMS, and web framework callback routers), use [`@siglo/notifications`](./adapters/notifications.md). It pairs `sendInteractiveApprovalStep` with `waitForEvent` and provides signed bearer tokens with application-provided authorization, distributed concurrency claims, and automated saga rollback.
