---
title: 'Durable Waits and External Events'
description: 'Formal specification and operational contracts for durable suspension, correlation keys, event resumption, and checkpoint state restoration in Siglo.'
---

Long-running workflows frequently need to pause execution for minutes, hours, or days awaiting an external event (such as human approval, webhook verification, or payment clearance) or a duration timer.

`Siglo` supports durable suspension and resumption without keeping active event listeners or worker processes running in memory.

---

## 1. Durable Execution Mode (`durable: true`)

When a workflow runs with `{ durable: true }`, encounter of a wait node halts execution cleanly, creates a state checkpoint, records a waiting descriptor, and returns execution control with status `'waiting'`:

```typescript
import { Step, flow, waitForEvent, wait } from '@siglo/core';

const registerAccount = Step.create('registerAccount', async (ctx: { userId: string; email: string }) => {
    return { registeredAt: Date.now(), status: 'PENDING_VERIFICATION' };
});

const activateAccount = Step.create('activateAccount', async (ctx: { userId: string; verificationToken: string }) => {
    return { status: 'ACTIVE', activatedAt: Date.now() };
});

export const userRegistrationFlow = flow(
    registerAccount,
    waitForEvent('email.verified', {
        correlationKey: ctx => `user:${ctx.userId}`,
        timeout: '48h',
    }),
    activateAccount,
).version('1.0.0');

// Starts and runs until email.verified wait node
const suspension = await userRegistrationFlow.run(
    { userId: 'u_101', email: 'user@example.com' },
    { durable: true, pojo: true },
);

console.log(suspension.status); // 'waiting'
console.log(suspension.correlationKey); // 'user:u_101'
console.log(suspension.stackId); // Execution stack UUID
```

If a workflow executes without `{ durable: true }` and hits a wait node, Siglo throws a `WorkflowSuspendedException` containing the waiting descriptor.

---

## 2. Wait Combinators

### `waitForEvent(eventName, options)`

Waits for an incoming event correlated by key:

- `correlationKey`: String or dynamic context selector `(ctx) => string`.
- `timeout` / `timeoutMs`: Duration string (e.g. `'2h'`, `'30m'`, `'7d'`) or milliseconds.

```typescript
waitForEvent('managerApproval', {
    correlationKey: ctx => `expense:${ctx.expenseId}`,
    timeout: '7d',
});
```

### `wait(duration, options?)`

Durable sleep/timer that suspends workflow execution:

- `duration`: Duration string (e.g. `'24h'`, `'15m'`, `'60s'`) or numeric milliseconds.

```typescript
wait('24h');
```

---

## 3. Resuming Workflows (`flow.resume` / `resumeWorkflow`)

When the external event occurs (e.g. from an HTTP webhook), resume the workflow by passing the correlation key or `stackId` and the external event payload:

```typescript
import { resumeWorkflow } from '@siglo/core';
import { userRegistrationFlow } from './workflows';

// Incoming webhook handler
app.post('/webhooks/email-verified', async (req, res) => {
    const { userId, verificationToken } = req.body;

    const result = await userRegistrationFlow.resume(`user:${userId}`, { verificationToken }, { pojo: true });

    res.json({ success: true, result });
});
```

Alternatively, use the standalone `resumeWorkflow` utility:

```typescript
const result = await resumeWorkflow(
    userRegistrationFlow,
    `user:${userId}`,
    { verificationToken },
    {
        pojo: true,
        targetVersion: '1.0.0',
    },
);
```

### Resumption Lifecycle

1. **Wait Record Validation**: Resolves the wait record from `DurableManager` or storage adapter (`claimWaitRecord`).
2. **State Restoration**: Restores context and `$steps` history snapshots from the checkpoint.
3. **Event Payload Merge**: Merges incoming event payload into the execution context.
4. **Continuation Execution**: Evaluates remaining steps starting at `continuationStepIndex` without re-running completed steps.

---

## 4. Event Safety & Concurrency Guarantees

- **Duplicate Resumption Defense**:
    - In-memory runs: Resuming an already-resumed or non-waiting workflow throws `DuplicateEventException`.
    - Storage-backed runs: Concurrent claims on the same wait record throw `WorkflowAlreadyResumedException`.
- **Expired Wait Enforcement**: If an event arrives after the declared `timeout` has elapsed, `ExpiredWaitException` is thrown (unless explicitly overridden with `allowExpired: true`).
- **Resource Efficiency**: In-memory timers and context closures are freed while suspended, allowing thousands of workflows to pause concurrently in production without resource leaks.

---

## 5. Human-in-the-Loop Approvals

For production human intervention flows (interactive Slack Block Kit cards, responsive HTML emails, signed HMAC action URLs, two-way Twilio SMS, and web framework callback routers), use [`@siglo/notifications`](/adapters/notifications). It pairs `sendInteractiveApprovalStep` with `waitForEvent` and provides signed bearer tokens with application-provided authorization, distributed concurrency claims, and automated saga rollback.
