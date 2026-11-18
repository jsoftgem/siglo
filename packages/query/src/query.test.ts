import assert from 'node:assert/strict';
import { StorageManager, type SerializedExecutionStack } from '@siglo/core';
import { createWorkflowQueryEngine, MemoryStorageAdapter } from './index';

const filter = { namespace: 'shop' };
function checkpoint(stackId: string, overrides: Partial<SerializedExecutionStack> = {}): SerializedExecutionStack {
    return {
        stackId,
        version: 2,
        revision: 1,
        timestamp: 100,
        type: 'execution',
        namespace: 'shop',
        workflowId: 'order',
        chains: ['a', 'b'],
        contexts: { b: { customer: [{ password: 'pw', email: 'foo' }] }, a: { customer: 'old', order: 1 } },
        metadata: { token: 'private', sku: 123 },
        ...overrides,
    };
}

describe('@siglo/query', () => {
    const storage = new MemoryStorageAdapter();
    const engine = createWorkflowQueryEngine({ storage, redactFields: ['email'] });

    it('reads checkpoints saved through core and scopes ID lookup', async () => {
        const manager = new StorageManager();
        manager.useStorage(storage);
        manager.createStack('from-core', 'shop');
        manager.checkpoint('from-core', { metadata: { steps: [() => true] } });
        assert.equal((await engine.findById('from-core', filter))?.revision, 1);
        assert.equal(await engine.findById('from-core', { namespace: 'other' }), undefined);
        assert.equal(await engine.findById('missing', filter), undefined);
    });

    it('merges in chain order, redacts nested arrays and selects own paths without changing storage', async () => {
        await storage.saveCheckpoint(checkpoint('projection'));
        const item = await engine.findById('projection', filter);
        assert.doesNotMatch(JSON.stringify(item), /"(pw|foo|private)"/);
        assert.deepEqual(item?.context, { order: 1, customer: [{ password: '[REDACTED]', email: '[REDACTED]' }] });
        assert.equal(item?.metadata?.token, '[REDACTED]');
        const byPath = (contextPath: string, redact = true) =>
            engine.findById('projection', { ...filter, contextPath, redact });
        assert.equal((await byPath('customer.0.password'))?.context, '[REDACTED]');
        assert.equal((await byPath('customer.0.password', false))?.context, 'pw');
        assert.equal((await byPath('constructor'))?.context, undefined);
    });

    it('paginates filtered stacks deterministically across revisions and tenants', async () => {
        const adapter = new MemoryStorageAdapter();
        const query = createWorkflowQueryEngine({ storage: adapter });
        for (const id of ['z', 'a', 'b']) await adapter.saveCheckpoint(checkpoint(id));
        await adapter.saveCheckpoint(checkpoint('a', { revision: 2, timestamp: 200 }));
        await adapter.saveCheckpoint(checkpoint('other', { namespace: 'elsewhere' }));
        const options = {
            filter: {
                ...filter,
                workflowId: 'order',
                status: 'running' as const,
                metadata: { sku: 123 },
                createdAfter: new Date(99),
                createdBefore: new Date(101),
            },
        };
        const first = await query.findMany({ ...options, pagination: { limit: 2 } });
        assert.deepEqual(
            first.items.map(item => item.stackId),
            ['a', 'b'],
        );
        assert.equal(first.items[0].updatedAt.getTime(), 200);
        assert.equal(first.items[0].createdAt.getTime(), 100);
        assert.equal(first.totalCount, 3);
        assert.equal(first.pageInfo.hasNextPage, true);
        const second = await query.findMany({ ...options, pagination: { cursor: first.pageInfo.endCursor } });
        assert.deepEqual(
            second.items.map(item => item.stackId),
            ['z'],
        );
        assert.equal(second.pageInfo.hasNextPage, false);
        assert.equal(second.pageInfo.hasPreviousPage, true);
        const end = await query.findMany({ ...options, pagination: { cursor: second.pageInfo.endCursor } });
        assert.deepEqual(end.items, []);
        assert.equal(end.pageInfo.startCursor, undefined);
        await assert.rejects(query.findMany({ ...options, pagination: { cursor: 'bad' } }), /cursor/);
        await assert.rejects(
            query.findMany({
                ...options,
                sort: { field: 'revision' },
                pagination: { cursor: first.pageInfo.startCursor },
            }),
            /cursor/,
        );
        await assert.rejects(query.findMany({ filter: { namespace: '' } }), /namespace/);
    });

    it('matches the checkpoint wait record only within its namespace', async () => {
        for (const namespace of ['one', 'two']) {
            await storage.saveCheckpoint(
                checkpoint(namespace, {
                    namespace,
                    metadata: { waitRecord: { correlationKey: 'shared', stackId: namespace, namespace } },
                }),
            );
        }
        const page = await engine.findMany({ filter: { namespace: 'two', correlationKey: 'shared' } });
        assert.deepEqual(
            page.items.map(item => item.stackId),
            ['two'],
        );
        assert.equal(page.totalCount, 1);
    });

    it('forwards projection to native storage and skips context on summary reads', async () => {
        const cp = checkpoint('native');
        Object.defineProperty(cp, 'contexts', {
            get() {
                throw new Error('unexpected context read');
            },
        });
        const query = createWorkflowQueryEngine({
            storage: {
                name: 'native',
                async queryWorkflows(options) {
                    assert.equal(options.includeContext, false);
                    assert.deepEqual(options.filter, filter);
                    return { checkpoints: [cp], totalCount: 1, hasNextPage: false };
                },
            },
        });
        assert.equal(Object.hasOwn((await query.findMany({ filter })).items[0], 'context'), false);
        cp.namespace = 'other';
        await assert.rejects(query.findMany({ filter }), /namespace/);
        await assert.rejects(query.findById('native', filter), /lookup/);
        await assert.rejects(createWorkflowQueryEngine({ storage: { name: 'basic' } }).findMany({ filter }), /listing/);
    });
});
