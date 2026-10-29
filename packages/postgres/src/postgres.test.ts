import { expect } from 'chai';
import {
    PostgresStorageAdapter,
    PostgresIdempotencyStore,
    PostgresClientInterface,
    PostgresQueryResult
} from './index';

class MockPostgresClient implements PostgresClientInterface {
    public queries: { text: string; values?: any[] }[] = [];
    public checkpoints = new Map<string, any>();
    public events: any[] = [];
    public idempotency = new Map<string, { status: string; result?: any; expires_at: Date }>();

    async query<T = any>(queryText: string, values?: any[]): Promise<PostgresQueryResult<T>> {
        this.queries.push({ text: queryText, values });
        const text = queryText.trim().toUpperCase();

        if (text.startsWith('CREATE TABLE')) {
            return { rows: [], rowCount: 0 };
        }

        // Checkpoints
        if (text.startsWith('INSERT INTO SIGLO_CHECKPOINTS')) {
            const [stackId, namespace, state] = values || [];
            this.checkpoints.set(stackId, { stackId, namespace, state });
            return { rows: [], rowCount: 1 };
        }
        if (text.startsWith('SELECT STATE FROM SIGLO_CHECKPOINTS')) {
            const [stackId] = values || [];
            if (this.checkpoints.has(stackId)) {
                return { rows: [{ state: this.checkpoints.get(stackId).state } as unknown as T], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
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
            this.idempotency.set(key, { status: 'in-progress', expires_at: expiresAt });
            return { rows: [], rowCount: 1 };
        }
        if (text.startsWith('SELECT STATUS, RESULT, EXPIRES_AT FROM SIGLO_IDEMPOTENCY')) {
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
                this.idempotency.set(key, { status: 'completed', result: JSON.parse(resultJson), expires_at: expiresAt });
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

        it('initializes table schemas with ensureTables()', async () => {
            const adapter = new PostgresStorageAdapter({ client: mockClient });
            await adapter.ensureTables();

            const createQuery = mockClient.queries.find(q => q.text.includes('CREATE TABLE IF NOT EXISTS siglo_checkpoints'));
            expect(createQuery).to.exist;
        });

        it('saves and retrieves serialized execution checkpoints', async () => {
            const adapter = new PostgresStorageAdapter({ client: mockClient });
            const checkpoint = {
                stackId: 'pg-stack-1',
                namespace: 'tenant-postgres',
                contexts: { stepA: { status: 'ok' } },
            };

            await adapter.saveCheckpoint(checkpoint as any);
            const retrieved = await adapter.getCheckpoint('pg-stack-1');

            expect(retrieved).to.deep.equal(checkpoint);
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

            expect(mockClient.queries.some(q => q.text.includes('DELETE FROM siglo_checkpoints'))).to.be.true;
            expect(mockClient.queries.some(q => q.text.includes('DELETE FROM siglo_context_events'))).to.be.true;
        });
    });

    describe('PostgresIdempotencyStore', () => {
        it('throws if initialized without client', () => {
            expect(() => new PostgresIdempotencyStore(undefined as any)).to.throw();
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

            // 5. Get result
            const result = await store.getResult('inv:1001');
            expect(result).to.deep.equal({ invoiceId: 'inv_1001', paid: true });
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
