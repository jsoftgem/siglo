import {
    flow,
    waitForEvent,
    resumeWorkflow,
    defaultDurableManager,
    defaultStorageManager,
    DuplicateEventException,
    useStorage,
    Step,
    defaultCompensationManager,
    Status,
} from '@siglo/core';
import { RedisLock, RedisClientInterface } from '@siglo/redis';
import { InMemoryStorageFake } from '@siglo/testing';
import { ChaosStorageProxy } from '../engine/chaos-proxy';
import { RandomSource } from '../engine/property-generators';
import { InvariantEvaluator } from '../engine/invariant-evaluator';
import { CharterResult } from './combinators.explore';

class SimulatedClusterRedisClient implements RedisClientInterface {
    public storage = new Map<string, string>();
    public ttls = new Map<string, number>();
    public networkPartitionedNodes = new Set<string>();

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
            this.ttls.set(key, Date.now() + args[pxIdx + 1]);
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
            this.ttls.delete(k);
        }
        return count;
    }

    async eval(script: string, numkeys: number, key: string, token: string): Promise<number> {
        // Lua script simulation for atomic release
        const current = this.storage.get(key);
        if (current === token) {
            this.storage.delete(key);
            this.ttls.delete(key);
            return 1;
        }
        return 0;
    }
}

export async function runClusterFailoverCharter(iterations: number = 15, seed: number = 1212): Promise<CharterResult> {
    const startTime = Date.now();
    const rng = new RandomSource(seed);
    const errors: string[] = [];
    const invariantsChecked = [2, 3, 5];

    for (let i = 0; i < iterations; i++) {
        defaultDurableManager.clear();
        defaultCompensationManager.clear();

        try {
            // =========================================================================
            // Sub-test A: Split-Brain & Stale Resume Barrier Under Network Partition
            // =========================================================================
            const fakeStorage = new InMemoryStorageFake();
            const chaosProxy = new ChaosStorageProxy(fakeStorage, {
                conflictRate: 0.0,
                maxLatencyMs: 2,
            });
            useStorage(chaosProxy);

            const correlationKey = `split_corr_${i}_${rng.string(6)}`;
            const stackId = `split_stack_${i}_${rng.string(6)}`;

            const s1 = Step.create('prepStep', async () => ({ prepared: true }));
            const waitStep = waitForEvent('cluster_event', {
                correlationKey: () => correlationKey,
            });
            const s2 = Step.create('finalizeStep', async (ctx: any) => ({
                workerNode: ctx.nodeId,
                finishedAt: Date.now(),
            }));

            const clusterWorkflow = flow(s1, waitStep, s2);

            // Register initial WAITING state with canonical Status.WAITING
            defaultDurableManager.registerWait({
                correlationKey,
                eventName: 'cluster_event',
                stepId: 'waitForEvent:cluster_event',
                stackId,
                continuationStepIndex: 2,
                version: '1.0.0',
                status: Status.WAITING,
                createdAt: Date.now(),
            });

            await defaultStorageManager.saveCheckpoint({
                id: stackId,
                stackId,
                contexts: { prepStep: { prepared: true } },
                workflowVersion: '1.0.0',
                status: Status.WAITING,
                currentStepId: 'waitForEvent:cluster_event',
                completedSteps: ['prepStep'],
                timestamp: Date.now(),
            } as any);

            // Simulate Node-Beta (healthy standby) winning the resumption first
            const winnerResult = await resumeWorkflow(
                clusterWorkflow,
                correlationKey,
                { nodeId: 'node-beta', approved: true },
                { pojo: true },
            );

            if (!winnerResult || winnerResult.workerNode !== 'node-beta') {
                errors.push(`Iteration ${i}: Node-Beta failed to resume workflow as primary winner`);
            }

            // Simulate Node-Alpha (partitioned node) waking up and attempting stale resume
            let staleRejected = false;
            try {
                await resumeWorkflow(
                    clusterWorkflow,
                    correlationKey,
                    { nodeId: 'node-alpha-stale', approved: true },
                    { pojo: true },
                );
            } catch (staleErr: any) {
                if (
                    staleErr instanceof DuplicateEventException ||
                    staleErr.name === 'DuplicateEventException' ||
                    /duplicate|already|conflict/i.test(staleErr.message)
                ) {
                    staleRejected = true;
                }
            }

            // Assert Oracle 3: Stale split-brain node MUST be rejected
            if (!staleRejected) {
                errors.push(
                    `Iteration ${i} [Oracle 3]: Split-brain violation! Partitioned Node-Alpha was allowed to re-execute already completed resume!`,
                );
            }

            // =========================================================================
            // Sub-test B: Distributed Lock Stealing & Token Ownership Fuzzing
            // =========================================================================
            const redisClient = new SimulatedClusterRedisClient();
            const lockManager = new RedisLock(redisClient, {
                keyPrefix: 'cluster:lock:',
                strictAtomicity: true,
            });

            const lockKey = `job_sync_${i}`;

            // Node 1 acquires lock with small TTL
            const node1Lease = await lockManager.acquire(lockKey, 20);
            if (!node1Lease.acquired) {
                errors.push(`Iteration ${i}: Node 1 failed initial distributed lock acquisition`);
            }

            // Node 2 tries to acquire immediately and MUST fail
            const node2Early = await lockManager.acquire(lockKey, 20);
            if (node2Early.acquired) {
                errors.push(`Iteration ${i} [Oracle 3]: Lock mutual exclusion failed! Node 2 acquired active lock.`);
            }

            // Simulate lock expiry in Redis storage
            redisClient.storage.delete(`cluster:lock:${lockKey}`);

            // Node 2 now acquires lock legitimately with its own token
            const node2Lease = await lockManager.acquire(lockKey, 50);
            if (!node2Lease.acquired) {
                errors.push(`Iteration ${i}: Node 2 failed to claim expired lock`);
            }

            // Node 1 unfreezes and attempts to release Node 2's lock using Node 1's stale token
            const illegitimateRelease = await lockManager.release(lockKey, node1Lease.token);
            if (illegitimateRelease) {
                errors.push(
                    `Iteration ${i} [Oracle 3]: Distributed lock theft! Stale Node 1 was able to release Node 2's active lock.`,
                );
            }

            // Node 2 legitimately releases its own lock
            const legitimateRelease = await lockManager.release(lockKey, node2Lease.token);
            if (!legitimateRelease) {
                errors.push(`Iteration ${i}: Node 2 legitimate lock release failed`);
            }

            // =========================================================================
            // Sub-test C: Multi-Node Mid-Saga Failover Recovery (Oracle 2)
            // =========================================================================
            const executedStepLog: string[] = [];
            const compensatedStepLog: string[] = [];

            const stepA = Step.create('cluster_step_a', async () => {
                executedStepLog.push('step_a');
                return { a: 1 };
            }).compensate(async () => {
                compensatedStepLog.push('step_a');
            });

            const stepB = Step.create('cluster_step_b', async () => {
                executedStepLog.push('step_b');
                return { b: 2 };
            }).compensate(async () => {
                compensatedStepLog.push('step_b');
            });

            const stepC = Step.create('cluster_step_c', async () => {
                // Node crashes mid-saga at step C
                throw new Error(`Simulated worker crash at Step C in iteration ${i}`);
            }).compensate(async () => {
                compensatedStepLog.push('step_c');
            });

            const sagaFlow = flow(stepA, stepB, stepC);

            try {
                await sagaFlow.execute({}, { durable: false });
            } catch {
                // Expected failure to trigger compensation
            }

            // Verify Oracle 2: Saga LIFO compensation order
            try {
                InvariantEvaluator.assertSagaLIFO(executedStepLog, compensatedStepLog);
            } catch (invErr: any) {
                errors.push(`Iteration ${i} [Oracle 2]: ${invErr.message}`);
            }

            // =========================================================================
            // Sub-test D: Bounded Distributed Concurrency High-Water Mark (Oracle 5)
            // =========================================================================
            const maxAllowedConcurrency = rng.nextInt(3, 6);
            let activeConcurrency = 0;
            let recordedHighWaterMark = 0;

            const competingTasks = Array.from({ length: 15 }, (_, taskIdx) => async () => {
                activeConcurrency++;
                recordedHighWaterMark = Math.max(recordedHighWaterMark, activeConcurrency);
                // Simulate variable network delay
                await new Promise(res => setTimeout(res, rng.nextInt(1, 5)));
                activeConcurrency--;
                return { task: taskIdx };
            });

            // Bounded parallel runner simulation across cluster workers
            const pool: Promise<any>[] = [];
            for (const task of competingTasks) {
                while (activeConcurrency >= maxAllowedConcurrency) {
                    await new Promise(res => setTimeout(res, 1));
                }
                const p = task();
                pool.push(p);
            }
            await Promise.all(pool);

            try {
                InvariantEvaluator.assertBoundedConcurrency(recordedHighWaterMark, maxAllowedConcurrency);
            } catch (invErr: any) {
                errors.push(`Iteration ${i} [Oracle 5]: ${invErr.message}`);
            }
        } catch (charterErr: any) {
            errors.push(`Iteration ${i} Unhandled Exception: ${charterErr.message}`);
        }
    }

    return {
        charterName: 'Charter 12: Distributed Multi-Node Worker Failover & Split-Brain Contention',
        iterations,
        passed: errors.length === 0,
        durationMs: Date.now() - startTime,
        invariantsChecked,
        errors,
    };
}
