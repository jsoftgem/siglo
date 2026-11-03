import { withLocalWorkflowLock } from '../durable/lock';
import { defaultDurableManager } from '../durable/manager';
import { defaultStorageManager } from '../storage';
import { Status } from '../../shared';
import { CompensationRecord, CompensationRunOptions, CompensationRunResult } from './types';
import { CompensationException, UnresolvableCompensationException } from '../executer/exceptions';
import { getCompensationHandler } from './registry';

export class CompensationManager {
    private stackCompensations = new Map<string, CompensationRecord[]>();

    registerCompensation(stackId: string, record: CompensationRecord): void {
        const records = this.stackCompensations.get(stackId) || [];
        records.push(record);
        this.stackCompensations.set(stackId, records);
    }

    getCompensations(stackId: string): CompensationRecord[] {
        return this.stackCompensations.get(stackId) || [];
    }

    clearCompensations(stackId: string): void {
        this.stackCompensations.delete(stackId);
    }

    clear(): void {
        this.stackCompensations.clear();
    }

    async runCompensations(
        stackId: string,
        originalError?: any,
        options?: CompensationRunOptions
    ): Promise<CompensationRunResult> {
        const records = this.getCompensations(stackId);
        const adapter = defaultStorageManager.getAdapter();
        const execute = async () => {
            if (records.length) {
                await adapter?.cancelWorkflow?.(stackId);
                const waiting = defaultDurableManager.getWaitingByStack(stackId);
                if (waiting) waiting.status = 'failed';
            }
            const completed: string[] = [];
            const failed: Array<{ stepName: string; error: any }> = [];
            const mode = options?.mode ?? 'strict';

            // Execute in reverse order (LIFO)
            const pending = [...records].reverse();

            for (const record of pending) {
                if (record.status === Status.COMPLETED) {
                    completed.push(record.stepName);
                    continue;
                }

                // Resolve handler: direct function/step or named registry entry
                let handler = record.handler;
                if (!handler && record.handlerName) {
                    handler = getCompensationHandler(record.handlerName);
                }

                if (!handler) {
                    const missingErr = new UnresolvableCompensationException(
                        record.stepName,
                        record.handlerName,
                        { stackId }
                    );
                    record.status = Status.FAILED;
                    record.error = missingErr;
                    failed.push({ stepName: record.stepName, error: missingErr });

                    if (options?.onFailure) {
                        await options.onFailure({ stepName: record.stepName, error: missingErr, record }, missingErr);
                    }
                    if (options?.deadLetterQueue?.send) {
                        await options.deadLetterQueue.send({
                            stackId,
                            stepName: record.stepName,
                            handlerName: record.handlerName,
                            failedCompensation: { stepName: record.stepName, error: missingErr.message },
                            error: missingErr.message,
                            record,
                            timestamp: Date.now()
                        });
                    }

                    if (mode === 'strict') {
                        break;
                    } else {
                        continue;
                    }
                }

                const maxRetries = record.options?.maxRetries ?? options?.maxRetries ?? 0;
                const delayMs = record.options?.delay ?? options?.delay ?? 0;
                let success = false;
                let lastErr: any;

                for (let attempt = 0; attempt <= maxRetries; attempt++) {
                    try {
                        if (attempt > 0 && delayMs > 0) {
                            await new Promise(r => setTimeout(r, delayMs));
                        }
                        const payload = record.payload !== undefined ? record.payload : record.output;
                        if (typeof handler === 'function') {
                            await handler(payload, record.input);
                        } else if (handler && typeof (handler as any).execute === 'function') {
                            await (handler as any).execute({ output: payload, input: record.input });
                        }
                        success = true;
                        record.status = Status.COMPLETED;
                        record.completedAt = Date.now();
                        completed.push(record.stepName);
                        break;
                    } catch (err: any) {
                        lastErr = err;
                        if (record.options?.retryIf && !record.options.retryIf(err, attempt + 1)) {
                            break;
                        }
                    }
                }

                if (!success) {
                    record.status = Status.FAILED;
                    record.error = lastErr;
                    failed.push({ stepName: record.stepName, error: lastErr });

                    if (options?.onFailure) {
                        await options.onFailure({ stepName: record.stepName, error: lastErr, record }, lastErr);
                    }
                    if (options?.deadLetterQueue?.send) {
                        await options.deadLetterQueue.send({
                            stackId,
                            stepName: record.stepName,
                            handlerName: record.handlerName,
                            failedCompensation: { stepName: record.stepName, error: lastErr?.message || String(lastErr) },
                            error: lastErr?.message || String(lastErr),
                            record,
                            timestamp: Date.now()
                        });
                    }

                    if (mode === 'strict') {
                        break;
                    }
                }
            }

            if (failed.length > 0) {
                throw new CompensationException(
                    `One or more compensations failed (${failed.length}/${pending.length})`,
                    {
                        originalError: originalError || new Error('Workflow execution failed'),
                        compensationErrors: failed,
                        completedCompensations: completed
                    },
                    { stackId }
                );
            }

            return { completed, failed };
        };
        return adapter?.withWorkflowLock && records.length ? adapter.withWorkflowLock(stackId, execute) : withLocalWorkflowLock(stackId, execute);
    }
}

export const defaultCompensationManager = new CompensationManager();
