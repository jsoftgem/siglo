const { Pool } = require('pg');
const { flow, Step, useStorage, waitForEvent } = require('@siglo/core');
const { PostgresStorageAdapter } = require('@siglo/postgres');
const {
    handleNotificationCallback,
    configureApprovalRevocationStore,
    PostgresApprovalRevocationStore,
} = require('../dist');
const { PostgresWaitPoller } = require('@siglo/scheduler');
(async () => {
    const pool = new Pool({ connectionString: process.env.SIGLO_TEST_POSTGRES_URL });
    try {
        const adapter = new PostgresStorageAdapter({ client: pool, recordContextChanges: false });
        if (process.env.WORKER_MODE === 'crash') {
            const claim = adapter.claimWaitRecord.bind(adapter);
            adapter.claimWaitRecord = async (...args) => {
                await claim(...args);
                process.exit(73);
            };
        }
        useStorage(adapter);
        configureApprovalRevocationStore(new PostgresApprovalRevocationStore(pool));
        const workflow = flow(
            waitForEvent('DONE', { correlationKey: process.env.REQUEST_KEY }),
            new Step('effect', async ctx => {
                await pool.query(
                    'INSERT INTO notification_test_effects (request_key, approved, event_type) VALUES ($1, $2, $3)',
                    [process.env.REQUEST_KEY, ctx.approved ?? null, ctx.event?.type ?? null],
                );
                return { approved: ctx.approved };
            }),
        );
        if (process.env.WORKER_MODE === 'timeout') {
            const poller = new PostgresWaitPoller({
                client: pool,
                flowLookup: (_version, stackId) => (stackId === process.env.REQUEST_KEY ? workflow : undefined),
            });
            const result = await poller.pollOnce();
            process.stdout.write(JSON.stringify(result));
        } else {
            const result = await handleNotificationCallback(process.env.ACTION_TOKEN, {
                workflow,
                allowBearerApproval: true,
                signingSecret: 'test-secret',
            });
            process.stdout.write(JSON.stringify(result));
        }
    } finally {
        await pool.end();
    }
})().catch(error => {
    process.stderr.write(String(error.stack));
    process.exitCode = 1;
});
