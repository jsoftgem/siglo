---
title: 'Workflow Versioning and State Migrations'
description: 'Semantic version tagging on flows, compatibility validation during resumption, state migration functions, and deployment best practices in Siglo.'
---

# Workflow Versioning and State Migrations

Long-running workflows that pause for days or weeks often outlive the software release that initiated them. If workflow code changes while executions are suspended, resuming workflows must be done deterministically and safely.

`Siglo` provides native workflow version tagging, compatibility enforcement, and state migration functions.

---

## 1. Declaring Workflow Versions

Assign semantic version identifiers to flows using `.version()` or execution options:

```typescript
import { flow, Step, waitForEvent } from '@siglo/core';

const invoiceWorkflow = flow(
    generateInvoice,
    waitForEvent('invoice.paid', { correlationKey: ctx => ctx.invoiceId }),
    sendReceipt,
).version('2.1.0');
```

When suspended, the declared version (`'2.1.0'`) is recorded in the wait record and storage checkpoint metadata.

---

## 2. Version Verification on Resumption

When resuming a workflow, `resumeWorkflow` compares the target workflow version with the recorded checkpoint version:

- **Matching Versions**: If versions match (e.g. `'2.1.0' === '2.1.0'`), execution resumes immediately.
- **Mismatched Versions**: If versions differ and no migration is declared, resumption fails safely with `WorkflowVersionMismatchException`.

```typescript
import { WorkflowVersionMismatchException } from '@siglo/core';

try {
    await v2Workflow.resume('invoice:inv-123', eventData);
} catch (err) {
    if (err instanceof WorkflowVersionMismatchException) {
        console.error(`Expected version ${err.expectedVersion}, but found checkpoint version ${err.actualVersion}`);
    }
}
```

---

## 3. State Migration Functions

To upgrade suspended workflows across code versions, supply migration mappings to `flow.resume()` or `resumeWorkflow()`:

### A. Version Transition Map (`migrations: Record<string, MigrationFn>`)

Target specific version jumps using the `'<actualVersion>-><expectedVersion>'` key syntax:

```typescript
const result = await v2Workflow.resume('invoice:inv-123', eventData, {
    targetVersion: '2.0.0',
    migrations: {
        // Migration function signature: (actualVersion, expectedVersion, oldState)
        '1.0.0->2.0.0': (actualVersion, expectedVersion, oldState) => {
            return {
                ...oldState,
                customer: {
                    id: oldState.customerId,
                    name: oldState.customerName,
                },
            };
        },
    },
});
```

### B. Unified Migration Function

Alternatively, provide a single function that handles multiple version transitions programmatically:

```typescript
const result = await v2Workflow.resume('invoice:inv-123', eventData, {
    targetVersion: '2.0.0',
    migrations: (actualVersion, expectedVersion, state) => {
        if (actualVersion === '1.0.0' && expectedVersion === '2.0.0') {
            return { ...state, schemaVersion: 2, email: state.userEmail };
        }
        return state;
    },
});
```

### Checkpoint Storage Effect

When a migration function successfully transforms state during resumption:

1. The transformed context replaces the legacy snapshot.
2. The storage checkpoint `revision` counter is monotonically incremented.
3. The checkpoint's recorded `version` is updated to the `targetVersion`.

---

## 4. Deployment Best Practices

1. **Explicit Versioning**: Always tag long-running workflows with `.version('X.Y.Z')`.
2. **Backward-Compatible Step Names**: Keep step identifiers consistent between releases so `$steps` references remain unbroken.
3. **Automated Migration Testing**: Write unit tests using `@siglo/testing` to verify that state migration functions transform legacy fixtures into the exact shape expected by downstream steps in the new version before rolling code to production:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('migrates v1.0.0 state to v2.0.0 customer profile', () => {
    const v1State = { customerId: 'c_1', customerName: 'Alice' };
    const v2State = migrations['1.0.0->2.0.0']('1.0.0', '2.0.0', v1State);

    assert.deepEqual(v2State.customer, { id: 'c_1', name: 'Alice' });
});
```
