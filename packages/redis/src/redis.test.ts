import { expect } from 'chai';
import {
    RedisStorageAdapter,
    RedisIdempotencyStore,
    RedisLock,
    RedisClientInterface
} from './index';

class MockRedisClient implements RedisClientInterface {
    public storage = new Map<string, string>();
    public hashes = new Map<string, Map<string, string>>();
    public ttls = new Map<string, number>();

    async get(key: string): Promise<string | null> {
        return this.storage.has(key) ? this.storage.get(key)! : null;
    }

    async set(key: string, value: string, ...args: any[]): Promise<'OK' | string | null> {
        const isNx = args.includes('NX');
        const pxIdx = args.indexOf('PX');
        if (isNx && this.storage.has(key)) {
            return null;
        }
        if (pxIdx !== -1 && typeof args[pxIdx + 1] === 'number') {
            this.ttls.set(key, args[pxIdx + 1]);
        }
        this.storage.set(key, value);
        return 'OK';
    }

    async del(key: string | string[]): Promise<number> {
        const keys = Array.isArray(key) ? key : [key];
        let count = 0;
        for (const k of keys) {
            if (this.storage.delete(k)) {
                count++;
            }
            this.hashes.delete(k);
            this.ttls.delete(k);
        }
        return count;
    }

    async hset(key: string, field: string | Record<string, string>, value?: string): Promise<number> {
        if (!this.hashes.has(key)) {
            this.hashes.set(key, new Map());
        }
        const hash = this.hashes.get(key)!;
        if (typeof field === 'string') {
            hash.set(field, value || '');
            return 1;
        }
        for (const [k, v] of Object.entries(field)) {
            hash.set(k, v);
        }
        return Object.keys(field).length;
    }

    async hgetall(key: string): Promise<Record<string, string>> {
        const hash = this.hashes.get(key);
        if (!hash) {
            return {};
        }
        return Object.fromEntries(hash.entries());
    }

    async pexpire(key: string, milliseconds: number): Promise<number> {
        this.ttls.set(key, milliseconds);
        return 1;
    }
}

describe('@fluid-func/redis Storage & Idempotency Adapter Suite', () => {
    let mockClient: MockRedisClient;

    beforeEach(() => {
        mockClient = new MockRedisClient();
    });

    describe('RedisStorageAdapter', () => {
        it('throws if initialized without client', () => {
            expect(() => new RedisStorageAdapter(undefined as any)).to.throw();
        });

        it('saves and retrieves serialized checkpoints', async () => {
            const adapter = new RedisStorageAdapter({ client: mockClient });
            const checkpoint = {
                stackId: 'stack-101',
                contexts: { step1: { amount: 100 } },
                history: [{ chain: 'step1', status: 'completed' }],
            };

            await adapter.saveCheckpoint(checkpoint as any);
            const retrieved = await adapter.getCheckpoint('stack-101');

            expect(retrieved).to.deep.equal(checkpoint);
        });

        it('returns undefined when checkpoint does not exist', async () => {
            const adapter = new RedisStorageAdapter({ client: mockClient });
            const result = await adapter.getCheckpoint('non-existent');
            expect(result).to.be.undefined;
        });

        it('stores and retrieves cached step responses', async () => {
            const adapter = new RedisStorageAdapter({ client: mockClient });
            const stepResult = { exchangeRate: 1.08, currency: 'EUR' };

            await adapter.setCachedStep('eur-usd-rate', stepResult, 60000);
            const cached = await adapter.getCachedStep('eur-usd-rate');

            expect(cached).to.deep.equal(stepResult);
        });

        it('streams context changes to Redis hashes', async () => {
            const adapter = new RedisStorageAdapter({ client: mockClient });
            await adapter.onContextChange({
                stackId: 'stack-202',
                stepId: 'processPayment',
                field: 'transactionId',
                value: 'txn_999',
                timestamp: Date.now(),
            });

            const hash = await mockClient.hgetall('fluid:context:stack-202:processPayment');
            expect(hash.transactionId).to.equal('txn_999');
        });
    });

    describe('RedisIdempotencyStore', () => {
        it('throws if initialized without client', () => {
            expect(() => new RedisIdempotencyStore(undefined as any)).to.throw();
        });

        it('successfully claims a new idempotency key', async () => {
            const store = new RedisIdempotencyStore({ client: mockClient });
            const status = await store.claim('order:1001', 30000);
            expect(status).to.equal('claimed');
        });

        it('returns in-progress on duplicate concurrent claim', async () => {
            const store = new RedisIdempotencyStore({ client: mockClient });
            await store.claim('order:1002', 30000);

            const duplicateStatus = await store.claim('order:1002', 30000);
            expect(duplicateStatus).to.equal('in-progress');
        });

        it('marks claim as completed and stores execution result', async () => {
            const store = new RedisIdempotencyStore({ client: mockClient });
            await store.claim('order:1003', 30000);

            await store.complete('order:1003', { settled: true, amount: 250 });

            const subsequentClaim = await store.claim('order:1003', 30000);
            expect(subsequentClaim).to.equal('completed');

            const result = await store.getResult('order:1003');
            expect(result).to.deep.equal({ settled: true, amount: 250 });
        });

        it('clears in-progress claim on failure to allow retry', async () => {
            const store = new RedisIdempotencyStore({ client: mockClient });
            await store.claim('order:1004', 30000);

            // Failure cleans up in-progress claim
            await store.fail('order:1004', new Error('Gateway timeout'));

            const retriedClaim = await store.claim('order:1004', 30000);
            expect(retriedClaim).to.equal('claimed');
        });
    });

    describe('RedisLock', () => {
        it('throws if initialized without client', () => {
            expect(() => new RedisLock(undefined as any)).to.throw();
        });

        it('acquires and releases distributed lock with token verification', async () => {
            const lock = new RedisLock(mockClient);
            const { acquired, token } = await lock.acquire('job:sync-orders', 5000);
            expect(acquired).to.be.true;
            expect(token).to.be.a('string');

            // Concurrent acquire fails
            const secondAttempt = await lock.acquire('job:sync-orders', 5000);
            expect(secondAttempt.acquired).to.be.false;

            // Release with mismatched token fails
            const invalidRelease = await lock.release('job:sync-orders', 'wrong-token');
            expect(invalidRelease).to.be.false;

            // Release with correct token succeeds
            const validRelease = await lock.release('job:sync-orders', token);
            expect(validRelease).to.be.true;

            // Now acquire succeeds again
            const thirdAttempt = await lock.acquire('job:sync-orders', 5000);
            expect(thirdAttempt.acquired).to.be.true;
        });

        it('executes function wrapped in withLock', async () => {
            const lock = new RedisLock(mockClient);
            let executed = false;

            const result = await lock.withLock('task:calculate-totals', async () => {
                executed = true;
                return 42;
            });

            expect(executed).to.be.true;
            expect(result).to.equal(42);

            // Lock was released after withLock
            const reacquire = await lock.acquire('task:calculate-totals', 5000);
            expect(reacquire.acquired).to.be.true;
        });

        it('supports client.eval if provided', async () => {
            (mockClient as any).eval = async (_lua: string, _keysCount: number, key: string, token: string) => {
                if (mockClient.storage.get(key) === token) {
                    mockClient.storage.delete(key);
                    return 1;
                }
                return 0;
            };

            const lock = new RedisLock(mockClient);
            const { token } = await lock.acquire('eval:lock', 5000);
            const released = await lock.release('eval:lock', token);
            expect(released).to.be.true;
        });

        it('throws when withLock fails to acquire lock', async () => {
            const lock = new RedisLock(mockClient);
            await lock.acquire('contested:job', 10000);

            try {
                await lock.withLock('contested:job', async () => 'never');
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.message).to.include('Failed to acquire lock');
            }
        });
    });
});
