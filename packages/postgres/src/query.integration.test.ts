import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defaultStorageManager, flow, Step, useStorage, waitForEvent } from '@siglo/core';
import type { Client } from 'pg';
import { graphql } from 'graphql';
import { createWorkflowGraphQLSchema, createWorkflowQueryEngine } from '@siglo/query';
import { PostgresStorageAdapter } from './adapter';

const connectionString = process.env.SIGLO_TEST_POSTGRES_URL;
(connectionString ? describe : describe.skip)('Postgres workflow listing', function () {
    this.timeout(30000);
    const table = 'checkpoints';
    let db: Client;
    let adapter: PostgresStorageAdapter;
    let engine: ReturnType<typeof createWorkflowQueryEngine>;
    let lastSql: string;
    let lastArgs: unknown[];
    before(async () => {
        const { Client } = await import('pg');
        db = new Client({ connectionString });
        await db.connect();
        await db.query('BEGIN');
        const schema = 'query_' + randomUUID().replaceAll('-', '');
        await db.query('CREATE SCHEMA ' + schema);
        await db.query('SET LOCAL search_path TO ' + schema);
        let pending = Promise.resolve();
        adapter = new PostgresStorageAdapter({
            checkpointsTable: table,
            client: {
                query(sql, args) {
                    lastSql = sql;
                    lastArgs = args ?? [];
                    const result = pending.then(() => db.query(sql, args));
                    pending = result.then(
                        () => {},
                        () => {},
                    );
                    return result;
                },
            },
        });
        engine = createWorkflowQueryEngine({ storage: adapter });
        // Pre-migration checkpoints have no query indexes and may lack an explicit status.
        await db.query(`CREATE TABLE checkpoints (
            stack_id varchar(255) PRIMARY KEY, namespace varchar(255), state jsonb NOT NULL,
            version bigint NOT NULL DEFAULT 1, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
        await db.query(`INSERT INTO checkpoints (stack_id, namespace, created_at, state)
            SELECT i::text, 'tenant' || (i % 100), '2025-01-01'::timestamptz + (i % 2) * interval '1 day',
                jsonb_build_object('timestamp', i, 'version', 2, 'type', 'execution', 'workflowId', 'orders',
                    'chains', jsonb_build_array('a'), 'contexts', '{"a":{"token":"private"}}'::jsonb,
                    'metadata', jsonb_build_object('order', jsonb_build_object('id', i, 'kind', 'order'),
                        'waitRecord', jsonb_build_object('correlationKey', 'wait', 'stackId', i::text,
                            'namespace', CASE WHEN i = 100 THEN 'tenant0' ELSE 'other' END)))
            FROM generate_series(1, 10100) i`);
        await adapter.ensureTables();
        const indexes = () =>
            db.query('SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() ORDER BY indexname');
        const first = await indexes();
        await adapter.ensureTables();
        assert.deepEqual((await indexes()).rows, first.rows);
        await db.query('ANALYZE checkpoints');
    });
    after(async () => {
        if (db) {
            await db.query('ROLLBACK');
            await db.end();
        }
    });
    const filter = { namespace: 'tenant0' };
    it('pages through ties in both directions and retains the count past the last cursor', async () => {
        for (const direction of ['asc', 'desc'] as const) {
            const ids: string[] = [];
            let cursor: string | undefined;
            for (;;) {
                const page = await engine.findMany({ filter, sort: { direction }, pagination: { limit: 24, cursor } });
                assert.equal(page.totalCount, 101);
                if (!page.items.length) break;
                assert.equal(page.items[0].namespace, filter.namespace);
                assert.ok(!lastSql.includes("state->'contexts'"));
                ids.push(...page.items.map(item => item.stackId));
                assert.equal(page.pageInfo.hasNextPage, ids.length < 101);
                cursor = page.pageInfo.endCursor;
                assert.ok(ids.length <= 101);
            }
            assert.deepEqual(ids, Array.from({ length: 101 }, (_, i) => String((i + 1) * 100)).sort());
        }
    });
    it('filters exact metadata, scoped waits and exclusive dates, and preserves creation time on revision', async () => {
        const options = { ...filter, workflowId: 'orders', status: 'running' as const, correlationKey: 'wait' };
        const page = await engine.findMany({ filter: options });
        assert.deepEqual(
            page.items.map(item => item.stackId),
            ['100'],
        );
        const created = page.items[0].createdAt;
        for (const boundary of ['createdAfter', 'createdBefore']) {
            assert.equal((await engine.findMany({ filter: { ...options, [boundary]: created } })).totalCount, 0);
        }
        assert.equal(
            (await engine.findMany({ filter: { ...filter, metadata: { order: { id: 100 } } } })).totalCount,
            0,
        );
        await adapter.saveCheckpoint({
            stackId: '100',
            namespace: filter.namespace,
            version: 2,
            type: 'execution',
            revision: 1,
            timestamp: 123,
            chains: ['a'],
            contexts: { a: { token: 'private' } },
            metadata: { order: { id: 100, kind: 'order' } },
        });
        const revised = (await engine.findMany({ filter, sort: { field: 'revision', direction: 'desc' } })).items[0];
        assert.equal(revised.revision, 2);
        assert.equal(revised.updatedAt.getTime(), 123);
        assert.deepEqual(revised.createdAt, created);
        assert.deepEqual((await engine.findById('100', filter))?.createdAt, created);
    });
    it('projects GraphQL context and uses indexes on selective queries', async () => {
        const schema = createWorkflowGraphQLSchema(engine);
        const source = (
            fields: string,
        ) => `{ workflows(filter:{namespace:"tenant0",metadata:{order:{id:100,kind:"order"}}}) {
            edges { node { stackId ${fields} } } } }`;
        const forbidden = await graphql({ schema, source: source(''), contextValue: { namespace: 'tenant1' } });
        assert.match(forbidden.errors?.[0].message ?? '', /namespace/);
        for (const fields of ['', 'context']) {
            const res = await graphql({ schema, source: source(fields), contextValue: { namespace: 'tenant0' } });
            assert.equal(res.errors, undefined);
            const node = (res.data as any).workflows.edges[0].node;
            assert.equal(node.stackId, '100');
            if (fields) assert.deepEqual(node.context, { token: '[REDACTED]' });
            assert.equal(lastSql.includes("state->'contexts'"), Boolean(fields));
        }
        for (const [name, metadata] of [
            ['metadata', { order: { id: 100, kind: 'order' } }],
            ['created', undefined],
        ] as const) {
            await engine.findMany({ filter: { ...filter, metadata }, pagination: { limit: 1 } });
            const plan = (await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + lastSql, lastArgs)).rows[0][
                'QUERY PLAN'
            ][0];
            assert.ok(JSON.stringify(plan.Plan).includes('idx_query_' + name), JSON.stringify(plan.Plan));
            console.log(`10,100 checkpoints, ${name} index: ${plan['Execution Time']} ms`);
        }
    });
    it('claims only the owning tenant’s wait and executes the continuation once', async () => {
        const previous = defaultStorageManager.getAdapter();
        useStorage(adapter);
        const key = randomUUID();
        let calls = 0;
        const workflow = flow(
            waitForEvent('approved', { correlationKey: key }),
            Step.create('receipt', () => ({ receipt: ++calls })),
        );
        const query = createWorkflowQueryEngine({ storage: adapter, resolveWorkflow: () => workflow });
        try {
            const waiting = (await workflow.run({}, { durable: true, namespace: 'owner' })) as any;
            assert.equal(await query.resumeWorkflow(key, {}, 'other'), false);
            await assert.rejects(
                adapter.claimWaitRecord(key, 'other-worker', { namespace: 'other', eventPayload: { wrong: true } }),
            );
            const untouched = await adapter.getWaitRecord(key);
            assert.equal(untouched.status, 'WAITING');
            assert.equal(untouched.resumePayload, null);
            assert.equal(await query.resumeWorkflow(key, { approved: true }, 'owner'), true);
            assert.equal((await query.findById(waiting.stackId, { namespace: 'owner' }))?.status, 'completed');
            assert.equal(await query.resumeWorkflow(key, {}, 'owner'), false);
            assert.equal(calls, 1);
        } finally {
            query.getSubscriptionManager().close();
            useStorage(previous!);
        }
    });
});
