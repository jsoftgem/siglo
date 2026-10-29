import { IdempotencyStore } from 'siglo';
import { PostgresIdempotencyOptions, PostgresClientInterface } from './types';

function validateIdentifier(name: string, paramName: string = 'tableName'): string {
    if (!name || typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || name.length > 63) {
        throw new Error(`Invalid SQL identifier for ${paramName}: "${name}". Must be 1-63 alphanumeric characters or underscores, starting with a letter or underscore.`);
    }
    return name;
}

export class PostgresIdempotencyStore implements IdempotencyStore {
    private client: PostgresClientInterface;
    private tableName: string;
    private defaultTtlMs: number;

    constructor(options: PostgresIdempotencyOptions) {
        if (!options || !options.client) {
            throw new Error('PostgresIdempotencyStore requires a valid Postgres client or pool instance.');
        }
        this.client = options.client;
        this.tableName = validateIdentifier(options.tableName || 'siglo_idempotency', 'tableName');
        this.defaultTtlMs = options.defaultTtlMs || 86400000; // 24 hours
    }

    async ensureTable(): Promise<void> {
        await this.client.query(`
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                key VARCHAR(512) PRIMARY KEY,
                status VARCHAR(50) NOT NULL,
                result JSONB,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_${this.tableName}_expires ON ${this.tableName}(expires_at);
        `);
    }

    async claim(key: string, ttlMs?: number): Promise<'claimed' | 'completed' | 'in-progress'> {
        const effectiveTtl = ttlMs || this.defaultTtlMs;
        const now = Date.now();
        const expiresAt = new Date(now + effectiveTtl);

        // Attempt initial insert
        const insertRes = await this.client.query(
            `INSERT INTO ${this.tableName} (key, status, expires_at, created_at)
             VALUES ($1, 'in-progress', $2, NOW())
             ON CONFLICT (key) DO NOTHING`,
            [key, expiresAt]
        );

        if ((insertRes.rowCount || 0) > 0) {
            return 'claimed';
        }

        // Key exists, inspect current status and expiration
        const selectRes = await this.client.query(
            `SELECT status, result, expires_at FROM ${this.tableName} WHERE key = $1`,
            [key]
        );

        if (!selectRes.rows || selectRes.rows.length === 0) {
            return 'claimed';
        }

        const row = selectRes.rows[0];
        const rowExpiresAt = new Date(row.expires_at).getTime();

        // If previous claim expired, reclaim it
        if (rowExpiresAt <= now) {
            const updateRes = await this.client.query(
                `UPDATE ${this.tableName}
                 SET status = 'in-progress', expires_at = $2, result = NULL
                 WHERE key = $1 AND expires_at <= NOW()`,
                [key, expiresAt]
            );
            if ((updateRes.rowCount || 0) > 0) {
                return 'claimed';
            }
        }

        if (row.status === 'completed') {
            return 'completed';
        }

        return 'in-progress';
    }

    async complete(key: string, result: unknown, ttlMs?: number): Promise<void> {
        const effectiveTtl = ttlMs || this.defaultTtlMs;
        const expiresAt = new Date(Date.now() + effectiveTtl);
        const resultJson = JSON.stringify(result ?? null);

        await this.client.query(
            `UPDATE ${this.tableName}
             SET status = 'completed', result = $2::jsonb, expires_at = $3
             WHERE key = $1`,
            [key, resultJson, expiresAt]
        );
    }

    async fail(key: string, _error: unknown): Promise<void> {
        // Clear in-flight claim to permit retry
        await this.client.query(
            `DELETE FROM ${this.tableName} WHERE key = $1 AND status = 'in-progress'`,
            [key]
        );
    }

    async getResult(key: string): Promise<unknown | undefined> {
        const res = await this.client.query(
            `SELECT result FROM ${this.tableName} WHERE key = $1 AND status = 'completed'`,
            [key]
        );
        if (!res.rows || res.rows.length === 0) {
            return undefined;
        }
        const resData = res.rows[0].result;
        return typeof resData === 'string' ? JSON.parse(resData) : resData;
    }

    async cleanupExpired(): Promise<number> {
        const res = await this.client.query(
            `DELETE FROM ${this.tableName} WHERE expires_at < NOW()`
        );
        return res.rowCount || 0;
    }
}
