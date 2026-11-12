import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { useStorage, getStorageAdapter, defaultDurableManager, resumeWorkflow } from '@siglo/core';
import { PostgresStorageAdapter } from '@siglo/postgres';
import { RedisLock } from '@siglo/redis';
import { PostgresWaitPoller } from '@siglo/scheduler';
import { signActionToken, handleNotificationCallback } from '@siglo/notifications';
import { exploreCases } from '../engine/charter';
import { createRecoveryWorkflow } from '../engine/recovery-workflow';

export async function runPersistentRecoveryCharter(iterations = 3, seed = 1515) {
    if (!process.env.SIGLO_TEST_POSTGRES_URL || !process.env.SIGLO_TEST_REDIS_URL)
        throw new Error('Integration mode requires SIGLO_TEST_POSTGRES_URL and SIGLO_TEST_REDIS_URL');
    const prefix = `explore_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const tables = {
        checkpointsTable: `${prefix}_cp`,
        eventsTable: `${prefix}_events`,
        waitRecordsTable: `${prefix}_waits`,
    };
    const effects = `${prefix}_effects`;
    const pool = new Pool({ connectionString: process.env.SIGLO_TEST_POSTGRES_URL, connectionTimeoutMillis: 5000 });
    const redis = new Redis(process.env.SIGLO_TEST_REDIS_URL, {
        lazyConnect: true,
        connectTimeout: 5000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
    });
    const previous = getStorageAdapter();
    try {
        await redis.connect();
        await redis.ping();
        const adapter = new PostgresStorageAdapter({ client: pool, ...tables, recordContextChanges: false });
        await adapter.ensureTables();
        await pool.query(`CREATE TABLE ${effects} (request_id TEXT PRIMARY KEY, approved BOOLEAN)`);
        useStorage(adapter);
        return await exploreCases(
            'Charter 15: Persistent worker and scheduler recovery',
            iterations,
            seed,
            [3],
            async (rng, i, record) => {
                const key = `${prefix}_${i}_${rng.string(6)}`;
                record({ key, fault: 'SIGKILL after external effect before checkpoint', tables });
                const workflow = createRecoveryWorkflow(pool, effects, key);
                const waiting: any = await workflow.run({}, { durable: true, pojo: true });
                assert.equal(waiting.status, 'waiting');
                defaultDurableManager.clear();
                const child = fork(resolve('test/exploratory/engine/recovery-worker.ts'), [], {
                    execArgv: ['--import', 'tsx'],
                    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
                    env: { ...process.env, SIGLO_RECOVERY_CASE: JSON.stringify({ tables, effects, key }) },
                });
                const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
                try {
                    await new Promise<void>((resolveReady, reject) => {
                        const timeout = setTimeout(
                            () => reject(new Error('Recovery worker did not reach crash barrier')),
                            10000,
                        );
                        child.once('message', message => {
                            clearTimeout(timeout);
                            (message as any).type === 'effect'
                                ? resolveReady()
                                : reject(new Error('Recovery worker failed'));
                        });
                        child.once('error', error => {
                            clearTimeout(timeout);
                            reject(error);
                        });
                        child.once('exit', () => {
                            clearTimeout(timeout);
                            reject(new Error('Worker exited before crash barrier'));
                        });
                    });
                } finally {
                    child.kill('SIGKILL');
                    await exited;
                }
                const accepted = await adapter.getWaitRecord(key);
                assert.equal(accepted.status, 'RESUMING');
                assert.equal(accepted.resumePayload.approved, true);
                const pollerOptions = {
                    client: pool,
                    waitRecordsTable: tables.waitRecordsTable,
                    flowLookup: () => workflow,
                };
                const reports = await Promise.all([
                    new PostgresWaitPoller(pollerOptions).pollOnce(),
                    new PostgresWaitPoller(pollerOptions).pollOnce(),
                ]);
                assert.equal(
                    reports.reduce((sum, report) => sum + report.failed, 0),
                    0,
                );
                assert.equal((await adapter.getWaitRecord(key)).status, 'RESUMED');
                const storedEffects = await pool.query(`SELECT * FROM ${effects} WHERE request_id=$1`, [key]);
                assert.equal(storedEffects.rowCount, 1);
                assert.equal(storedEffects.rows[0].approved, true);
                await assert.rejects(resumeWorkflow(workflow, key, { approved: false }));

                // Actual signed callbacks race against the persistent wait claim.
                const approvalKey = `${key}_approval`;
                const approval = createRecoveryWorkflow(pool, effects, approvalKey);
                const suspended: any = await approval.run({}, { durable: true, pojo: true });
                const signingSecret = 'synthetic-exploration-secret';
                const token = await signActionToken(
                    {
                        stackId: suspended.stackId,
                        correlationKey: approvalKey,
                        expectedEvent: 'APPROVED',
                        approved: true,
                        expiresAt: Date.now() + 60000,
                    },
                    signingSecret,
                );
                const callbacks = await Promise.all(
                    [0, 1].map(() =>
                        handleNotificationCallback(token, {
                            workflow: approval,
                            allowBearerApproval: true,
                            signingSecret,
                        }),
                    ),
                );
                assert.deepEqual(callbacks.map(result => result.status).sort(), [200, 409]);
                assert.equal(
                    (await pool.query(`SELECT * FROM ${effects} WHERE request_id=$1`, [approvalKey])).rowCount,
                    1,
                );

                const locks = new RedisLock(redis as any, { keyPrefix: `${prefix}:`, strictAtomicity: true });
                try {
                    const claims = await Promise.all([locks.acquire(key, 80), locks.acquire(key, 80)]);
                    assert.equal(claims.filter(claim => claim.acquired).length, 1);
                    const stale = claims.find(claim => claim.acquired)!;
                    const deadline = Date.now() + 3000;
                    while (await redis.exists(`${prefix}:${key}`)) {
                        assert.ok(Date.now() < deadline, 'Redis lease did not expire');
                        await new Promise(r => setTimeout(r, 10));
                    }
                    const next = await locks.acquire(key, 5000);
                    assert.equal(next.acquired, true);
                    assert.equal(await locks.release(key, stale.token), false);
                    assert.equal(await redis.get(`${prefix}:${key}`), next.token);
                    assert.equal(await locks.release(key, next.token), true);
                } finally {
                    await redis.del(`${prefix}:${key}`);
                }
                defaultDurableManager.clear();
            },
        );
    } finally {
        defaultDurableManager.clear();
        useStorage(previous as any);
        try {
            for (const table of [effects, tables.waitRecordsTable, tables.eventsTable, tables.checkpointsTable])
                await pool.query(`DROP TABLE IF EXISTS ${table}`);
        } finally {
            redis.disconnect();
            await pool.end();
        }
    }
}
