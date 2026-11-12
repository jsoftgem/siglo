import { Pool } from 'pg';
import { useStorage, resumeWorkflow } from '@siglo/core';
import { PostgresStorageAdapter } from '@siglo/postgres';
import { createRecoveryWorkflow } from './recovery-workflow';

async function main() {
    const config = JSON.parse(process.env.SIGLO_RECOVERY_CASE!);
    const pool = new Pool({ connectionString: process.env.SIGLO_TEST_POSTGRES_URL, connectionTimeoutMillis: 5000 });
    try {
        useStorage(new PostgresStorageAdapter({ client: pool, ...config.tables, recordContextChanges: false }));
        const workflow = createRecoveryWorkflow(pool, config.effects, config.key, async () => {
            process.send?.({ type: 'effect' });
            await new Promise(() => {});
        });
        await resumeWorkflow(workflow, config.key, { approved: true }, { pojo: true });
        throw new Error('Crash barrier was not reached');
    } finally {
        await pool.end();
    }
}
main().catch(() => {
    process.send?.({ type: 'error' });
    process.exit(1);
});
