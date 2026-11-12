import { flow, Step, waitForEvent } from '@siglo/core';

/** External effects use a durable idempotency key because a crash can precede checkpointing. */
export function createRecoveryWorkflow(
    client: { query: (sql: string, values?: any[]) => Promise<any> },
    table: string,
    key: string,
    interrupt?: () => Promise<void>,
) {
    return flow(
        Step.create('prepare', async () => ({ requestId: key })),
        waitForEvent('APPROVED', { correlationKey: key, timeout: '1h' }),
        Step.create('effect', async (ctx: any) => {
            const approved = typeof ctx.approved === 'function' ? ctx.approved() : ctx.approved;
            await client.query(`INSERT INTO ${table} (request_id, approved) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
                key,
                approved,
            ]);
            if (interrupt) await interrupt();
            return { done: true };
        }),
    );
}
