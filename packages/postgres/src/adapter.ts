import { StorageAdapter, SerializedExecutionStack } from 'rivulet';
import { PostgresStorageAdapterOptions, PostgresClientInterface } from './types';

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
        this.checkpointsTable = options.checkpointsTable || 'fluid_checkpoints';
        this.eventsTable = options.eventsTable || 'fluid_context_events';
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
