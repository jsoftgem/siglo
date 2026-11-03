import { WorkflowEventEmitter, WorkflowExecutionEvent, redactEvent } from 'siglo';
import { transformFields } from '@siglo/crypto';

/** A workflow monitor that masks configured event paths before any listener sees them.
 * Patterns use event-relative paths, e.g. outputSummary.customers.*.contact.
 */
export class NotificationMonitor extends WorkflowEventEmitter {
  constructor(private readonly paths: string[] = []) { super(); }
  override emit(event: WorkflowExecutionEvent): void {
    super.emit(redactEvent(transformFields(event, this.paths, () => '[REDACTED]')));
  }
}
