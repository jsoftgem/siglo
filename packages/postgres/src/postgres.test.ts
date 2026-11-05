import { expect } from 'chai';
import {
    PostgresStorageAdapter,
    PostgresIdempotencyStore,
    PostgresClientInterface,
    PostgresQueryResult
} from './index';
import { OptimisticLockException, DuplicateEventException } from '@siglo/core';

class MockPostgresClient implements PostgresClientInterface {
    public queries: { text: string; values?: any[] }[] = [];
    public checkpoints = new Map<string, { stackId: string; namespace?: string; state: any; version: number }>();
    public events: any[] = [];
    public waitRecords = new Map<string, any>();
    public idempotency = new Map<string, { status: string; result?: any; expires_at: Date; created_at: Date }>();

    async query<T = any>(queryText: string, values?: any[]): Promise<PostgresQueryResult<T>> {
        this.queries.push({ text: queryText, values });
        const text = queryText.trim().toUpperCase();

        if (text.startsWith('CREATE TABLE') || text.startsWith('ALTER TABLE') || text.startsWith('CREATE INDEX')) {
            return { rows: [], rowCount: 0 };
        }

        // Checkpoints
        if (text.startsWith('INSERT INTO SIGLO_CHECKPOINTS')) {
            const [stackId, namespace, state] = values || [];
            if (this.checkpoints.has(stackId)) {
                return { rows: [], rowCount: 0 };
            }
            this.checkpoints.set(stackId, { stackId, namespace, state, version: 1 });
            return { rows: [], rowCount: 1 };
        }
        if (text.startsWith('UPDATE SIGLO_CHECKPOINTS')) {
            const [state, namespace, stackId, expectedVersion] = values || [];
            const existing = this.checkpoints.get(stackId);
            if (existing && existing.version === Number(expectedVersion)) {
                existing.version += 1;
                existing.state = state;
                existing.namespace = namespace;
                return { rows: [{ version: existing.version } as unknown as T], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }
        if (text.startsWith('SELECT STATE, VERSION FROM SIGLO_CHECKPOINTS') || text.startsWith('SELECT STATE FROM SIGLO_CHECKPOINTS')) {
            const [stackIdOrKey] = values || [];
            if (this.checkpoints.has(stackIdOrKey)) {
                const cp = this.checkpoints.get(stackIdOrKey)!;
                return { rows: [{ state: cp.state, version: cp.version } as unknown as T], rowCount: 1 };
            }
            for (const cp of this.checkpoints.values()) {
                const parsed = typeof cp.state === 'string' ? JSON.parse(cp.state) : cp.state;
                if (parsed?.metadata?.waitRecord?.correlationKey === stackIdOrKey || parsed?.metadata?.waitRecord?.stackId === stackIdOrKey) {
                    return { rows: [{ state: cp.state, version: cp.version } as unknown as T], rowCount: 1 };
                }
            }
            return { rows: [], rowCount: 0 };
        }
        if (text.startsWith('SELECT VERSION FROM SIGLO_CHECKPOINTS')) {
            const [stackId] = values || [];
            if (this.checkpoints.has(stackId)) {
                return { rows: [{ version: this.checkpoints.get(stackId)!.version } as unknown as T], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }
        if (text.startsWith('DELETE FROM SIGLO_CHECKPOINTS')) {
            return { rows: [], rowCount: 1 };
        }

        // Wait records
        if (text.startsWith('INSERT INTO SIGLO_WAIT_RECORDS')) {
            const [corrKey, stackId, namespace, eventName, status, stepIdx, version, data, expiresAt] = values || [];
            this.waitRecords.set(corrKey, {
                correlation_key: corrKey,
                stack_id: stackId,
                namespace,
                event_name: eventName,
                status,
                continuation_step_index: stepIdx,
                version,
                data,
                expires_at: expiresAt,
                created_at: new Date(),
                updated_at: new Date()
            });
            return { rows: [], rowCount: 1 };
        }
        if (text.startsWith('UPDATE SIGLO_WAIT_RECORDS')) {
            const [claimantId, corrKey, payload] = values || [];
            const rec = this.waitRecords.get(corrKey);
            if (rec && rec.status === 'WAITING') {
                rec.status = 'RESUMING';
                rec.resume_payload = payload;
                rec.locked_by = claimantId;
                rec.resumed_by = claimantId;
                rec.resumed_at = new Date();
                return { rows: [rec as unknown as T], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }
        if (text.startsWith('SELECT * FROM SIGLO_WAIT_RECORDS')) {
            const [keyOrStack] = values || [];
            const rec = this.waitRecords.get(keyOrStack) || Array.from(this.waitRecords.values()).find(r => r.stack_id === keyOrStack);
            if (rec) {
                return { rows: [rec as unknown as T], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }
        if (text.startsWith('DELETE FROM SIGLO_WAIT_RECORDS')) {
            return { rows: [], rowCount: 1 };
        }

        // Events
        if (text.startsWith('INSERT INTO SIGLO_CONTEXT_EVENTS')) {
            const [stackId, stepId, namespace, field, value] = values || [];
            this.events.push({ stackId, stepId, namespace, field, value });
            return { rows: [], rowCount: 1 };
        }

        // Idempotency
        if (text.startsWith('INSERT INTO SIGLO_IDEMPOTENCY')) {
            const [key, expiresAt] = values || [];
            if (this.idempotency.has(key)) {
                return { rows: [], rowCount: 0 }; // Conflict
            }
            this.idempotency.set(key, { status: 'in-progress', expires_at: expiresAt, created_at: new Date() });
            return { rows: [], rowCount: 1 };
        }
        if (text.startsWith('SELECT STATUS, RESULT, EXPIRES_AT, CREATED_AT FROM SIGLO_IDEMPOTENCY') ||
            text.startsWith('SELECT STATUS, RESULT, EXPIRES_AT FROM SIGLO_IDEMPOTENCY')) {
            const [key] = values || [];
            const rec = this.idempotency.get(key);
            if (rec) {
                return { rows: [rec as unknown as T], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }
        if (text.startsWith('UPDATE SIGLO_IDEMPOTENCY')) {
            const [key, resultJson, expiresAt] = values || [];
            if (this.idempotency.has(key)) {
                const rec = this.idempotency.get(key)!;
                rec.status = 'completed';
                rec.result = JSON.parse(resultJson);
                rec.expires_at = expiresAt;
                return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }
        if (text.startsWith('DELETE FROM SIGLO_IDEMPOTENCY')) {
            const [key] = values || [];
            if (key && this.idempotency.has(key)) {
                this.idempotency.delete(key);
                return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }
        if (text.startsWith('SELECT RESULT FROM SIGLO_IDEMPOTENCY')) {
            const [key] = values || [];
            const rec = this.idempotency.get(key);
            if (rec && rec.status === 'completed') {
                return { rows: [{ result: rec.result } as unknown as T], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }

        return { rows: [], rowCount: 0 };
    }
}

describe('@siglo/postgres Storage & Idempotency Adapter Suite', () => {
    let mockClient: MockPostgresClient;

    beforeEach(() => {
        mockClient = new MockPostgresClient();
    });

    describe('PostgresStorageAdapter', () => {
        it('throws if initialized without client', () => {
            expect(() => new PostgresStorageAdapter(undefined as any)).to.throw();
        });

        it('validates custom table names and rejects SQL injection attempts', () => {
            expect(() => new PostgresStorageAdapter({
                client: mockClient,
                checkpointsTable: 'checkpoints; DROP TABLE users;--'
            })).to.throw(/Invalid SQL identifier/);

            expect(() => new PostgresStorageAdapter({
                client: mockClient,
                eventsTable: 'events" OR 1=1--'
            })).to.throw(/Invalid SQL identifier/);

            expect(() => new PostgresStorageAdapter({
                client: mockClient,
                waitRecordsTable: 'wait" OR 1=1--'
            })).to.throw(/Invalid SQL identifier/);
        });

        it('initializes table schemas with ensureTables()', async () => {
            const adapter = new PostgresStorageAdapter({ client: mockClient });
            await adapter.ensureTables();

            const createQuery = mockClient.queries.find(q => q.text.includes('CREATE TABLE IF NOT EXISTS siglo_checkpoints'));
            expect(createQuery).to.exist;
            const createWait = mockClient.queries.find(q => q.text.includes('CREATE TABLE IF NOT EXISTS siglo_wait_records'));
            expect(createWait).to.exist;
        });

        it('saves and retrieves serialized execution checkpoints with OCC versioning', async () => {
            const adapter = new PostgresStorageAdapter({ client: mockClient });
            const checkpoint = {
                stackId: 'pg-stack-1',
                namespace: 'tenant-postgres',
                contexts: { stepA: { status: 'ok' } },
            };

            await adapter.saveCheckpoint(checkpoint as any);
            const retrieved = await adapter.getCheckpoint('pg-stack-1');

            expect(retrieved).to.exist;
            expect(retrieved!.stackId).to.equal(checkpoint.stackId);
            expect(retrieved!.namespace).to.equal(checkpoint.namespace);
            expect((retrieved as any).occVersion).to.equal(1);
        });

        it('enforces Optimistic Concurrency Control (OCC) on concurrent saves', async () => {
            const adapter = new PostgresStorageAdapter({ client: mockClient });
            const checkpoint = {
                stackId: 'pg-occ-stack',
                namespace: 'tenant-occ',
                contexts: { stepA: { status: 'initial' } }
            };

            await adapter.saveCheckpoint(checkpoint as any);

            // Both workers fetch version 1
            const workerA = await adapter.getCheckpoint('pg-occ-stack');
            const workerB = await adapter.getCheckpoint('pg-occ-stack');

            expect((workerA as any).occVersion).to.equal(1);
            expect((workerB as any).occVersion).to.equal(1);

            // Worker A updates with expected version 1 -> succeeds
            (workerA as any).contexts.stepA.status = 'updated-by-A';
            await adapter.saveCheckpoint(workerA!, 1);

            // Check version is now 2
            const current = await adapter.getCheckpoint('pg-occ-stack');
            expect((current as any).occVersion).to.equal(2);

            // Worker B attempts to update with stale expected version 1 -> throws OptimisticLockException
            (workerB as any).contexts.stepA.status = 'updated-by-B';
            try {
                await adapter.saveCheckpoint(workerB!, 1);
                expect.fail('Expected OptimisticLockException to be thrown');
            } catch (err: any) {
                expect(err).to.be.instanceOf(OptimisticLockException);
                expect(err.expectedVersion).to.equal(1);
                expect(err.currentVersion).to.equal(2);
            }
        });

        it('returns undefined when checkpoint is missing', async () => {
            const adapter = new PostgresStorageAdapter({ client: mockClient });
            const result = await adapter.getCheckpoint('missing-id');
            expect(result).to.be.undefined;
        });

        it('records context changes as event audit rows', async () => {
            const adapter = new PostgresStorageAdapter({ client: mockClient });
            await adapter.onContextChange({
                stackId: 'pg-stack-2',
                stepId: 'executeTransfer',
                namespace: 'tenant-bank',
                field: 'transferId',
                value: 'tr_12345',
                timestamp: Date.now(),
            });

            expect(mockClient.events).to.have.lengthOf(1);
            expect(mockClient.events[0].field).to.equal('transferId');
        });

        it('executes cleanup queries for retention policies', async () => {
            const adapter = new PostgresStorageAdapter({ client: mockClient });
            await adapter.cleanupOldCheckpoints(14);
            await adapter.cleanupOldEvents(7);
            await adapter.cleanupOldWaitRecords(30);

            expect(mockClient.queries.some(q => q.text.includes('DELETE FROM siglo_checkpoints'))).to.be.true;
            expect(mockClient.queries.some(q => q.text.includes('DELETE FROM siglo_context_events'))).to.be.true;
            expect(mockClient.queries.some(q => q.text.includes('DELETE FROM siglo_wait_records'))).to.be.true;
        });

        it('cleans expired checkpoints and persists wait records', async () => {
            const adapter = new PostgresStorageAdapter({ client: mockClient });
            const cleaned = await adapter.cleanExpiredCheckpoints();
            expect(cleaned).to.equal(1);
            expect(mockClient.queries.some(q => q.text.includes("expiresAt"))).to.be.true;

            const waitRecord = {
                stackId: 'pg-wait-stack',
                correlationKey: 'corr-pg-1',
                eventName: 'approval',
                status: 'WAITING',
                continuationStepIndex: 1
            };
            await adapter.saveWaitRecord(waitRecord);
            const retrievedByStack = await adapter.getWaitRecord('pg-wait-stack');
            expect(retrievedByStack.correlationKey).to.equal(waitRecord.correlationKey);
            expect(retrievedByStack.status).to.equal('WAITING');

            const retrievedByKey = await adapter.getWaitRecord('corr-pg-1');
            expect(retrievedByKey.correlationKey).to.equal(waitRecord.correlationKey);

            expect(await adapter.getWaitRecord('')).to.be.undefined;
            await adapter.saveWaitRecord(null as any);
        });

        it('supports atomic resumption claims via claimWaitRecord', async () => {
            const adapter = new PostgresStorageAdapter({ client: mockClient });
            const waitRecord = {
                stackId: 'pg-claim-stack',
                correlationKey: 'claim-corr-1',
                eventName: 'payment_verified',
                status: 'WAITING',
                continuationStepIndex: 2
            };
            await adapter.saveWaitRecord(waitRecord);

            // First claim succeeds
            const claimed = await adapter.claimWaitRecord('claim-corr-1', 'worker-1');
            expect(claimed.status).to.equal('RESUMING');
            expect(claimed.resumedBy).to.equal('worker-1');

            // Concurrent duplicate claim fails with DuplicateEventException
            try {
                await adapter.claimWaitRecord('claim-corr-1', 'worker-2');
                expect.fail('Expected DuplicateEventException');
            } catch (err: any) {
                expect(err).to.be.instanceOf(DuplicateEventException);
                expect(err.correlationKey).to.equal('claim-corr-1');
            }
        });
    });

    describe('PostgresIdempotencyStore', () => {
        it('throws if initialized without client', () => {
            expect(() => new PostgresIdempotencyStore(undefined as any)).to.throw();
        });

        it('validates custom table names and rejects SQL injection attempts', () => {
            expect(() => new PostgresIdempotencyStore({
                client: mockClient,
                tableName: 'idemp; DROP TABLE accounts;--'
            })).to.throw(/Invalid SQL identifier/);
        });

        it('creates schema with ensureTable()', async () => {
            const store = new PostgresIdempotencyStore({ client: mockClient });
            await store.ensureTable();
            expect(mockClient.queries.some(q => q.text.includes('CREATE TABLE IF NOT EXISTS siglo_idempotency'))).to.be.true;
        });

        it('manages claim lifecycle: fresh claim -> in-progress -> completed', async () => {
            const store = new PostgresIdempotencyStore({ client: mockClient });

            // 1. Fresh claim
            const status1 = await store.claim('inv:1001', 60000);
            expect(status1).to.equal('claimed');

            // 2. Duplicate concurrent claim
            const status2 = await store.claim('inv:1001', 60000);
            expect(status2).to.equal('in-progress');

            // 3. Mark completed
            await store.complete('inv:1001', { invoiceId: 'inv_1001', paid: true });

            // 4. Subsequent check
            const status3 = await store.claim('inv:1001', 60000);
            expect(status3).to.equal('completed');

            // 5. Get result via getResult and get
            const result = await store.getResult('inv:1001');
            expect(result).to.deep.equal({ invoiceId: 'inv_1001', paid: true });
            const direct = await store.get('inv:1001');
            expect(direct).to.deep.equal({ invoiceId: 'inv_1001', paid: true });

            // 6. Inspect record metadata via getRecord
            const rec = await store.getRecord('inv:1001');
            expect(rec).to.exist;
            expect(rec.status).to.equal('completed');
            expect(rec.result).to.deep.equal({ invoiceId: 'inv_1001', paid: true });
        });

        it('clears in-progress claim on failure to allow retry', async () => {
            const store = new PostgresIdempotencyStore({ client: mockClient });
            await store.claim('inv:1002', 60000);

            await store.fail('inv:1002', new Error('DB timeout'));

            const retried = await store.claim('inv:1002', 60000);
            expect(retried).to.equal('claimed');
        });
    });
});
