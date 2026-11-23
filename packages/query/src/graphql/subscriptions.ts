import { defaultWorkflowEventEmitter, type WorkflowEventEmitter, type WorkflowExecutionEvent } from '@siglo/core';
import type { WorkflowQueryEngine } from '../engine';
import type { WorkflowExecution, WorkflowStatus } from '../types';

export class AsyncPushQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
    private readonly queue: T[] = [];
    private readonly resolvers: Array<(result: IteratorResult<T>) => void> = [];
    private closed = false;
    private onDispose?: () => void;

    constructor(onDispose?: () => void) {
        this.onDispose = onDispose;
    }

    push(item: T): void {
        if (this.closed) return;
        const nextResolve = this.resolvers.shift();
        if (nextResolve) {
            nextResolve({ value: item, done: false });
        } else {
            this.queue.push(item);
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        while (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift()!;
            resolve({ value: undefined as unknown as T, done: true });
        }
        this.onDispose?.();
        this.onDispose = undefined;
    }

    next(): Promise<IteratorResult<T>> {
        if (this.queue.length > 0) {
            return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.closed) {
            return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>(resolve => {
            this.resolvers.push(resolve);
        });
    }

    return(): Promise<IteratorResult<T>> {
        this.close();
        return Promise.resolve({ value: undefined as unknown as T, done: true });
    }

    throw(err?: unknown): Promise<IteratorResult<T>> {
        this.close();
        return Promise.reject(err);
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
        return this;
    }
}

export interface WorkflowSubscriptionManager {
    publishWorkflowUpdated(execution: WorkflowExecution): void;
    publishWorkflowCompleted(execution: WorkflowExecution): void;
    subscribeWorkflowUpdated(stackId: string, namespace: string): AsyncIterable<WorkflowExecution>;
    subscribeWorkflowCompleted(namespace: string): AsyncIterable<WorkflowExecution>;
    subscriberCount?(type?: 'workflowUpdated' | 'workflowCompleted'): number;
    close(): void;
}

export interface WorkflowSubscriptionManagerOptions {
    engine?: WorkflowQueryEngine;
    emitter?: WorkflowEventEmitter;
}

interface SubscriptionRegistration {
    type: 'workflowUpdated' | 'workflowCompleted';
    namespace: string;
    stackId?: string;
    queue: AsyncPushQueue<WorkflowExecution>;
}

function mapEventToStatus(event: WorkflowExecutionEvent): WorkflowStatus {
    switch (event.type) {
        case 'flow:complete':
            return event.status === 'FAILED' ? 'failed' : 'completed';
        case 'flow:error':
            return 'failed';
        case 'flow:suspended':
            return 'waiting';
        case 'flow:resumed':
            return 'running';
        case 'checkpoint:save':
            if (event.status) {
                const s = event.status.toLowerCase();
                if (s === 'completed' || s === 'failed' || s === 'cancelled' || s === 'waiting') {
                    return s as WorkflowStatus;
                }
            }
            return 'running';
        case 'branch:selected':
        case 'step:inspection':
        case 'ai:complete':
        case 'flow:start':
        case 'step:start':
        case 'step:complete':
        case 'step:retry':
        case 'step:error':
        case 'step:skipped':
        case 'context:change':
        case 'cache:hit':
        case 'cache:miss':
        case 'notification:dispatched':
        case 'approval:requested':
            return 'running';
        default: {
            const _exhaustive: never = event;
            void _exhaustive;
            return 'running';
        }
    }
}

function createExecutionFromEvent(event: WorkflowExecutionEvent, namespace: string): WorkflowExecution {
    const status = mapEventToStatus(event);
    return {
        stackId: event.stackId ?? 'unknown',
        namespace: event.namespace ?? namespace,
        workflowId: 'flowName' in event ? event.flowName : undefined,
        status,
        revision: 1,
        createdAt: new Date(event.timestamp),
        updatedAt: new Date(event.timestamp),
        steps: [],
        compensations: [],
    };
}

export class DefaultWorkflowSubscriptionManager implements WorkflowSubscriptionManager {
    private readonly subscriptions = new Set<SubscriptionRegistration>();
    private readonly engine?: WorkflowQueryEngine;
    private readonly emitter?: WorkflowEventEmitter;
    private readonly eventListener: (event: WorkflowExecutionEvent) => void;

    constructor(options?: WorkflowSubscriptionManagerOptions) {
        this.engine = options?.engine;
        this.emitter = options?.emitter ?? defaultWorkflowEventEmitter;

        this.eventListener = (event: WorkflowExecutionEvent) => {
            void this.handleEvent(event);
        };

        if (this.emitter) {
            this.emitter.on('*', this.eventListener);
        }
    }

    private async handleEvent(event: WorkflowExecutionEvent): Promise<void> {
        if (!event) return;
        const stackId = event.stackId;
        if (!stackId) return;

        const isCompletionEvent =
            event.type === 'flow:complete' ||
            event.type === 'flow:error' ||
            (event.type === 'checkpoint:save' &&
                event.status !== undefined &&
                ['completed', 'failed', 'cancelled'].includes(event.status.toLowerCase()));

        // Group matching subscribers to avoid redundant engine queries
        const matchingUpdated: SubscriptionRegistration[] = [];
        const matchingCompleted: SubscriptionRegistration[] = [];

        for (const sub of this.subscriptions) {
            if (sub.type === 'workflowUpdated' && sub.stackId === stackId) {
                if (!event.namespace || sub.namespace === event.namespace) {
                    matchingUpdated.push(sub);
                }
            } else if (sub.type === 'workflowCompleted' && isCompletionEvent) {
                if (!event.namespace || sub.namespace === event.namespace) {
                    matchingCompleted.push(sub);
                }
            }
        }

        if (matchingUpdated.length === 0 && matchingCompleted.length === 0) {
            return;
        }

        // Cache loaded executions by namespace
        const executionCache = new Map<string, WorkflowExecution>();

        const getExecution = async (namespace: string): Promise<WorkflowExecution | undefined> => {
            let exec = executionCache.get(namespace);
            if (!exec) {
                if (this.engine) {
                    try {
                        await Promise.resolve();
                        const found = await this.engine.findById(stackId, {
                            namespace,
                            includeContext: true,
                        });
                        if (found) {
                            exec = found;
                        }
                    } catch {
                        // ignore and fall back to event synthesized execution
                    }
                }
                if (!exec) {
                    if (!event.namespace) return undefined;
                    exec = createExecutionFromEvent(event, namespace);
                } else {
                    const transitionStatus = mapEventToStatus(event);
                    if (event.type.startsWith('flow:') || event.type === 'checkpoint:save') {
                        exec.status = transitionStatus;
                    }
                }
                executionCache.set(namespace, exec);
            }
            return exec;
        };

        for (const sub of matchingUpdated) {
            const execution = await getExecution(sub.namespace);
            if (execution) sub.queue.push(execution);
        }

        for (const sub of matchingCompleted) {
            const execution = await getExecution(sub.namespace);
            if (execution) sub.queue.push(execution);
        }
    }

    publishWorkflowUpdated(execution: WorkflowExecution): void {
        for (const sub of this.subscriptions) {
            if (
                sub.type === 'workflowUpdated' &&
                sub.stackId === execution.stackId &&
                sub.namespace === execution.namespace
            ) {
                sub.queue.push(execution);
            }
        }
    }

    publishWorkflowCompleted(execution: WorkflowExecution): void {
        for (const sub of this.subscriptions) {
            if (sub.type === 'workflowCompleted' && sub.namespace === execution.namespace) {
                sub.queue.push(execution);
            }
        }
    }

    subscribeWorkflowUpdated(stackId: string, namespace: string): AsyncIterable<WorkflowExecution> {
        let registration: SubscriptionRegistration;
        const queue = new AsyncPushQueue<WorkflowExecution>(() => {
            this.subscriptions.delete(registration);
        });
        registration = {
            type: 'workflowUpdated',
            stackId,
            namespace,
            queue,
        };
        this.subscriptions.add(registration);
        return queue;
    }

    subscribeWorkflowCompleted(namespace: string): AsyncIterable<WorkflowExecution> {
        let registration: SubscriptionRegistration;
        const queue = new AsyncPushQueue<WorkflowExecution>(() => {
            this.subscriptions.delete(registration);
        });
        registration = {
            type: 'workflowCompleted',
            namespace,
            queue,
        };
        this.subscriptions.add(registration);
        return queue;
    }

    subscriberCount(type?: 'workflowUpdated' | 'workflowCompleted'): number {
        if (!type) return this.subscriptions.size;
        let count = 0;
        for (const sub of this.subscriptions) {
            if (sub.type === type) count++;
        }
        return count;
    }

    close(): void {
        if (this.emitter) {
            this.emitter.off('*', this.eventListener);
        }
        for (const sub of Array.from(this.subscriptions)) {
            sub.queue.close();
        }
        this.subscriptions.clear();
    }
}

export function createWorkflowSubscriptionManager(
    options?: WorkflowSubscriptionManagerOptions,
): WorkflowSubscriptionManager {
    return new DefaultWorkflowSubscriptionManager(options);
}
