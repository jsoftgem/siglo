import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { parse, subscribe, type GraphQLSchema } from 'graphql';
import { createClient } from 'graphql-ws';
import { WebSocket, WebSocketServer } from 'ws';
import { WorkflowEventEmitter, type SerializedExecutionStack } from '@siglo/core';
import {
    createWorkflowGraphQLSchema,
    createWorkflowQueryEngine,
    createWorkflowSSEResponse,
    createWorkflowSSEStream,
    createWorkflowSubscriptionManager,
    createWorkflowWSHandler,
    formatSSEEvent,
    MemoryStorageAdapter,
    pipeWorkflowSSEToResponse,
    WorkflowSubscriptionManager,
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
        chains: ['step-pay'],
        contexts: {
            'step-pay': { amount: 100, apiKey: 'sk-secret-123' },
        },
        metadata: {
            tenantId: 'acme',
            secretToken: 'secret-token',
        },
        ...overrides,
    };
}

describe('@siglo/query/subscriptions', () => {
    let storage: MemoryStorageAdapter;
    let emitter: WorkflowEventEmitter;
    let engine: ReturnType<typeof createWorkflowQueryEngine>;
    let subManager: WorkflowSubscriptionManager;
    let schema: GraphQLSchema;

    beforeEach(async () => {
        storage = new MemoryStorageAdapter();
        emitter = new WorkflowEventEmitter();
        engine = createWorkflowQueryEngine({
            storage,
            emitter,
            redactFields: ['apiKey', 'secretToken'],
        });
        subManager = engine.getSubscriptionManager();
        schema = createWorkflowGraphQLSchema(engine, { subscriptionManager: subManager });

        await storage.saveCheckpoint(makeCheckpoint('order-101'));
        await storage.saveCheckpoint(makeCheckpoint('order-102'));
        await storage.saveCheckpoint(makeCheckpoint('order-other', { namespace: 'other-tenant' }));
    });

    afterEach(() => {
        subManager.close();
    });

    describe('WorkflowSubscriptionManager', () => {
        it('tracks active subscriptions and decrements on consumer cleanup', async () => {
            const iterator = subManager.subscribeWorkflowUpdated('order-101', 'acme');
            assert.equal(subManager.subscriberCount?.('workflowUpdated'), 1);

            // Cancel / cleanup iterator
            if (typeof (iterator as any).return === 'function') {
                await (iterator as any).return();
            }
            assert.equal(subManager.subscriberCount?.('workflowUpdated'), 0);
        });

        it('dispatches workflowUpdated on WorkflowEventEmitter checkpoint:save event', async () => {
            const iterator = subManager.subscribeWorkflowUpdated('order-101', 'acme');

            // Emit checkpoint:save
            setTimeout(() => {
                emitter.emit({
                    type: 'checkpoint:save',
                    stackId: 'order-101',
                    namespace: 'acme',
                    status: 'running',
                    timestamp: Date.now(),
                });
            }, 10);

            const result = await (iterator as any).next();
            assert.equal(result.done, false);
            assert.equal(result.value.stackId, 'order-101');
            assert.equal(result.value.namespace, 'acme');

            await (iterator as any).return();
        });

        it('dispatches workflowCompleted when flow:complete event occurs', async () => {
            const iterator = subManager.subscribeWorkflowCompleted('acme');

            setTimeout(() => {
                emitter.emit({
                    type: 'flow:complete',
                    stackId: 'order-101',
                    namespace: 'acme',
                    durationMs: 120,
                    status: 'COMPLETED',
                    timestamp: Date.now(),
                });
            }, 10);

            const result = await (iterator as any).next();
            assert.equal(result.done, false);
            assert.equal(result.value.stackId, 'order-101');
            assert.equal(result.value.namespace, 'acme');

            await (iterator as any).return();
        });

        it('supports direct publishing via publishWorkflowUpdated and publishWorkflowCompleted', async () => {
            const updatedIter = subManager.subscribeWorkflowUpdated('order-101', 'acme');
            const completedIter = subManager.subscribeWorkflowCompleted('acme');

            subManager.publishWorkflowUpdated({
                stackId: 'order-101',
                namespace: 'acme',
                status: 'running',
                revision: 2,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            subManager.publishWorkflowCompleted({
                stackId: 'order-101',
                namespace: 'acme',
                status: 'completed',
                revision: 3,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            const updatedRes = await (updatedIter as any).next();
            assert.equal(updatedRes.value.revision, 2);

            const completedRes = await (completedIter as any).next();
            assert.equal(completedRes.value.revision, 3);

            await (updatedIter as any).return();
            await (completedIter as any).return();
        });

        it('strictly isolates tenant namespaces and drops cross-tenant events', async () => {
            const acmeIter = subManager.subscribeWorkflowUpdated('order-101', 'acme');
            let receivedOther = false;

            // Emit event for other namespace
            emitter.emit({
                type: 'checkpoint:save',
                stackId: 'order-101',
                namespace: 'tenant-evil',
                status: 'running',
                timestamp: Date.now(),
            });

            // Emit legitimate event for acme
            setTimeout(() => {
                emitter.emit({
                    type: 'checkpoint:save',
                    stackId: 'order-101',
                    namespace: 'acme',
                    status: 'running',
                    timestamp: Date.now(),
                });
            }, 10);

            const result = await (acmeIter as any).next();
            assert.equal(result.value.namespace, 'acme');
            assert.equal(receivedOther, false);

            await (acmeIter as any).return();
        });

        it('delivers an unscoped completion only to the verified owner', async () => {
            const owner = subManager.subscribeWorkflowCompleted('acme')[Symbol.asyncIterator]();
            const other = subManager.subscribeWorkflowCompleted('other-tenant')[Symbol.asyncIterator]();
            emitter.emit({ type: 'flow:complete', stackId: 'order-101', timestamp: Date.now() });
            assert.equal((await owner.next()).value.stackId, 'order-101');
            subManager.close();
            assert.equal((await other.next()).done, true);
        });

        it('supports multiple concurrent subscribers for the same stackId without cross-talk', async () => {
            const sub1 = subManager.subscribeWorkflowUpdated('order-101', 'acme');
            const sub2 = subManager.subscribeWorkflowUpdated('order-101', 'acme');
            const otherSub = subManager.subscribeWorkflowUpdated('order-102', 'acme');

            let otherReceived = false;
            (async () => {
                for await (const _ of otherSub) {
                    otherReceived = true;
                }
            })();

            setTimeout(() => {
                emitter.emit({
                    type: 'checkpoint:save',
                    stackId: 'order-101',
                    namespace: 'acme',
                    status: 'running',
                    timestamp: Date.now(),
                });
            }, 10);

            const [res1, res2] = await Promise.all([(sub1 as any).next(), (sub2 as any).next()]);

            assert.equal(res1.value.stackId, 'order-101');
            assert.equal(res2.value.stackId, 'order-101');
            assert.equal(otherReceived, false);

            await (sub1 as any).return();
            await (sub2 as any).return();
            await (otherSub as any).return();
        });

        it('removes event listener on emitter when close is called', () => {
            const initialCount = emitter.listenerCount('*');
            assert.ok(initialCount > 0);

            subManager.close();
            assert.equal(emitter.listenerCount('*'), initialCount - 1);
        });
    });

    describe('GraphQL Subscription Execution', () => {
        it('executes workflowUpdated subscription with field projection and redaction', async () => {
            const query = `
                subscription OnWorkflowUpdated($stackId: ID!) {
                    workflowUpdated(stackId: $stackId, namespace: "acme") {
                        stackId
                        namespace
                        status
                        context
                        metadata
                        steps { output }
                    }
                }
            `;

            const subResult = await subscribe({
                schema,
                document: parse(query),
                variableValues: { stackId: 'order-101' },
                contextValue: { namespace: 'acme' },
            });

            assert.equal(Symbol.asyncIterator in subResult, true);
            const iterator = subResult as AsyncIterableIterator<any>;

            // Emit checkpoint:save
            setTimeout(() => {
                emitter.emit({
                    type: 'checkpoint:save',
                    stackId: 'order-101',
                    namespace: 'acme',
                    status: 'running',
                    timestamp: Date.now(),
                });
            }, 15);

            const next = await iterator.next();
            assert.equal(next.done, false);
            assert.equal(next.value.errors, undefined);
            const data = next.value.data.workflowUpdated;
            assert.equal(data.stackId, 'order-101');
            assert.equal(data.namespace, 'acme');
            assert.equal(data.status, 'RUNNING');
            // Context apiKey is redacted
            assert.equal(data.metadata.secretToken, '[REDACTED]');
            assert.equal(data.steps[0].output.apiKey, '[REDACTED]');
            assert.equal(data.context.amount, 100);
            assert.equal(data.context.apiKey, '[REDACTED]');

            await iterator.return?.();
        });

        it('uses namespace from GraphQL context when omitted from subscription arguments', async () => {
            const query = `
                subscription OnWorkflowUpdated($stackId: ID!) {
                    workflowUpdated(stackId: $stackId) {
                        stackId
                        namespace
                    }
                }
            `;

            const subResult = await subscribe({
                schema,
                document: parse(query),
                variableValues: { stackId: 'order-101' },
                contextValue: { namespace: 'acme' },
            });

            assert.equal(Symbol.asyncIterator in subResult, true);
            const iterator = subResult as AsyncIterableIterator<any>;

            setTimeout(() => {
                emitter.emit({
                    type: 'checkpoint:save',
                    stackId: 'order-101',
                    namespace: 'acme',
                    status: 'running',
                    timestamp: Date.now(),
                });
            }, 10);

            const next = await iterator.next();
            assert.equal(next.value.data.workflowUpdated.namespace, 'acme');
            await iterator.return?.();
        });

        it('projects context subfield path and supports unredacted step output', async () => {
            const query = `
                subscription OnWorkflowUpdated($stackId: ID!) {
                    workflowUpdated(stackId: $stackId) {
                        stackId
                        context(path: "amount")
                        steps {
                            stepId
                            output(redact: false)
                        }
                    }
                }
            `;

            const subResult = await subscribe({
                schema,
                document: parse(query),
                variableValues: { stackId: 'order-101' },
                contextValue: { namespace: 'acme' },
            });

            assert.equal(Symbol.asyncIterator in subResult, true);
            const iterator = subResult as AsyncIterableIterator<any>;

            setTimeout(() => {
                emitter.emit({
                    type: 'checkpoint:save',
                    stackId: 'order-101',
                    namespace: 'acme',
                    status: 'running',
                    timestamp: Date.now(),
                });
            }, 10);

            const next = await iterator.next();
            const data = next.value.data.workflowUpdated;
            assert.equal(data.context, 100);
            assert.equal(data.steps[0].output.apiKey, 'sk-secret-123'); // unredacted when explicitly requested

            await iterator.return?.();
        });

        it('executes workflowCompleted subscription within tenant namespace', async () => {
            const query = `
                subscription OnCompleted($namespace: String!) {
                    workflowCompleted(namespace: $namespace) {
                        stackId
                        namespace
                        status
                    }
                }
            `;

            const subResult = await subscribe({
                schema,
                document: parse(query),
                variableValues: { namespace: 'acme' },
                contextValue: { namespace: 'acme' },
            });

            assert.equal(Symbol.asyncIterator in subResult, true);
            const iterator = subResult as AsyncIterableIterator<any>;

            setTimeout(() => {
                emitter.emit({
                    type: 'flow:complete',
                    stackId: 'order-101',
                    namespace: 'acme',
                    durationMs: 250,
                    status: 'COMPLETED',
                    timestamp: Date.now(),
                });
            }, 15);

            const next = await iterator.next();
            assert.equal(next.done, false);
            const data = next.value.data.workflowCompleted;
            assert.equal(data.stackId, 'order-101');
            assert.equal(data.namespace, 'acme');
            assert.equal(data.status, 'COMPLETED');

            await iterator.return?.();
        });

        it('enforces namespace guardrails when requested namespace conflicts with context', async () => {
            const query = `
                subscription OnUpdated {
                    workflowUpdated(stackId: "order-101", namespace: "other-tenant") {
                        stackId
                    }
                }
            `;

            const subResult = await subscribe({
                schema,
                document: parse(query),
                contextValue: { namespace: 'acme' },
            });

            // Single execution result with error
            assert.equal(Symbol.asyncIterator in subResult, false);
            const res = subResult as any;
            assert.ok(res.errors);
            assert.ok(res.errors[0].message.includes('does not match the request context'));
        });

        it('requires a namespace if neither argument nor context provides one', async () => {
            const query = `
                subscription OnUpdated {
                    workflowUpdated(stackId: "order-101") {
                        stackId
                    }
                }
            `;

            const subResult = await subscribe({
                schema,
                document: parse(query),
                contextValue: {},
            });

            assert.equal(Symbol.asyncIterator in subResult, false);
            const res = subResult as any;
            assert.ok(res.errors);
            assert.ok(res.errors[0].message.includes('A workflow namespace is required'));
        });
    });

    describe('Server-Sent Events (SSE) Transport', () => {
        it('formats SSE events with optional id, event, and data', () => {
            const str1 = formatSSEEvent({ data: { message: 'hello' } });
            assert.equal(str1, 'data: {"message":"hello"}\n\n');

            const str2 = formatSSEEvent({ id: '1', event: 'next', data: { value: 42 } });
            assert.equal(str2, 'id: 1\nevent: next\ndata: {"value":42}\n\n');
        });

        it('streams subscription events as SSE chunks and terminates on complete', async () => {
            const query = `
                subscription OnUpdated {
                    workflowUpdated(stackId: "order-101", namespace: "acme") {
                        stackId
                    }
                }
            `;

            const sseStream = createWorkflowSSEStream({
                schema,
                query,
                context: { namespace: 'acme' },
            });

            setTimeout(() => {
                subManager.publishWorkflowUpdated({
                    stackId: 'order-101',
                    namespace: 'acme',
                    status: 'running',
                    revision: 1,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });
                setTimeout(() => {
                    subManager.close();
                }, 15);
            }, 10);

            const chunks: string[] = [];
            for await (const chunk of sseStream) {
                chunks.push(chunk);
            }

            assert.ok(chunks.length >= 2);
            assert.ok(chunks[0].startsWith('event: next\ndata: {"data":{"workflowUpdated":{"stackId":"order-101"}}}'));
            assert.ok(chunks[chunks.length - 1].startsWith('event: complete'));
        });

        it('yields SSE keepalive comments when keepAliveIntervalMs is configured', async () => {
            const query = `
                subscription OnUpdated {
                    workflowUpdated(stackId: "order-101", namespace: "acme") {
                        stackId
                    }
                }
            `;

            const sseStream = createWorkflowSSEStream({
                schema,
                query,
                context: { namespace: 'acme' },
                keepAliveIntervalMs: 15,
            });

            const iterator = sseStream[Symbol.asyncIterator]();
            assert.equal((await iterator.next()).value, ': keepalive\n\n');
            await iterator.return?.();
            assert.equal(subManager.subscriberCount?.(), 0);
        });

        it('yields SSE error event on syntax error or invalid query', async () => {
            const sseStream = createWorkflowSSEStream({
                schema,
                query: `subscription { invalidField }`,
            });

            const chunks: string[] = [];
            for await (const chunk of sseStream) {
                chunks.push(chunk);
            }

            assert.equal(chunks.length, 2);
            assert.ok(chunks[0].includes('event: error'));
            assert.ok(chunks[1].includes('event: complete'));
        });

        it('creates a standard Web Response with text/event-stream headers', async () => {
            async function* sampleStream() {
                yield 'event: next\ndata: {"test":true}\n\n';
            }

            const res = createWorkflowSSEResponse(sampleStream());
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
            assert.equal(res.headers.get('Cache-Control'), 'no-cache, no-transform');
            assert.equal(res.headers.get('Connection'), 'keep-alive');

            const text = await res.text();
            assert.equal(text, 'event: next\ndata: {"test":true}\n\n');
        });

        it('pipes SSE stream to a Node.js ServerResponse and flushes', async () => {
            const written: string[] = [];
            let ended = false;

            const mockRes: any = new EventEmitter();
            mockRes.setHeader = () => {};
            mockRes.write = (chunk: string) => {
                written.push(chunk);
                return true;
            };
            mockRes.end = () => {
                ended = true;
            };

            async function* sampleStream() {
                yield 'event: next\ndata: {"item":1}\n\n';
                yield 'event: complete\ndata: null\n\n';
            }

            pipeWorkflowSSEToResponse(mockRes, sampleStream());

            // Give async loop time to complete
            await new Promise(r => setTimeout(r, 20));

            assert.equal(written.length, 2);
            assert.equal(written[0], 'event: next\ndata: {"item":1}\n\n');
            assert.equal(ended, true);
        });

        it('aborts piping to Node.js ServerResponse when client closes connection', async () => {
            const written: string[] = [];
            let returned = false;

            const mockRes: any = new EventEmitter();
            mockRes.setHeader = () => {};
            mockRes.write = (chunk: string) => {
                written.push(chunk);
                return true;
            };
            mockRes.end = () => {};

            async function* infiniteStream() {
                try {
                    while (true) {
                        yield 'event: next\ndata: 1\n\n';
                        await new Promise(r => setTimeout(r, 20));
                    }
                } finally {
                    returned = true;
                }
            }

            pipeWorkflowSSEToResponse(mockRes, infiniteStream());

            await new Promise(r => setTimeout(r, 30));
            assert.ok(written.length >= 1);

            // Emit close event from client
            mockRes.emit('close');
            await new Promise(r => setTimeout(r, 30));
            assert.equal(returned, true);
        });
    });

    describe('WebSocket Transport (graphql-ws)', () => {
        let server: ReturnType<typeof createServer>;
        let wss: WebSocketServer;
        let port: number;

        beforeEach(done => {
            server = createServer();
            wss = new WebSocketServer({ server });

            createWorkflowWSHandler({
                schema,
                context: () => ({ namespace: 'acme' }),
            })(wss);

            server.listen(0, () => {
                const addr = server.address();
                port = typeof addr === 'object' && addr ? addr.port : 0;
                done();
            });
        });

        afterEach(done => {
            wss.close(() => {
                server.close(done);
            });
        });

        it('rejects connection parameters that conflict with the authenticated tenant', async () => {
            const client = createClient({
                url: `ws://localhost:${port}`,
                webSocketImpl: WebSocket,
                connectionParams: { namespace: 'other-tenant' },
                retryAttempts: 0,
            });
            try {
                const events = client.iterate({
                    query: 'subscription { workflowCompleted(namespace: "other-tenant") { stackId } }',
                });
                await assert.rejects(events.next());
                assert.equal(subManager.subscriberCount?.(), 0);
            } finally {
                await client.dispose();
            }
        });

        it('subscribes over WebSocket protocol and receives workflowUpdated event', done => {
            const client = createClient({
                url: `ws://localhost:${port}`,
                webSocketImpl: WebSocket,
                connectionParams: {
                    namespace: 'acme',
                },
            });

            const query = `
                subscription OnUpdated {
                    workflowUpdated(stackId: "order-101") {
                        stackId
                        status
                    }
                }
            `;

            const unsubscribe = client.subscribe(
                { query },
                {
                    next: val => {
                        try {
                            assert.equal(val.data?.workflowUpdated?.stackId, 'order-101');
                            unsubscribe();
                            client.dispose();
                            done();
                        } catch (err) {
                            done(err);
                        }
                    },
                    error: done,
                    complete: () => {},
                },
            );

            // Emit event to trigger websocket delivery
            setTimeout(() => {
                emitter.emit({
                    type: 'checkpoint:save',
                    stackId: 'order-101',
                    namespace: 'acme',
                    status: 'running',
                    timestamp: Date.now(),
                });
            }, 50);
        });
    });
});
