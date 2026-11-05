import { AsyncLocalStorage } from 'node:async_hooks';
import { StorageAdapter, SerializedExecutionStack, OptimisticLockException, DuplicateEventException, ExpiredWaitException } from '@siglo/core';
import { PostgresStorageAdapterOptions, PostgresClientInterface } from './types';

function validateIdentifier(name: string, paramName: string): string {
    if (!name || typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || name.length > 63) {
        throw new Error(`Invalid SQL identifier for ${paramName}: "${name}". Must be 1-63 alphanumeric characters or underscores, starting with a letter or underscore.`);
    }
    return name;
}

export class PostgresStorageAdapter implements StorageAdapter {
    public readonly name = 'postgres';
    private baseClient: PostgresClientInterface;
    private scope = new AsyncLocalStorage<{ stackId: string; client: PostgresClientInterface; tail: Promise<unknown>; active: boolean }>();
    private directClientBusy = false;
    private get client(): PostgresClientInterface { return this.scope.getStore()?.active ? this.scope.getStore()!.client : this.baseClient; }
    private checkpointsTable: string;
    private eventsTable: string;
    private waitRecordsTable: string;
    private recordContextChanges: boolean;

    constructor(options: PostgresStorageAdapterOptions) {
        if (!options || !options.client) {
            throw new Error('PostgresStorageAdapter requires a valid Postgres client or pool instance.');
        }
        this.baseClient = options.client;
        this.checkpointsTable = validateIdentifier(options.checkpointsTable || 'siglo_checkpoints', 'checkpointsTable');
        this.eventsTable = validateIdentifier(options.eventsTable || 'siglo_context_events', 'eventsTable');
        this.waitRecordsTable = validateIdentifier(options.waitRecordsTable || 'siglo_wait_records', 'waitRecordsTable');
        this.recordContextChanges = options.recordContextChanges ?? true;
    }

    /**
     * Initializes the necessary PostgreSQL schema and tables if they do not exist.
     */
    async ensureTables(): Promise<void> {
        await this.client.query(`
            CREATE TABLE IF NOT EXISTS ${this.checkpointsTable} (
                stack_id VARCHAR(255) PRIMARY KEY,
                namespace VARCHAR(255),
                state JSONB NOT NULL,
                version BIGINT NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            ALTER TABLE ${this.checkpointsTable} ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
            CREATE INDEX IF NOT EXISTS idx_${this.checkpointsTable}_namespace ON ${this.checkpointsTable}(namespace);

            CREATE TABLE IF NOT EXISTS ${this.eventsTable} (
                id BIGSERIAL PRIMARY KEY,
                stack_id VARCHAR(255) NOT NULL,
                step_id VARCHAR(255) NOT NULL,
                namespace VARCHAR(255),
                field VARCHAR(255) NOT NULL,
                value JSONB,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_${this.eventsTable}_stack ON ${this.eventsTable}(stack_id);

            CREATE TABLE IF NOT EXISTS ${this.waitRecordsTable} (
                correlation_key VARCHAR(255) PRIMARY KEY,
                stack_id VARCHAR(255) NOT NULL,
                namespace VARCHAR(255),
                event_name VARCHAR(255),
                status VARCHAR(50) NOT NULL DEFAULT 'WAITING',
                continuation_step_index INT NOT NULL DEFAULT 0,
                version VARCHAR(50),
                data JSONB,
                resumed_by VARCHAR(255),
                resumed_at TIMESTAMPTZ,
                expires_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            ALTER TABLE ${this.waitRecordsTable} ADD COLUMN IF NOT EXISTS resume_payload JSONB;
            ALTER TABLE ${this.waitRecordsTable} ADD COLUMN IF NOT EXISTS locked_by TEXT;
            ALTER TABLE ${this.waitRecordsTable} ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
            CREATE INDEX IF NOT EXISTS idx_${this.waitRecordsTable}_stack ON ${this.waitRecordsTable}(stack_id);
            CREATE INDEX IF NOT EXISTS idx_${this.waitRecordsTable}_status ON ${this.waitRecordsTable}(status);
        `);
    }

    private trackWrite(action: () => Promise<void>): Promise<void> {
        const scope = this.scope.getStore();
        if (!scope?.active) return action();
        const pending = scope.tail.then(action);
        scope.tail = pending;
        pending.catch(() => {});
        return pending;
    }

    saveCheckpoint(checkpoint: SerializedExecutionStack, expectedVersion?: number): Promise<void> {
        return this.trackWrite(() => this.persistCheckpoint(checkpoint, expectedVersion));
    }

    private async persistCheckpoint(checkpoint: SerializedExecutionStack, expectedVersion?: number): Promise<void> {
        if (!checkpoint || !checkpoint.stackId) {
            return;
        }
        const stateJson = JSON.stringify(checkpoint);
        const namespace = checkpoint.namespace || null;

        const versionToExpect = expectedVersion !== undefined
            ? expectedVersion
            : ((checkpoint as any).occVersion !== undefined ? (checkpoint as any).occVersion : undefined);

        if (versionToExpect !== undefined) {
            const updateRes = await this.client.query(
                `UPDATE ${this.checkpointsTable}
                 SET state = CASE WHEN state->>'status' = 'cancelled' THEN jsonb_set($1::jsonb, '{status}', '"cancelled"') ELSE $1::jsonb END, namespace = $2, version = version + 1, updated_at = NOW()
                 WHERE stack_id = $3 AND version = $4
                 RETURNING version`,
                [stateJson, namespace, checkpoint.stackId, versionToExpect]
            );

            if ((updateRes.rowCount || 0) === 0) {
                const existingRes = await this.client.query(
                    `SELECT version FROM ${this.checkpointsTable} WHERE stack_id = $1`,
                    [checkpoint.stackId]
                );
                const currentVersion = existingRes.rows && existingRes.rows.length > 0
                    ? Number(existingRes.rows[0].version)
                    : undefined;
                throw new OptimisticLockException(checkpoint.stackId, currentVersion, versionToExpect);
            }
            if (updateRes.rows && updateRes.rows.length > 0) {
                (checkpoint as any).occVersion = Number(updateRes.rows[0].version);
                checkpoint.revision = (checkpoint as any).occVersion;
            }
            return;
        }

        const insertRes = await this.client.query(
            `INSERT INTO ${this.checkpointsTable} (stack_id, namespace, state, version, updated_at)
             VALUES ($1, $2, $3::jsonb, 1, NOW())
             ON CONFLICT (stack_id) DO NOTHING`,
            [checkpoint.stackId, namespace, stateJson]
        );

        if ((insertRes.rowCount || 0) > 0) {
            (checkpoint as any).occVersion = 1;
            checkpoint.revision = 1;
            return;
        }

        const existingRes = await this.client.query(
            `SELECT version FROM ${this.checkpointsTable} WHERE stack_id = $1`,
            [checkpoint.stackId]
        );
        if (existingRes.rows && existingRes.rows.length > 0) {
            const curr = Number(existingRes.rows[0].version);
            const updateRes = await this.client.query(
                `UPDATE ${this.checkpointsTable}
                 SET state = CASE WHEN state->>'status' = 'cancelled' THEN jsonb_set($1::jsonb, '{status}', '"cancelled"') ELSE $1::jsonb END, namespace = $2, version = version + 1, updated_at = NOW()
                 WHERE stack_id = $3 AND version = $4
                 RETURNING version`,
                [stateJson, namespace, checkpoint.stackId, curr]
            );
            if ((updateRes.rowCount || 0) === 0) {
                const refreshed = await this.client.query(
                    `SELECT version FROM ${this.checkpointsTable} WHERE stack_id = $1`,
                    [checkpoint.stackId]
                );
                const actual = refreshed.rows && refreshed.rows.length > 0 ? Number(refreshed.rows[0].version) : undefined;
                throw new OptimisticLockException(checkpoint.stackId, actual, curr);
            }
            if (updateRes.rows && updateRes.rows.length > 0) {
                (checkpoint as any).occVersion = Number(updateRes.rows[0].version);
                checkpoint.revision = (checkpoint as any).occVersion;
            }
        }
    }

    async getCheckpoint(stackId: string): Promise<SerializedExecutionStack | undefined> {
        if (!stackId) {
            return undefined;
        }
        const res = await this.client.query(
            `SELECT state, version FROM ${this.checkpointsTable} WHERE stack_id = $1`,
            [stackId]
        );
        if (!res.rows || res.rows.length === 0) {
            return undefined;
        }
        const row = res.rows[0];
        const rowState = row.state;
        const checkpoint = typeof rowState === 'string' ? JSON.parse(rowState) : rowState;
        if (checkpoint && row.version !== undefined) {
            (checkpoint as any).occVersion = Number(row.version);
            checkpoint.revision = Number(row.version);
        }
        return checkpoint;
    }

    async onContextChange(entry: {
        namespace?: string;
        stackId: string;
        stepId: string;
        field: string;
        value: any;
        timestamp: number;
    }): Promise<void> {
        if (!this.recordContextChanges) {
            return;
        }
        try {
            const valJson = typeof entry.value === 'object' && entry.value !== null
                ? JSON.stringify(entry.value)
                : JSON.stringify({ value: entry.value });

            await this.client.query(
                `INSERT INTO ${this.eventsTable} (stack_id, step_id, namespace, field, value, created_at)
                 VALUES ($1, $2, $3, $4, $5::jsonb, to_timestamp($6 / 1000.0))`,
                [entry.stackId, entry.stepId, entry.namespace || null, entry.field, valJson, entry.timestamp]
            );
        } catch {
            // Non-blocking telemetry stream
        }
    }

    async cleanExpiredCheckpoints(): Promise<number> {
        const res = await this.client.query(
            `DELETE FROM ${this.checkpointsTable} 
             WHERE (state->>'expiresAt') IS NOT NULL 
               AND (state->>'expiresAt')::bigint <= (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint`
        );
        return res.rowCount || 0;
    }

    saveWaitRecord(record: any): Promise<void> {
        return this.trackWrite(() => this.persistWaitRecord(record));
    }

    private async persistWaitRecord(record: any): Promise<void> {
        if (!record || (!record.correlationKey && !record.stackId)) {
            return;
        }
        const corrKey = record.correlationKey || record.stackId;
        const stackId = record.stackId || record.correlationKey;
        const dataJson = record.data ? JSON.stringify(record.data) : null;
        const expiresAt = record.expiresAt ? new Date(record.expiresAt) : null;
        const status = (record.status || 'WAITING').toUpperCase();

        await this.client.query(
            `INSERT INTO ${this.waitRecordsTable} 
             (correlation_key, stack_id, namespace, event_name, status, continuation_step_index, version, data, expires_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, NOW(), NOW())
             ON CONFLICT (correlation_key)
             DO UPDATE SET 
                 stack_id = EXCLUDED.stack_id,
                 namespace = EXCLUDED.namespace,
                 event_name = EXCLUDED.event_name,
                 status = EXCLUDED.status,
                 continuation_step_index = EXCLUDED.continuation_step_index,
                 version = EXCLUDED.version,
                 data = EXCLUDED.data,
                 expires_at = EXCLUDED.expires_at,
                 updated_at = NOW()
             WHERE ${this.waitRecordsTable}.status = 'WAITING' AND ${this.waitRecordsTable}.stack_id = EXCLUDED.stack_id`,
            [
                corrKey,
                stackId,
                record.namespace || null,
                record.eventName || null,
                status,
                record.continuationStepIndex || 0,
                record.version !== undefined ? String(record.version) : null,
                dataJson,
                expiresAt
            ]
        );

        if (stackId) {
            const cp = await this.getCheckpoint(stackId);
            if (cp) {
                cp.metadata = { ...(cp.metadata || {}), waitRecord: record };
                await this.persistCheckpoint(cp);
            }
        }
    }

    /** A database-session lock serializes continuation and compensation. Process death releases it. */
    async withWorkflowLock<T>(stackId: string, action: () => Promise<T>): Promise<T> {
        if (this.scope.getStore()?.active && this.scope.getStore()?.stackId === stackId) return action();
        const pool = this.baseClient as any;
        const pooled = 'totalCount' in pool;
        if (!pooled && this.directClientBusy) throw new DuplicateEventException(stackId);
        if (!pooled) this.directClientBusy = true;
        let client: any;
        let locked = false;
        try {
            client = pooled ? await pool.connect() : pool;
            const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`siglo:workflow:${stackId}`]);
            locked = result.rows[0]?.locked === true;
            if (!locked) throw new DuplicateEventException(stackId);
            const scope = { stackId, client, tail: Promise.resolve() as Promise<unknown>, active: true };
            return await this.scope.run(scope, async () => {
                try { return await action(); }
                finally { try { await scope.tail; } finally { scope.active = false; } }
            });
        } finally {
            try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`siglo:workflow:${stackId}`]); }
            catch (error) { if (pooled) { client?.release(error); client = undefined; } throw error; }
            finally { if (pooled) client?.release(); else this.directClientBusy = false; }
        }
    }

    async cancelWaitRecord(correlationKey: string): Promise<void> {
        await this.client.query(`UPDATE ${this.waitRecordsTable} SET status = 'CANCELLED', updated_at = NOW() WHERE correlation_key = $1`, [correlationKey]);
    }

    async cancelWorkflow(stackId: string): Promise<void> {
        // Drain earlier checkpoint/wait writes before setting the cancellation barrier.
        await this.scope.getStore()?.tail;
        await this.client.query(`UPDATE ${this.waitRecordsTable} SET status = 'CANCELLED', updated_at = NOW() WHERE stack_id = $1`, [stackId]);
        await this.client.query(`UPDATE ${this.checkpointsTable} SET state = jsonb_set(state, '{status}', '"cancelled"'), version = version + 1 WHERE stack_id = $1`, [stackId]);
    }

    async completeWaitRecord(correlationKey: string, claimantId: string): Promise<void> {
        await this.scope.getStore()?.tail;
        await this.client.query(`UPDATE ${this.waitRecordsTable} SET status = 'RESUMED', resumed_at = NOW(), resumed_by = $1, updated_at = NOW()
            WHERE correlation_key = $2 AND status = 'RESUMING' AND locked_by = $1`, [claimantId, correlationKey]);
    }

    async claimWaitRecord(correlationKey: string, claimantId: string = 'worker', options?: { allowExpired?: boolean; eventPayload?: any }): Promise<any> {
        if (!correlationKey) {
            throw new Error('claimWaitRecord requires a valid correlationKey.');
        }
        const res = await this.client.query(
            `UPDATE ${this.waitRecordsTable}
             SET status = 'RESUMING', locked_at = NOW(), locked_by = $1,
                 resume_payload = COALESCE(resume_payload, $3::jsonb), updated_at = NOW()
             WHERE correlation_key = $2
               AND (status = 'WAITING' OR (status = 'RESUMING' AND $5))
               AND (resume_payload IS NOT NULL OR $4 OR expires_at IS NULL OR expires_at > NOW())
             RETURNING *`,
            [claimantId, correlationKey, JSON.stringify(options?.eventPayload ?? {}), options?.allowExpired === true, this.scope.getStore()?.active === true]
        );
        if (!res.rows || res.rows.length === 0) {
            const record = await this.getWaitRecord(correlationKey);
            if (record?.status === 'WAITING' && record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
                throw new ExpiredWaitException(correlationKey, record.expiresAt, record.eventName);
            }
            throw new DuplicateEventException(correlationKey);
        }
        const row = res.rows[0];
        return {
            stackId: row.stack_id,
            correlationKey: row.correlation_key,
            namespace: row.namespace,
            eventName: row.event_name,
            status: row.status,
            continuationStepIndex: row.continuation_step_index !== undefined ? Number(row.continuation_step_index) : 0,
            version: row.version,
            data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
            resumePayload: typeof row.resume_payload === 'string' ? JSON.parse(row.resume_payload) : row.resume_payload,
            expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : undefined,
            resumedBy: row.resumed_by,
            resumedAt: row.resumed_at ? new Date(row.resumed_at).toISOString() : undefined,
            createdAt: row.created_at ? new Date(row.created_at).getTime() : undefined
        };
    }

    async getWaitRecord(correlationKeyOrStackId: string): Promise<any | undefined> {
        if (!correlationKeyOrStackId) {
            return undefined;
        }
        const res = await this.client.query(
            `SELECT * FROM ${this.waitRecordsTable} 
             WHERE correlation_key = $1 OR stack_id = $1 LIMIT 1`,
            [correlationKeyOrStackId]
        );
        if (res.rows && res.rows.length > 0) {
            const row = res.rows[0];
            return {
                stackId: row.stack_id,
                correlationKey: row.correlation_key,
                namespace: row.namespace,
                eventName: row.event_name,
                status: row.status,
                continuationStepIndex: row.continuation_step_index !== undefined ? Number(row.continuation_step_index) : 0,
                version: row.version,
                data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
                resumePayload: typeof row.resume_payload === 'string' ? JSON.parse(row.resume_payload) : row.resume_payload,
                resumedBy: row.resumed_by,
                resumedAt: row.resumed_at ? new Date(row.resumed_at).toISOString() : undefined,
                expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : undefined,
                createdAt: row.created_at ? new Date(row.created_at).getTime() : undefined
            };
        }

        const cpRes = await this.client.query(
            `SELECT state FROM ${this.checkpointsTable} 
             WHERE stack_id = $1 
                OR state->'metadata'->'waitRecord'->>'correlationKey' = $1 
                OR state->'metadata'->'waitRecord'->>'stackId' = $1 LIMIT 1`,
            [correlationKeyOrStackId]
        );
        if (!cpRes.rows || cpRes.rows.length === 0) {
            return undefined;
        }
        const rowState = cpRes.rows[0].state;
        const checkpoint = typeof rowState === 'string' ? JSON.parse(rowState) : rowState;
        return checkpoint?.metadata?.waitRecord;
    }

    async cleanupOldCheckpoints(retentionDays: number = 30): Promise<number> {
        const res = await this.client.query(
            `DELETE FROM ${this.checkpointsTable} WHERE updated_at < NOW() - make_interval(days => $1)`,
            [retentionDays]
        );
        return res.rowCount || 0;
    }

    async cleanupOldEvents(retentionDays: number = 30): Promise<number> {
        const res = await this.client.query(
            `DELETE FROM ${this.eventsTable} WHERE created_at < NOW() - make_interval(days => $1)`,
            [retentionDays]
        );
        return res.rowCount || 0;
    }

    async cleanupOldWaitRecords(retentionDays: number = 30): Promise<number> {
        const res = await this.client.query(
            `DELETE FROM ${this.waitRecordsTable} WHERE updated_at < NOW() - make_interval(days => $1)`,
            [retentionDays]
        );
        return res.rowCount || 0;
    }
}
