# 06. Durable Workflows

Durable workflows allow executions to sleep, suspend, wait for external human approvals or webhooks, survive process restarts, and resume safely days or months later.

---

## 1. Waiting for External Events with `waitForEvent()`

Use `waitForEvent()` to halt workflow execution until an external signal or webhook is received:

```typescript
import { Step, flow, waitForEvent } from 'fluid-func';

export const expenseApprovalWorkflow = flow(
    Step.create('submitExpense', async (param: { amount: number }) => ({
        submittedAt: Date.now(),
        status: 'PENDING_APPROVAL'
    })).modern(),

    // Suspends until manager approval webhook arrives
    waitForEvent('managerApproval', {
        correlationKey: (param) => param.expenseId,
        timeout: '7d' // Auto-expire after 7 days
    }),

    Step.create('payout', async (param: { approved: boolean; approverId: string }) => {
        if (!param.approved) {
            return { payoutStatus: 'REJECTED' };
        }
        return { payoutStatus: 'PROCESSED', approvedBy: param.approverId };
    }).modern()
);
```

---

## 2. Sleeping with `wait()`

Pause workflow execution for a deterministic duration without blocking CPU threads:

```typescript
import { Step, flow, wait } from 'fluid-func';

export const delayedNotificationWorkflow = flow(
    Step.create('sendWelcome', () => ({ sent: true })),
    wait('24h'), // Sleeps for 24 hours
    Step.create('sendFollowUp', () => ({ followUpSent: true }))
);
```

---

## 3. Resuming Suspended Workflows

When an external event occurs (e.g., an incoming webhook), resume the workflow using `resumeWorkflow()` or `flow.resume()`:

```typescript
import { resumeWorkflow } from 'fluid-func';
import { expenseApprovalWorkflow } from './workflows';

// Webhook endpoint handler:
app.post('/api/webhooks/approval', async (req, res) => {
    const { expenseId, approved, approverId } = req.body;

    const finalResult = await resumeWorkflow(
        expenseApprovalWorkflow,
        expenseId, // correlationKey matching the wait node
        { approved, approverId } // Event payload merged into context
    );

    res.json({ success: true, finalResult });
});
```

---

## 4. Workflow Versioning and State Migrations

Long-running workflows that span days or weeks may have their code updated while executions are sleeping. `fluid-func` allows declarative state migrations:

```typescript
import { resumeWorkflow } from 'fluid-func';

const updatedWorkflow = flow(...newSteps).version('2.0.0');

await resumeWorkflow(updatedWorkflow, correlationKey, eventPayload, {
    targetVersion: '2.0.0',
    migrations: {
        '1.0.0': (oldState: any) => ({
            ...oldState,
            schemaVersion: 2,
            userEmail: oldState.email // Field rename migration
        })
    }
});
```

---

## Minimal Example

```typescript
import { Step, flow, waitForEvent, resumeWorkflow } from 'fluid-func';

const wf = flow(
    Step.create('step1', () => ({ orderId: 'ord_123' })).modern(),
    waitForEvent('paymentReceived', { correlationKey: (p) => p.orderId }),
    Step.create('step2', (p: any) => ({ completed: true, amount: p.amount })).modern()
);

// 1. Initial run suspends
const suspended = await wf.run({ orderId: 'ord_123' }, { durable: true });
console.log(suspended.status); // 'waiting'

// 2. Webhook arrives and resumes
const finalResult = await resumeWorkflow(wf, 'ord_123', { amount: 150 });
console.log(finalResult.completed); // true
console.log(finalResult.amount);    // 150
```

---

## Failure Example: Expired Waits and Duplicate Resumptions

```typescript
import { Step, flow, waitForEvent, resumeWorkflow, DuplicateEventException } from 'fluid-func';

const wf = flow(
    waitForEvent('approval', { correlationKey: 'app-99', timeout: '1h' })
);

await wf.run({}, { durable: true, stackId: 'stack-99' });

// First resume succeeds
await resumeWorkflow(wf, 'app-99', { approved: true });

try {
    // Second resume throws DuplicateEventException!
    await resumeWorkflow(wf, 'app-99', { approved: true });
} catch (err: any) {
    if (err instanceof DuplicateEventException) {
        console.error('Duplicate webhook rejected:', err.message);
    }
}
```

---

## Testing Example

```typescript
import { expect } from 'chai';
import { createWorkflowHarness } from '@fluid-func/testing';
import { Step, flow, waitForEvent } from 'fluid-func';

const durableWf = flow(
    Step.create('start', () => ({ ticketId: 't-1' })).modern(),
    waitForEvent('userReply', { correlationKey: (p) => p.ticketId }),
    Step.create('finish', (p: any) => ({ resolvedWith: p.message })).modern()
);

describe('Durable Workflows Suite', () => {
    it('suspends and resumes deterministically with injected events', async () => {
        const harness = createWorkflowHarness(durableWf);

        const initial = await harness.run({ ticketId: 't-1' }, { durable: true });
        expect(initial.status).to.equal('waiting');

        const finalResult = await harness.injectEvent('userReply', 't-1', {
            message: 'Problem solved'
        });

        expect(finalResult.resolvedWith).to.equal('Problem solved');
    });
});
```

---

## Operational Caveats

1. **Use Persistent Storage in Production**: In production, register `@fluid-func/postgres` or `@fluid-func/redis` via `useStorage()`. The in-memory default storage is strictly for testing.
2. **Correlation Key Uniqueness**: Correlation keys must be unique per waiting workflow instance. Using natural business identifiers (e.g. `orderId`, `ticketId`) avoids collision bugs.

---

## API Reference Links

- [Storage and Adapters](./07-storage-and-adapters.md)
- [Testing & Replay Reference](./09-testing-and-replay.md)
- [TypeScript API Reference](./10-typescript-reference.md)
