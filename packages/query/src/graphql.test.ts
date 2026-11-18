import assert from 'node:assert/strict';
import { graphql, Kind, type GraphQLSchema } from 'graphql';
import type { SerializedExecutionStack } from '@siglo/core';
import {
    createWorkflowGraphQLSchema,
    createWorkflowQueryEngine,
    GraphQLDateTime,
    GraphQLJSON,
    MemoryStorageAdapter,
    WORKFLOW_SCHEMA_SDL,
} from './index';

function makeCheckpoint(stackId: string, overrides: Partial<SerializedExecutionStack> = {}): SerializedExecutionStack {
    return {
        stackId,
        version: 2,
        revision: 1,
        timestamp: new Date('2026-03-01T12:00:00Z').getTime(),
        type: 'execution',
        namespace: 'acme',
        workflowId: 'order-flow',
        chains: ['step-auth', 'step-pay'],
        contexts: {
            'step-auth': { authUser: 'alice', token: 'secret-token-123' },
            'step-pay': { amount: 500, customer: { email: 'alice@example.com', apiKey: 'sk-12345' } },
        },
        metadata: {
            tenantId: 't-1',
            secretKey: 'top-secret',
            waitRecord: {
                correlationKey: 'corr-' + stackId,
                stackId,
                namespace: 'acme',
                eventName: 'payment.confirmed',
                expiresAt: new Date('2026-04-01T00:00:00Z').getTime(),
                lockedBy: 'worker-1',
            },
            compensations: [{ stepId: 'step-pay', stepName: 'refundPayment', status: 'registered' }],
        },
        ...overrides,
    };
}

describe('@siglo/query/graphql', () => {
    let storage: MemoryStorageAdapter;
    let engine: ReturnType<typeof createWorkflowQueryEngine>;
    let schema: GraphQLSchema;

    beforeEach(async () => {
        storage = new MemoryStorageAdapter();
        engine = createWorkflowQueryEngine({
            storage,
            redactFields: ['secretKey', 'token', 'apiKey', 'email'],
        });
        schema = createWorkflowGraphQLSchema(engine);

        // Seed checkpoints
        await storage.saveCheckpoint(makeCheckpoint('order-101'));
        await storage.saveCheckpoint(
            makeCheckpoint('order-102', {
                status: 'waiting',
                timestamp: new Date('2026-03-02T12:00:00Z').getTime(),
            }),
        );
        await storage.saveCheckpoint(
            makeCheckpoint('order-103', {
                status: 'completed',
                timestamp: new Date('2026-03-03T12:00:00Z').getTime(),
            }),
        );
    });

    it('exports standard SDL contract containing Query, Mutation, and Subscription', () => {
        assert.ok(WORKFLOW_SCHEMA_SDL.includes('type Query'));
        assert.ok(WORKFLOW_SCHEMA_SDL.includes('type Mutation'));
        assert.ok(WORKFLOW_SCHEMA_SDL.includes('type Subscription'));
        assert.ok(WORKFLOW_SCHEMA_SDL.includes('scalar JSON'));
        assert.ok(WORKFLOW_SCHEMA_SDL.includes('scalar DateTime'));
    });

    describe('custom scalars', () => {
        it('serializes and parses DateTime scalar', async () => {
            const query = `
                query GetWorkflow($stackId: ID!) {
                    workflow(stackId: $stackId, namespace: "acme") {
                        stackId
                        createdAt
                        updatedAt
                    }
                }
            `;
            const res = await graphql({
                schema,
                contextValue: { namespace: 'acme' },
                source: query,
                variableValues: { stackId: 'order-101' },
            });
            assert.equal(res.errors, undefined);
            const data = (res.data as any)?.workflow;
            assert.equal(data.stackId, 'order-101');
            assert.equal(data.createdAt, '2026-03-01T12:00:00.000Z');
            assert.equal(data.updatedAt, '2026-03-01T12:00:00.000Z');
        });

        it('parses inline DateTime literals (string, int, variable)', () => {
            const dateStr = '2026-05-15T10:00:00.000Z';
            assert.equal(
                GraphQLDateTime.parseLiteral({ kind: Kind.STRING, value: dateStr } as any, {}).toISOString(),
                dateStr,
            );
            const epochMs = 1778839200000;
            assert.equal(
                GraphQLDateTime.parseLiteral({ kind: Kind.INT, value: String(epochMs) } as any, {}).getTime(),
                epochMs,
            );
            assert.equal(
                GraphQLDateTime.parseLiteral({ kind: Kind.VARIABLE, name: { kind: Kind.NAME, value: 'dt' } } as any, {
                    dt: dateStr,
                })?.toISOString(),
                dateStr,
            );
            assert.throws(() => GraphQLDateTime.parseLiteral({ kind: Kind.BOOLEAN, value: true } as any, {}));
            assert.throws(() => GraphQLDateTime.parseLiteral({ kind: Kind.STRING, value: 'invalid-date' } as any, {}));
            assert.throws(() => GraphQLDateTime.serialize('invalid-date'));
            assert.throws(() => GraphQLDateTime.serialize(true as any));
            assert.throws(() => GraphQLDateTime.parseValue('invalid-date'));
            assert.throws(() => GraphQLDateTime.parseValue(true as any));
        });

        it('parses all JSON scalar literal kinds including string, boolean, numbers, objects, arrays, and null', () => {
            // String literal (Kind.STRING)
            assert.equal(
                GraphQLJSON.parseLiteral({ kind: Kind.STRING, value: 'hello string' } as any, {}),
                'hello string',
            );
            // Boolean literal (Kind.BOOLEAN)
            assert.equal(GraphQLJSON.parseLiteral({ kind: Kind.BOOLEAN, value: true } as any, {}), true);
            // Int literal (Kind.INT)
            assert.equal(GraphQLJSON.parseLiteral({ kind: Kind.INT, value: '42' } as any, {}), 42);
            // Float literal (Kind.FLOAT)
            assert.equal(GraphQLJSON.parseLiteral({ kind: Kind.FLOAT, value: '3.14' } as any, {}), 3.14);
            // Null literal (Kind.NULL)
            assert.equal(GraphQLJSON.parseLiteral({ kind: Kind.NULL } as any, {}), null);
            // List literal (Kind.LIST)
            assert.deepEqual(
                GraphQLJSON.parseLiteral(
                    {
                        kind: Kind.LIST,
                        values: [
                            { kind: Kind.STRING, value: 'item1' },
                            { kind: Kind.INT, value: '10' },
                        ],
                    } as any,
                    {},
                ),
                ['item1', 10],
            );
            // Object literal (Kind.OBJECT)
            assert.deepEqual(
                GraphQLJSON.parseLiteral(
                    {
                        kind: Kind.OBJECT,
                        fields: [
                            {
                                kind: Kind.OBJECT_FIELD,
                                name: { kind: Kind.NAME, value: 'key' },
                                value: { kind: Kind.STRING, value: 'val' },
                            },
                        ],
                    } as any,
                    {},
                ),
                { key: 'val' },
            );
            // Variable literal (Kind.VARIABLE)
            assert.equal(
                GraphQLJSON.parseLiteral(
                    { kind: Kind.VARIABLE, name: { kind: Kind.NAME, value: 'customVar' } } as any,
                    { customVar: 'resolved-var' },
                ),
                'resolved-var',
            );
            // Unknown literal
            assert.equal(GraphQLJSON.parseLiteral({ kind: Kind.NAME, value: 'test' } as any, {}), undefined);
        });

        it('serializes and parses JSON scalar in filters and metadata', async () => {
            const query = `
                query GetFilteredWorkflows($filter: WorkflowFilterInput) {
                    workflows(filter: $filter) {
                        totalCount
                        edges {
                            node {
                                stackId
                                metadata
                            }
                        }
                    }
                }
            `;
            const res = await graphql({
                schema,
                contextValue: { namespace: 'acme' },
                source: query,
                variableValues: {
                    filter: {
                        namespace: 'acme',
                        metadata: { tenantId: 't-1' },
                    },
                },
            });
            assert.equal(res.errors, undefined);
            const data = (res.data as any)?.workflows;
            assert.equal(data.totalCount, 3);
            assert.equal(data.edges[0].node.metadata.tenantId, 't-1');
            assert.equal(data.edges[0].node.metadata.secretKey, '[REDACTED]');
        });
    });

    describe('Query.workflow', () => {
        it('retrieves workflow execution by stackId and respects namespace', async () => {
            const query = `
                query {
                    workflow(stackId: "order-101", namespace: "acme") {
                        stackId
                        workflowId
                        namespace
                        status
                        revision
                        waitRecord {
                            correlationKey
                            eventName
                            lockedBy
                        }
                        compensations {
                            stepId
                            stepName
                            status
                        }
                    }
                }
            `;
            const res = await graphql({ schema, source: query, contextValue: { namespace: 'acme' } });
            assert.equal(res.errors, undefined);
            const wf = (res.data as any)?.workflow;
            assert.equal(wf.stackId, 'order-101');
            assert.equal(wf.workflowId, 'order-flow');
            assert.equal(wf.namespace, 'acme');
            assert.equal(wf.status, 'RUNNING');
            assert.equal(wf.revision, 1);
            assert.equal(wf.waitRecord.correlationKey, 'corr-order-101');
            assert.equal(wf.waitRecord.eventName, 'payment.confirmed');
            assert.equal(wf.waitRecord.lockedBy, 'worker-1');
            assert.equal(wf.compensations.length, 1);
            assert.equal(wf.compensations[0].stepId, 'step-pay');
            assert.equal(wf.compensations[0].stepName, 'refundPayment');
            assert.equal(wf.compensations[0].status, 'registered');
        });

        it('returns null when workflow is outside the requested namespace', async () => {
            const query = `
                query {
                    workflow(stackId: "order-101", namespace: "other-tenant") {
                        stackId
                    }
                }
            `;
            const res = await graphql({ schema, source: query, contextValue: { namespace: 'other-tenant' } });
            assert.equal(res.errors, undefined);
            assert.equal((res.data as any)?.workflow, null);
        });

        it('uses namespace from GraphQL context when omitted from arguments', async () => {
            const query = `
                query {
                    workflow(stackId: "order-101") {
                        stackId
                    }
                }
            `;
            const res = await graphql({
                schema,
                source: query,
                contextValue: { namespace: 'acme' },
            });
            assert.equal(res.errors, undefined);
            assert.equal((res.data as any)?.workflow?.stackId, 'order-101');
        });

        it('applies context redaction by default and allows unredacted context when requested', async () => {
            const query = `
                query {
                    workflow(stackId: "order-101", namespace: "acme") {
                        redacted: context
                        unredacted: context(redact: false)
                        specificPath: context(path: "customer.email")
                        unredactedPath: context(path: "customer.email", redact: false)
                    }
                }
            `;
            const res = await graphql({ schema, source: query, contextValue: { namespace: 'acme' } });
            assert.equal(res.errors, undefined);
            const wf = (res.data as any)?.workflow;

            // Redacted by default
            assert.equal(wf.redacted.token, '[REDACTED]');
            assert.equal(wf.redacted.customer.apiKey, '[REDACTED]');
            assert.equal(wf.redacted.customer.email, '[REDACTED]');
            assert.equal(wf.redacted.authUser, 'alice');
            assert.equal(wf.redacted.amount, 500);

            // Unredacted when redact: false
            assert.equal(wf.unredacted.token, 'secret-token-123');
            assert.equal(wf.unredacted.customer.apiKey, 'sk-12345');
            assert.equal(wf.unredacted.customer.email, 'alice@example.com');

            // Subpaths
            assert.equal(wf.specificPath, '[REDACTED]');
            assert.equal(wf.unredactedPath, 'alice@example.com');
        });

        it('projects steps breakdown with outputs', async () => {
            const query = `
                query {
                    workflow(stackId: "order-101", namespace: "acme") {
                        steps {
                            stepId
                            name
                            status
                            output
                            unredacted: output(redact: false)
                        }
                    }
                }
            `;
            const res = await graphql({ schema, source: query, contextValue: { namespace: 'acme' } });
            assert.equal(res.errors, undefined);
            const steps = (res.data as any)?.workflow?.steps;
            assert.equal(steps.length, 2);

            assert.equal(steps[0].stepId, 'step-auth');
            assert.equal(steps[0].output.token, '[REDACTED]');
            assert.equal(steps[0].unredacted.token, 'secret-token-123');

            assert.equal(steps[1].stepId, 'step-pay');
            assert.equal(steps[1].output.amount, 500);
            assert.equal(steps[1].output.customer.apiKey, '[REDACTED]');
            assert.equal(steps[1].unredacted.customer.apiKey, 'sk-12345');
        });
    });

    describe('Query.workflows (listing, pagination, filtering)', () => {
        it('supports cursor pagination with edges, nodes, and pageInfo', async () => {
            const query = `
                query ListWorkflows($limit: Int, $cursor: String) {
                    workflows(
                        filter: { namespace: "acme" }
                        sort: { field: CREATED_AT, direction: ASC }
                        pagination: { limit: $limit, cursor: $cursor }
                    ) {
                        totalCount
                        pageInfo {
                            hasNextPage
                            hasPreviousPage
                            startCursor
                            endCursor
                        }
                        edges {
                            cursor
                            node {
                                stackId
                                status
                            }
                        }
                    }
                }
            `;
            // Page 1
            const p1 = await graphql({
                schema,
                contextValue: { namespace: 'acme' },
                source: query,
                variableValues: { limit: 2 },
            });
            assert.equal(p1.errors, undefined);
            const d1 = (p1.data as any)?.workflows;
            assert.equal(d1.totalCount, 3);
            assert.equal(d1.edges.length, 2);
            assert.equal(d1.edges[0].node.stackId, 'order-101');
            assert.equal(d1.edges[1].node.stackId, 'order-102');
            assert.equal(d1.pageInfo.hasNextPage, true);
            assert.equal(d1.pageInfo.hasPreviousPage, false);

            // Page 2 using endCursor
            const p2 = await graphql({
                schema,
                contextValue: { namespace: 'acme' },
                source: query,
                variableValues: { limit: 2, cursor: d1.pageInfo.endCursor },
            });
            assert.equal(p2.errors, undefined);
            const d2 = (p2.data as any)?.workflows;
            assert.equal(d2.edges.length, 1);
            assert.equal(d2.edges[0].node.stackId, 'order-103');
            assert.equal(d2.pageInfo.hasNextPage, false);
            assert.equal(d2.pageInfo.hasPreviousPage, true);
        });

        it('filters by status enum and correlationKey', async () => {
            const query = `
                query {
                    byStatus: workflows(
                        filter: { namespace: "acme", status: WAITING }
                    ) {
                        totalCount
                        edges { node { stackId status } }
                    }
                    byCorr: workflows(
                        filter: { namespace: "acme", correlationKey: "corr-order-102" }
                    ) {
                        totalCount
                        edges { node { stackId } }
                    }
                }
            `;
            const res = await graphql({ schema, source: query, contextValue: { namespace: 'acme' } });
            assert.equal(res.errors, undefined);
            const data = res.data as any;
            assert.equal(data.byStatus.totalCount, 1);
            assert.equal(data.byStatus.edges[0].node.stackId, 'order-102');
            assert.equal(data.byStatus.edges[0].node.status, 'WAITING');

            assert.equal(data.byCorr.totalCount, 1);
            assert.equal(data.byCorr.edges[0].node.stackId, 'order-102');
        });

        it('skips context loading when context and steps are not requested in AST', async () => {
            const nativeCp = makeCheckpoint('native-test');
            let contextRead = false;
            Object.defineProperty(nativeCp, 'contexts', {
                get() {
                    contextRead = true;
                    throw new Error('Unexpected context access in zero-cost projection');
                },
            });

            const customStorage: any = {
                name: 'custom-projection',
                async queryWorkflows(opts: any) {
                    assert.equal(opts.includeContext, false);
                    return { checkpoints: [nativeCp], totalCount: 1, hasNextPage: false };
                },
                async getCheckpoint() {
                    return nativeCp;
                },
            };

            const customEngine = createWorkflowQueryEngine({ storage: customStorage });
            const customSchema = createWorkflowGraphQLSchema(customEngine);

            const query = `
                query {
                    workflows(filter: { namespace: "acme" }) {
                        totalCount
                        edges {
                            node {
                                stackId
                                status
                                revision
                            }
                        }
                    }
                }
            `;
            const res = await graphql({ schema: customSchema, source: query, contextValue: { namespace: 'acme' } });
            assert.equal(res.errors, undefined);
            assert.equal(contextRead, false);
            assert.equal((res.data as any)?.workflows?.edges[0].node.stackId, 'native-test');
        });
    });

    describe('Mutations', () => {
        it('rejects missing scope, conflicting scope, and missing runtime before resuming', async () => {
            const resumeMutation = `
                mutation {
                    resumeWorkflow(
                        correlationKey: "corr-order-102"
                        payload: { paymentRef: "pay_xyz999" }
                        namespace: "acme"
                    )
                }
            `;
            for (const [namespace, expected] of [
                [undefined, /namespace/],
                ['other', /namespace/],
                ['acme', /runtime|resolver/],
            ] as const) {
                const res = await graphql({ schema, source: resumeMutation, contextValue: { namespace } });
                assert.match(res.errors?.[0].message ?? '', expected);
            }
            assert.equal((await engine.findById('order-102', { namespace: 'acme' }))?.status, 'waiting');
        });

        it('cancelWorkflow cancels active or waiting workflow execution', async () => {
            const cancelMutation = `
                mutation {
                    cancelWorkflow(
                        stackId: "order-101"
                        reason: "Customer requested cancellation"
                    )
                }
            `;
            const denied = await graphql({ schema, source: cancelMutation });
            assert.match(denied.errors?.[0].message ?? '', /namespace/);
            assert.equal((await engine.findById('order-101', { namespace: 'acme' }))?.status, 'running');
            const res = await graphql({
                schema,
                source: cancelMutation,
                contextValue: { namespace: 'acme' },
            });
            assert.equal(res.errors, undefined);
            assert.equal((res.data as any)?.cancelWorkflow, true);

            const cancelled = await engine.findById('order-101', { namespace: 'acme' });
            assert.equal(cancelled?.status, 'cancelled');
        });
    });
});
