import { Status } from '../../shared';
import { IdempotencyStore, IdempotencyClaimStatus, IdempotencyRecord } from './types';

export class InMemoryIdempotencyStore implements IdempotencyStore {
    private records = new Map<string, IdempotencyRecord>();

    async claim(key: string, ttlMs?: number): Promise<IdempotencyClaimStatus> {
        const existing = this.records.get(key);
        const now = Date.now();

        if (existing) {
            if (existing.expiresAt !== undefined && now > existing.expiresAt) {
                this.records.delete(key);
            } else if (existing.status === Status.COMPLETED) {
                return Status.COMPLETED;
            } else if (existing.status === Status.IN_PROGRESS) {
                return Status.IN_PROGRESS;
            }
        }

        this.records.set(key, {
            status: Status.IN_PROGRESS,
            claimedAt: now,
            expiresAt: ttlMs !== undefined ? now + ttlMs : undefined
        });

        return Status.CLAIMED;
    }

    async complete(key: string, result: unknown): Promise<void> {
        const existing = this.records.get(key);
        if (existing) {
            existing.status = Status.COMPLETED;
            existing.result = result;
        } else {
            this.records.set(key, {
                status: Status.COMPLETED,
                result,
                claimedAt: Date.now()
            });
        }
    }

    async fail(key: string, _error: unknown): Promise<void> {
        this.records.delete(key);
    }

    async get(key: string): Promise<unknown> {
        const existing = this.records.get(key);
        if (existing) {
            if (existing.expiresAt !== undefined && Date.now() > existing.expiresAt) {
                this.records.delete(key);
                return undefined;
            }
            return existing.result;
        }
        return undefined;
    }

    clear(): void {
        this.records.clear();
    }

    get size(): number {
        return this.records.size;
    }
}

export const defaultIdempotencyStore = new InMemoryIdempotencyStore();
