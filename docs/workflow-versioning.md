# Workflow Versioning and State Migrations

Long-running workflows that pause for days or weeks often outlive the software release that initiated them. If the workflow code changes while executions are suspended, resuming workflows must be done deterministically and safely.

`fluid-func` v2.0.0 provides native workflow version tagging, compatibility enforcement, and state migration functions.

---

## 1. Declaring Workflow Versions

Assign semantic version identifiers to flows using `.version()` or execution options:

```typescript
import { flow, Step, waitForEvent } from 'fluid-func';

const invoiceWorkflow = flow(
  generateInvoice,
  waitForEvent('invoice.paid', { correlationKey: (ctx) => ctx.invoiceId }),
  sendReceipt
).version('2.1.0');
```

When suspended, the declared version (`'2.1.0'`) is recorded in the wait record and storage checkpoint.

---

## 2. Version Verification on Resumption

When resuming a workflow, `resumeWorkflow` compares the target workflow version with the recorded checkpoint version:

- **Matching Versions**: If versions match (e.g. `'2.1.0' === '2.1.0'`), execution resumes immediately.
- **Mismatched Versions**: If versions differ and no migration is declared, resumption fails safely with `WorkflowVersionMismatchException`.

```typescript
import { WorkflowVersionMismatchException } from 'fluid-func';

try {
  await v2Workflow.resume('invoice:inv-123', eventData);
} catch (err) {
  if (err instanceof WorkflowVersionMismatchException) {
    console.error(`Expected version ${err.expectedVersion}, but found ${err.actualVersion}`);
  }
}
```

---

## 3. State Migration Functions

To upgrade suspended workflows across code versions, supply migration mappings:

```typescript
const result = await v2Workflow.resume('invoice:inv-123', eventData, {
  targetVersion: '2.0.0',
  migrations: {
    // Migrate v1.0.0 state to v2.0.0 shape
    '1.0.0->2.0.0': (fromVersion, toVersion, oldState) => {
      return {
        ...oldState,
        customer: {
          id: oldState.customerId,
          name: oldState.customerName
        }
      };
    }
  }
});
```

Migrations can also be declared as a single unified transformation function:

```typescript
const result = await v2Workflow.resume('invoice:inv-123', eventData, {
  migrations: (actualVersion, expectedVersion, state) => {
    // Transform state
    return state;
  }
});
```

---

## 4. Deployment Best Practices

1. **Explicit Versioning**: Always tag long-running workflows with `.version('X.Y.Z')`.
2. **Backward-Compatible Step Names**: Keep step identifiers consistent between releases for seamless continuation.
3. **Migration Verification**: Write unit tests verifying that state migration functions produce the exact shape expected by downstream steps in the new version.
