import { Status } from '../../shared';
import { WaitingWorkflowRecord } from './types';
import { DuplicateEventException, ExpiredWaitException } from '../executer/exceptions';

export interface DurableManagerOptions {
    maxSize?: number;
}

export class DurableManager {
    private waitingRecords = new Map<string, WaitingWorkflowRecord>();
    private stackIndex = new Map<string, string>();
    private maxSize: number;

    constructor(options?: DurableManagerOptions) {
        this.maxSize = options?.maxSize ?? 10000;
    }

    cleanExpired(): number {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, record] of this.waitingRecords.entries()) {
            if (record.expiresAt !== undefined && now > record.expiresAt) {
                this.stackIndex.delete(record.stackId);
                this.waitingRecords.delete(key);
                cleaned++;
            }
        }
        return cleaned;
    }

    registerWait(record: WaitingWorkflowRecord): void {
        if (this.waitingRecords.size >= this.maxSize) {
            this.cleanExpired();
            if (this.waitingRecords.size >= this.maxSize) {
                const oldestKey = this.waitingRecords.keys().next().value;
                if (oldestKey !== undefined) {
                    const oldRecord = this.waitingRecords.get(oldestKey);
                    if (oldRecord) {
                        this.stackIndex.delete(oldRecord.stackId);
                    }
                    this.waitingRecords.delete(oldestKey);
                }
            }
        }
        this.waitingRecords.set(record.correlationKey, record);
        this.stackIndex.set(record.stackId, record.correlationKey);
    }

    getWaiting(correlationKey: string): WaitingWorkflowRecord | undefined {
        return this.waitingRecords.get(correlationKey);
    }

    getWaitingByStack(stackId: string): WaitingWorkflowRecord | undefined {
        const key = this.stackIndex.get(stackId);
        return key ? this.waitingRecords.get(key) : undefined;
    }

    resumeWait(correlationKey: string): WaitingWorkflowRecord {
        const record = this.waitingRecords.get(correlationKey);
        if (!record || record.status !== Status.WAITING) {
            throw new DuplicateEventException(correlationKey, record?.eventName);
        }

        if (record.expiresAt !== undefined && Date.now() > record.expiresAt) {
            record.status = Status.EXPIRED;
            throw new ExpiredWaitException(correlationKey, record.expiresAt, record.eventName);
        }

        record.status = Status.RESUMED;
        record.resumedAt = Date.now();
        return record;
    }

    clear(): void {
        this.waitingRecords.clear();
        this.stackIndex.clear();
    }

    get size(): number {
        return this.waitingRecords.size;
    }
}

export const defaultDurableManager = new DurableManager();
