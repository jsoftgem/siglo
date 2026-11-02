import { StorageAdapter, SerializedExecutionStack } from 'siglo';
import { PostgresStorageAdapterOptions, PostgresClientInterface } from './types';

function validateIdentifier(name: string, paramName: string): string {
    if (!name || typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || name.length > 63) {
        throw new Error(`Invalid SQL identifier for ${paramName}: "${name}". Must be 1-63 alphanumeric characters or underscores, starting with a letter or underscore.`);
    }
    return name;
}

export class PostgresStorageAdapter implements StorageAdapter {
    public readonly name = 'postgres';
    private client: PostgresClientInterface;
    private checkpointsTable: string;
    private eventsTable: string;
    private recordContextChanges: boolean;

    constructor(options: PostgresStorageAdapterOptions) {
        if (!options || !options.client) {
            throw new Error('PostgresStorageAdapter requires a valid Postgres client or pool instance.');
        }
        this.client = options.client;
        this.checkpointsTable = validateIdentifier(options.checkpointsTable || 'siglo_checkpoints', 'checkpointsTable');
        this.eventsTable = validateIdentifier(options.eventsTable || 'siglo_context_events', 'eventsTable');
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
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
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
        `);
    }

    async saveCheckpoint(checkpoint: SerializedExecutionStack): Promise<void> {
        if (!checkpoint || !checkpoint.stackId) {
            return;
        }
        const stateJson = JSON.stringify(checkpoint);
        const namespace = checkpoint.namespace || null;

        await this.client.query(
            `INSERT INTO ${this.checkpointsTable} (stack_id, namespace, state, updated_at)
             VALUES ($1, $2, $3::jsonb, NOW())
             ON CONFLICT (stack_id)
             DO UPDATE SET state = EXCLUDED.state, namespace = EXCLUDED.namespace, updated_at = NOW()`,
            [checkpoint.stackId, namespace, stateJson]
        );
    }

    async getCheckpoint(stackId: string): Promise<SerializedExecutionStack | undefined> {
        if (!stackId) {
            return undefined;
        }
        const res = await this.client.query(
            `SELECT state FROM ${this.checkpointsTable} WHERE stack_id = $1`,
            [stackId]
        );
        if (!res.rows || res.rows.length === 0) {
            return undefined;
        }
        const rowState = res.rows[0].state;
        return typeof rowState === 'string' ? JSON.parse(rowState) : rowState;
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

    async saveWaitRecord(record: any): Promise<void> {
        if (!record || (!record.correlationKey && !record.stackId)) {
            return;
        }
        const stackId = record.stackId;
        if (stackId) {
            const cp = await this.getCheckpoint(stackId);
            if (cp) {
                cp.metadata = { ...(cp.metadata || {}), waitRecord: record };
                await this.saveCheckpoint(cp);
            } else {
                await this.saveCheckpoint({
                    version: 2,
                    schemaVersion: '2.0.0',
                    stackId,
                    namespace: record.namespace,
                    status: record.status || 'waiting',
                    revision: 1,
                    timestamp: Date.now(),
                    metadata: { waitRecord: record },
                    chains: [],
                    contexts: {}
                } as any);
            }
        }
    }

    async getWaitRecord(correlationKeyOrStackId: string): Promise<any | undefined> {
        if (!correlationKeyOrStackId) {
            return undefined;
        }
        const res = await this.client.query(
            `SELECT state FROM ${this.checkpointsTable} 
             WHERE stack_id = $1 
                OR state->'metadata'->'waitRecord'->>'correlationKey' = $1 
                OR state->'metadata'->'waitRecord'->>'stackId' = $1 LIMIT 1`,
            [correlationKeyOrStackId]
        );
        if (!res.rows || res.rows.length === 0) {
            return undefined;
        }
        const rowState = res.rows[0].state;
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
}
