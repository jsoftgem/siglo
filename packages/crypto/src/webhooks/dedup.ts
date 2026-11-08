import crypto from 'node:crypto';
import { WebhookDedupStore } from '../types';

/**
 * Computes a deterministic SHA-256 deduplication key for a webhook delivery attempt.
 */
export function createDedupKey(provider: string, signature: string, timestamp?: number): string {
    return crypto
        .createHash('sha256')
        .update(`${provider}:${timestamp ?? ''}:${signature}`)
        .digest('hex');
}

interface Bucket {
    expiresAt: number;
    keys: Set<string>;
}

/**
 * High-performance in-memory bucketed ring buffer for intra-window webhook deduplication.
 * Eliminates per-key eviction sweeps by grouping keys into sliding time buckets with O(1) pruning.
 */
export class InMemoryNonceStore implements WebhookDedupStore {
    private buckets: Bucket[] = [];
    private allKeys: Set<string> = new Set();
    private bucketDurationMs: number;

    constructor(bucketDurationSeconds: number = 60) {
        this.bucketDurationMs = bucketDurationSeconds * 1000;
    }

    private pruneExpired(now: number): void {
        while (this.buckets.length > 0 && this.buckets[0].expiresAt <= now) {
            const expired = this.buckets.shift()!;
            for (const k of expired.keys) {
                this.allKeys.delete(k);
            }
        }
    }

    /**
     * Atomically checks and records a nonce/signature key.
     * Returns true if successfully claimed (first time seen), or false if already seen within TTL.
     */
    claim(key: string, ttlSeconds: number): boolean {
        const now = Date.now();
        this.pruneExpired(now);

        if (this.allKeys.has(key)) {
            return false; // Duplicate / replay within TTL
        }

        const expiresAt = now + ttlSeconds * 1000;
        this.allKeys.add(key);

        // Find bucket within duration window or insert a new one
        let bucket = this.buckets.find(b => Math.abs(b.expiresAt - expiresAt) < this.bucketDurationMs);
        if (!bucket) {
            bucket = { expiresAt, keys: new Set() };
            this.buckets.push(bucket);
            this.buckets.sort((a, b) => a.expiresAt - b.expiresAt);
        }
        bucket.keys.add(key);

        return true;
    }

    clear(): void {
        this.buckets = [];
        this.allKeys.clear();
    }

    get size(): number {
        this.pruneExpired(Date.now());
        return this.allKeys.size;
    }
}
