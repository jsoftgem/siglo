import { resumeWorkflow, defaultDurableManager } from 'siglo';
import { PostgresPollerOptions, PollerReport, WaitRecord } from './types';

function validateIdentifier(name: string, label: string): string {
    if (!name || typeof name !== 'string') {
        throw new Error(`${label} must be a valid identifier string.`);
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error(`Invalid SQL identifier for ${label}: "${name}". Identifier contains forbidden characters.`);
    }
    return name;
}

export class PostgresWaitPoller {
    private client: PostgresPollerOptions['client'];
    private waitRecordsTable: string;
    private pollIntervalMs: number;
    private batchSize: number;
    private workerId: string;
    private lockTimeoutMs: number;
    private flowLookup?: PostgresPollerOptions['flowLookup'];
    private onResumed?: PostgresPollerOptions['onResumed'];
    private onFailed?: PostgresPollerOptions['onFailed'];
    private timer?: NodeJS.Timeout;
    private running: boolean = false;
    private inFlight: boolean = false;

    constructor(options: PostgresPollerOptions) {
        if (!options || !options.client) {
            throw new Error('PostgresWaitPoller requires a valid PostgreSQL client with a .query() method.');
        }
        this.client = options.client;
        this.waitRecordsTable = validateIdentifier(options.waitRecordsTable || 'siglo_wait_records', 'waitRecordsTable');
        this.pollIntervalMs = options.pollIntervalMs && options.pollIntervalMs > 0 ? options.pollIntervalMs : 1000;
        this.batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : 50;
        this.workerId = options.workerId || `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        this.lockTimeoutMs = options.lockTimeoutMs && options.lockTimeoutMs > 0 ? options.lockTimeoutMs : 60000;
        this.flowLookup = options.flowLookup;
        this.onResumed = options.onResumed;
        this.onFailed = options.onFailed;
    }

    /**
     * Initializes the wait records table and performance indexes if not already present.
     */
    async ensureTable(): Promise<void> {
        await this.client.query(`
            CREATE TABLE IF NOT EXISTS ${this.waitRecordsTable} (
                correlation_key VARCHAR(255) PRIMARY KEY,
                stack_id VARCHAR(255) NOT NULL,
                namespace VARCHAR(255),
                event_name VARCHAR(255),
                status VARCHAR(50) NOT NULL DEFAULT 'WAITING',
                continuation_step_index INT NOT NULL DEFAULT 0,
                version VARCHAR(50),
                data JSONB,
                locked_by VARCHAR(255),
                locked_at TIMESTAMPTZ,
                resumed_by VARCHAR(255),
                resumed_at TIMESTAMPTZ,
                expires_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_${this.waitRecordsTable}_due 
                ON ${this.waitRecordsTable}(status, expires_at);
        `);
    }

    /**
     * Executes a single poll iteration, claiming due wait records with row-level locking
     * and resuming the associated workflows.
     */
    async pollOnce(): Promise<PollerReport> {
        const report: PollerReport = {
            claimed: 0,
            resumed: 0,
            failed: 0
        };

        const lockTimeoutSeconds = Math.max(1, Math.floor(this.lockTimeoutMs / 1000));

        // Atomically claim due records using row-level locking (FOR UPDATE SKIP LOCKED)
        const claimQuery = `
            WITH due_records AS (\n                SELECT correlation_key \n                FROM ${this.waitRecordsTable}\n                WHERE (\n                    status = 'WAITING' \n                    OR (status = 'RESUMING' AND locked_at < NOW() - INTERVAL '${lockTimeoutSeconds} seconds')\n                )\n                AND expires_at IS NOT NULL \n                AND expires_at <= NOW()\n                ORDER BY expires_at ASC\n                LIMIT $1\n                FOR UPDATE SKIP LOCKED\n            )\n            UPDATE ${this.waitRecordsTable} r\n            SET status = 'RESUMING', locked_at = NOW(), locked_by = $2, updated_at = NOW()\n            FROM due_records d\n            WHERE r.correlation_key = d.correlation_key\n            RETURNING r.*;
        `;

        let claimResult: any;
        try {
            claimResult = await this.client.query(claimQuery, [this.batchSize, this.workerId]);
        } catch (queryErr: any) {
            // Fallback for in-memory or simpler mock clients without SKIP LOCKED / CTE
            const fallbackQuery = `
                SELECT * FROM ${this.waitRecordsTable}
                WHERE status = 'WAITING'
                  AND expires_at IS NOT NULL
                  AND expires_at <= NOW()
                LIMIT $1;
            `;
            try {
                claimResult = await this.client.query(fallbackQuery, [this.batchSize]);
                if (claimResult.rows && claimResult.rows.length > 0) {
                    for (const row of claimResult.rows) {
                        await this.client.query(
                            `UPDATE ${this.waitRecordsTable} SET status = 'RESUMING', locked_at = NOW(), locked_by = $1 WHERE correlation_key = $2`,
                            [this.workerId, row.correlation_key]
                        );
                    }
                }
            } catch {
                throw queryErr;
            }
        }

        const rows = claimResult.rows || [];
        report.claimed = rows.length;

        for (const row of rows) {
            const record: WaitRecord = {
                correlationKey: row.correlation_key,
                stackId: row.stack_id,
                namespace: row.namespace,
                eventName: row.event_name,
                status: row.status,
                continuationStepIndex: row.continuation_step_index !== undefined ? Number(row.continuation_step_index) : 0,
                version: row.version,
                data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
                lockedAt: row.locked_at ? new Date(row.locked_at) : undefined,
                lockedBy: row.locked_by,
                resumedAt: row.resumed_at ? new Date(row.resumed_at) : undefined,
                resumedBy: row.resumed_by,
                expiresAt: row.expires_at ? new Date(row.expires_at) : null
            };

            try {
                let targetFlow: any;
                if (this.flowLookup) {
                    targetFlow = this.flowLookup(record.version, record.stackId);
                }

                let result: any;
                if (targetFlow) {
                    if (!defaultDurableManager.getWaitingByStack(record.stackId) && !defaultDurableManager.getWaiting(record.correlationKey)) {
                        defaultDurableManager.registerWait({
                            correlationKey: record.correlationKey,
                            stackId: record.stackId,
                            namespace: record.namespace,
                            eventName: record.eventName || 'timer',
                            continuationStepIndex: record.continuationStepIndex ?? 0,
                            version: record.version,
                            stepId: 'timer',
                            status: 'waiting',
                            createdAt: Date.now(),
                            expiresAt: record.expiresAt ? (record.expiresAt instanceof Date ? record.expiresAt.getTime() : Number(record.expiresAt)) : undefined
                        });
                    }

                    result = await resumeWorkflow(targetFlow, record.stackId, {
                        event: { type: 'timer:expired', timestamp: Date.now() },
                        ...record.data
                    }, { allowExpired: true });
                }

                await this.client.query(
                    `UPDATE ${this.waitRecordsTable} 
                     SET status = 'RESUMED', resumed_at = NOW(), resumed_by = $1, updated_at = NOW() 
                     WHERE correlation_key = $2`,
                    [this.workerId, record.correlationKey]
                );

                if (this.onResumed) {
                    await this.onResumed(record, result);
                }
                report.resumed++;
            } catch (err: any) {
                await this.client.query(
                    `UPDATE ${this.waitRecordsTable} 
                     SET status = 'FAILED', updated_at = NOW() 
                     WHERE correlation_key = $1`,
                    [record.correlationKey]
                );

                if (this.onFailed) {
                    await this.onFailed(record, err);
                }
                report.failed++;
            }
        }

        return report;
    }

    start(): void {
        if (this.running) return;
        this.running = true;

        const loop = async () => {
            if (!this.running) return;
            if (!this.inFlight) {
                this.inFlight = true;
                try {
                    await this.pollOnce();
                } catch {
                    // Swallow transient polling errors to keep daemon running
                } finally {
                    this.inFlight = false;
                }
            }
            if (this.running) {
                this.timer = setTimeout(loop, this.pollIntervalMs);
            }
        };

        this.timer = setTimeout(loop, this.pollIntervalMs);
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        // Wait until currently in-flight poll loop finishes
        while (this.inFlight) {
            await new Promise(r => setTimeout(r, 10));
        }
    }

    isRunning(): boolean {
        return this.running;
    }
}
