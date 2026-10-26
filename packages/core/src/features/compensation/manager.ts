import { Status } from '../../shared';
import { CompensationRecord, CompensationRunResult } from './types';
import { CompensationException } from '../executer/exceptions';

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
        _options?: any
    ): Promise<CompensationRunResult> {
        const records = this.getCompensations(stackId);
        const completed: string[] = [];
        const failed: Array<{ stepName: string; error: any }> = [];

        // Execute in reverse order (LIFO)
        const pending = [...records].reverse();

        for (const record of pending) {
            if (record.status === Status.COMPLETED) {
                completed.push(record.stepName);
                continue;
            }

            const maxRetries = record.options?.maxRetries ?? 0;
            const delayMs = record.options?.delay ?? 0;
            let success = false;
            let lastErr: any;

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    if (attempt > 0 && delayMs > 0) {
                        await new Promise(r => setTimeout(r, delayMs));
                    }
                    if (typeof record.handler === 'function') {
                        await record.handler(record.output, record.input);
                    } else if (record.handler && typeof (record.handler as any).execute === 'function') {
                        await (record.handler as any).execute({ output: record.output, input: record.input });
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
    }
}

export const defaultCompensationManager = new CompensationManager();
