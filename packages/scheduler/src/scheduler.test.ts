import { expect } from 'chai';
import * as http from 'http';
import { Step, flow, defaultDurableManager, clearStorage, useStorage } from '@siglo/core';
import {
    PostgresWaitPoller,
    MemoryWaitPoller,
    createSchedulerWebhookHandler
} from './index';

function postgresPoller(options: any): PostgresWaitPoller {
    if (options?.client) useStorage({
        name: 'test-durable',
        getWaitRecord: async (key: string) => defaultDurableManager.getWaiting(key) ?? defaultDurableManager.getWaitingByStack(key),
        withWorkflowLock: async (_: string, action: any) => action(),
        claimWaitRecord: async (key: string, _: string, opts: any) => ({ ...defaultDurableManager.resumeWait(key, opts.allowExpired), resumePayload: opts.eventPayload }),
        completeWaitRecord: async (key: string, worker: string) => {
            await options.client.query(`UPDATE siglo_wait_records SET status = 'RESUMED' WHERE correlation_key = $2`, [worker, key]);
        }
    });
    return new PostgresWaitPoller(options);
}

describe('@siglo/scheduler Suite', () => {
    beforeEach(() => {
        clearStorage();
        defaultDurableManager.clear();
    });

    afterEach(() => {
        clearStorage();
        defaultDurableManager.clear();
    });

    describe('PostgresWaitPoller', () => {
        it('throws an error if client is missing or identifier contains SQL injection', () => {
            expect(() => postgresPoller(null as any)).to.throw('PostgresWaitPoller requires a valid PostgreSQL client');
            expect(() => postgresPoller({ client: {} as any, waitRecordsTable: 'bad table; DROP TABLE--' }))
                .to.throw('Identifier contains forbidden characters');
        });

        it('fails closed without a durable storage adapter', async () => {
            useStorage(undefined as any);
            let queried = false;
            const poller = new PostgresWaitPoller({ client: { query: async () => { queried = true; return { rows: [], rowCount: 0 }; } } });
            try { await poller.pollOnce(); expect.fail('Expected missing storage failure'); }
            catch (error: any) { expect(error.message).to.include('storage adapter with workflow locks'); }
            expect(queried).to.equal(false);
        });

        it('ensures table schema with ensureTable()', async () => {
            let executedQuery = '';
            const mockClient = {
                query: async (sql: string) => {
                    executedQuery = sql;
                    return { rows: [], rowCount: 0 };
                }
            };

            const poller = postgresPoller({
                client: mockClient,
                waitRecordsTable: 'test_wait_records'
            });

            await poller.ensureTable();
            expect(executedQuery).to.include('CREATE TABLE IF NOT EXISTS test_wait_records');
            expect(executedQuery).to.include('idx_test_wait_records_due');
        });

        it('claims due records, invokes flow resumption, and marks status as RESUMED', async () => {
            const now = new Date();
            const past = new Date(Date.now() - 5000);

            const mockRows = [
                {
                    correlation_key: 'corr-due-1',
                    stack_id: 'stack-due-1',
                    status: 'WAITING',
                    expires_at: past,
                    data: JSON.stringify({ amount: 100 }),
                    continuation_step_index: 1
                }
            ];

            const executedQueries: Array<{ sql: string; params?: any[] }> = [];
            const mockClient = {
                query: async (sql: string, params?: any[]) => {
                    executedQueries.push({ sql, params });
                    if (sql.includes('WITH due_records') || sql.includes('SELECT * FROM')) {
                        return { rows: mockRows, rowCount: mockRows.length };
                    }
                    return { rows: [], rowCount: 1 };
                }
            };

            let resumedRecord: any = null;
            let flowExecuted = false;

            const dummyFlow = flow(
                Step.create('resumeStep', async (input: any) => {
                    flowExecuted = true;
                    return { resumed: true, input };
                })
            );

            const poller = postgresPoller({
                client: mockClient,
                waitRecordsTable: 'siglo_wait_records',
                flowLookup: (wfId, stackId) => (stackId === 'stack-due-1' ? dummyFlow : undefined),
                onResumed: (rec) => {
                    resumedRecord = rec;
                }
            });

            const report = await poller.pollOnce();
            expect(report.claimed).to.equal(1);
            expect(report.resumed).to.equal(1);
            expect(report.failed).to.equal(0);
            expect(resumedRecord).to.not.be.null;
            expect(resumedRecord.correlationKey).to.equal('corr-due-1');

            // Verify status was updated to RESUMED
            const updateResumed = executedQueries.find(q => q.sql.includes("SET status = 'RESUMED'"));
            expect(updateResumed).to.not.be.undefined;
            expect(updateResumed?.params?.[1]).to.equal('corr-due-1');
        });

        it('reports failures without discarding the recoverable continuation', async () => {
            const past = new Date(Date.now() - 5000);
            const mockRows = [
                {
                    correlation_key: 'corr-fail-1',
                    stack_id: 'stack-fail-1',
                    status: 'WAITING',
                    expires_at: past
                }
            ];

            const executedQueries: Array<{ sql: string; params?: any[] }> = [];
            const mockClient = {
                query: async (sql: string, params?: any[]) => {
                    executedQueries.push({ sql, params });
                    if (sql.includes('WITH due_records')) {
                        return { rows: mockRows, rowCount: 1 };
                    }
                    return { rows: [], rowCount: 1 };
                }
            };

            let failedRec: any = null;
            let failedErr: any = null;

            const failingFlow = flow(
                Step.create('failStep', async () => {
                    throw new Error('Database locked');
                })
            );

            const poller = postgresPoller({
                client: mockClient,
                flowLookup: () => failingFlow,
                onFailed: (rec, err) => {
                    failedRec = rec;
                    failedErr = err;
                }
            });

            const report = await poller.pollOnce();
            expect(report.claimed).to.equal(1);
            expect(report.resumed).to.equal(0);
            expect(report.failed).to.equal(1);
            expect(failedRec?.correlationKey).to.equal('corr-fail-1');
            expect(failedErr?.message).to.equal('Database locked');

            const updateFailed = executedQueries.find(q => q.sql.includes("SET status = 'FAILED'"));
            expect(updateFailed).to.be.undefined;
        });

        it('starts and stops background polling loop', async () => {
            const mockClient = {
                query: async () => ({ rows: [], rowCount: 0 })
            };

            const poller = postgresPoller({
                client: mockClient,
                pollIntervalMs: 20
            });

            expect(poller.isRunning()).to.be.false;
            poller.start();
            expect(poller.isRunning()).to.be.true;

            await new Promise(r => setTimeout(r, 60));
            await poller.stop();
            expect(poller.isRunning()).to.be.false;
        });
    });

    describe('MemoryWaitPoller', () => {
        it('polls and resumes expired in-memory wait records', async () => {
            const now = Date.now();
            let resumed = false;

            defaultDurableManager.registerWait({
                correlationKey: 'mem-wait-1',
                stackId: 'mem-stack-1',
                continuationStepIndex: 0,
                expiresAt: now - 1000 // expired
            });

            const poller = new MemoryWaitPoller({
                onResumed: () => {
                    resumed = true;
                }
            });

            const report = await poller.pollOnce();
            expect(report.claimed).to.equal(1);
            expect(report.resumed).to.equal(1);
            expect(resumed).to.be.true;
        });

        it('starts and stops memory poller loop', async () => {
            const poller = new MemoryWaitPoller({ pollIntervalMs: 20 });
            expect(poller.isRunning()).to.be.false;
            poller.start();
            expect(poller.isRunning()).to.be.true;
            await new Promise(r => setTimeout(r, 50));
            await poller.stop();
            expect(poller.isRunning()).to.be.false;
        });
    });

    describe('CloudSchedulerWebhookHandler', () => {
        let server: http.Server;
        let port: number;

        afterEach(async () => {
            if (server) {
                await new Promise(r => server.close(r));
            }
        });

        it('dispatches incoming cloud webhook calls and resumes workflow', async () => {
            let resumedStack = '';
            const testFlow = flow(
                Step.create('step1', async () => ({ status: 'DONE' }))
            );

            const handler = createSchedulerWebhookHandler({
                secretToken: 'cloud-secret-token',
                flowLookup: (wfId, stackId) => (stackId === 'cloud-stk-1' ? testFlow : undefined),
                onResumed: (id) => {
                    resumedStack = id;
                }
            });

            server = http.createServer(handler);
            await new Promise<void>(res => {
                server.listen(0, '127.0.0.1', () => {
                    port = (server.address() as any).port;
                    res();
                });
            });

            // 1. Wrong method -> 405
            const getRes = await fetch(`http://127.0.0.1:${port}`, { method: 'GET' });
            expect(getRes.status).to.equal(405);

            // 2. Unauthorized -> 401
            const unauthRes = await fetch(`http://127.0.0.1:${port}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stackId: 'cloud-stk-1' })
            });
            expect(unauthRes.status).to.equal(401);

            // 3. Missing stackId -> 400
            const badBodyRes = await fetch(`http://127.0.0.1:${port}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer cloud-secret-token'
                },
                body: JSON.stringify({})
            });
            expect(badBodyRes.status).to.equal(400);

            // 4. Unknown flow -> 404
            const notFoundRes = await fetch(`http://127.0.0.1:${port}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer cloud-secret-token'
                },
                body: JSON.stringify({ stackId: 'unknown-stack' })
            });
            expect(notFoundRes.status).to.equal(404);

            // 5. Successful dispatch -> 200
            const successRes = await fetch(`http://127.0.0.1:${port}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Siglo-Token': 'cloud-secret-token'
                },
                body: JSON.stringify({ stackId: 'cloud-stk-1' })
            });
            expect(successRes.status).to.equal(200);
            const resJson = await successRes.json() as any;
            expect(resJson.ok).to.be.true;
            expect(resumedStack).to.equal('cloud-stk-1');
        });
    });
});
