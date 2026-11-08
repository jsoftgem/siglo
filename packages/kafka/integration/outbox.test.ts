import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import ts from 'typescript';

// Execute the published recipe itself so SQL and code examples cannot silently drift.
describe('@siglo/kafka transactional outbox recipe', function () {
    this.timeout(15000);
    it('deduplicates database effects, rolls back incomplete work, and republishes with a stable event ID after an uncertain send', async () => {
        const connectionString =
            process.env.OUTBOX_DATABASE_URL ?? 'postgres://siglo:siglo@localhost:15434/siglo_kafka_test';
        const admin = new Pool({ connectionString });
        const schema = `test_${randomUUID().replaceAll('-', '')}`;
        const doc = readFileSync(join(__dirname, '../docs/outbox.md'), 'utf8');
        const sql = doc.match(/```sql\n([\s\S]*?)```/)![1];
        const snippets = [...doc.matchAll(/```typescript\n([\s\S]*?)```/g)].map(match => match[1]);
        const source = snippets.join('\n') + '\nexport { pool, handler, publishNextOutbox };';
        const compiled = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        let recipe: any;
        const sends: any[] = [];
        let uncertain = true;
        const producer = {
            send: async (payload: any) => {
                sends.push(payload);
                if (uncertain) {
                    uncertain = false;
                    throw new Error('broker reply lost after send');
                }
            },
        };
        try {
            await admin.query(`CREATE SCHEMA ${schema}`);
            const url = new URL(connectionString);
            url.searchParams.set('options', `-c search_path=${schema}`);
            const previous = process.env.DATABASE_URL;
            try {
                process.env.DATABASE_URL = url.toString();
                recipe = {};
                new Function('require', 'exports', 'producer', compiled)(createRequire(__filename), recipe, producer);
            } finally {
                if (previous === undefined) delete process.env.DATABASE_URL;
                else process.env.DATABASE_URL = previous;
            }
            await recipe.pool.query(sql);
            const record = (eventId: string, orderId: string, offset: string) => ({
                topic: 'orders',
                partition: 0,
                message: {
                    value: JSON.stringify({ eventId, tenant: 'tenant-a', orderId }),
                    offset,
                },
            });
            await Promise.all([
                recipe.handler(record('event-1', 'order-1', '0')),
                recipe.handler(record('event-1', 'order-1', '1')),
            ]);
            for (const table of ['processed_order_events', 'accepted_orders', 'order_outbox']) {
                assert.equal((await recipe.pool.query(`SELECT COUNT(*) FROM ${table}`)).rows[0].count, '1');
            }
            await recipe.pool.query(
                "ALTER TABLE order_outbox ADD CONSTRAINT reject_blocked CHECK (payload->>'orderId' <> 'blocked')",
            );
            await assert.rejects(recipe.handler(record('event-2', 'blocked', '2')), /reject_blocked/);
            assert.equal(
                (await recipe.pool.query("SELECT COUNT(*) FROM processed_order_events WHERE event_id = 'event-2'"))
                    .rows[0].count,
                '0',
            );
            assert.equal(
                (await recipe.pool.query("SELECT COUNT(*) FROM accepted_orders WHERE order_id = 'blocked'")).rows[0]
                    .count,
                '0',
            );
            await assert.rejects(recipe.publishNextOutbox(), /broker reply lost/);
            assert.equal((await recipe.pool.query('SELECT published_at FROM order_outbox')).rows[0].published_at, null);
            assert.equal(await recipe.publishNextOutbox(), true);
            assert.equal(await recipe.publishNextOutbox(), false);
            assert.equal(sends.length, 2);
            assert.equal(sends[0].messages[0].key, sends[1].messages[0].key);
            assert.deepEqual(sends[0].messages[0], sends[1].messages[0]);
        } finally {
            await recipe?.pool.end();
            await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
            await admin.end();
        }
    });
});
