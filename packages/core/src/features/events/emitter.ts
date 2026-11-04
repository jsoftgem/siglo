import {
    WorkflowExecutionEvent,
    WorkflowExecutionEventType,
    WorkflowExecutionEventMap
} from './types';
import { redactEvent } from './redaction';
import { StorageAdapter } from '../storage';

export type EventListener<T = WorkflowExecutionEvent> = (event: T) => void | Promise<void>;

export class WorkflowEventEmitter {
    private listeners: Map<string, Set<EventListener<any>>> = new Map();
    private wildcardListeners: Set<EventListener<WorkflowExecutionEvent>> = new Set();
    private namespaceFilter?: string;

    constructor(namespaceFilter?: string) {
        this.namespaceFilter = namespaceFilter;
    }

    on<K extends WorkflowExecutionEventType>(
        eventOrListener: K | '*' | EventListener<WorkflowExecutionEvent>,
        listener?: EventListener<WorkflowExecutionEventMap[K]>
    ): this {
        if (typeof eventOrListener === 'function') {
            this.wildcardListeners.add(eventOrListener);
            return this;
        }
        if (eventOrListener === '*') {
            if (listener) {
                this.wildcardListeners.add(listener as EventListener<WorkflowExecutionEvent>);
            }
            return this;
        }
        if (listener) {
            let set = this.listeners.get(eventOrListener);
            if (!set) {
                set = new Set();
                this.listeners.set(eventOrListener, set);
            }
            set.add(listener);
        }
        return this;
    }

    once<K extends WorkflowExecutionEventType>(
        event: K | '*',
        listener: EventListener<any>
    ): this {
        const onceWrapper = (ev: any) => {
            this.off(event, onceWrapper);
            return listener(ev);
        };
        return this.on(event as any, onceWrapper);
    }

    off<K extends WorkflowExecutionEventType>(
        eventOrListener: K | '*' | EventListener<WorkflowExecutionEvent>,
        listener?: EventListener<any>
    ): this {
        if (typeof eventOrListener === 'function') {
            this.wildcardListeners.delete(eventOrListener);
            return this;
        }
        if (eventOrListener === '*') {
            if (listener) {
                this.wildcardListeners.delete(listener);
            } else {
                this.wildcardListeners.clear();
            }
            return this;
        }
        if (listener) {
            const set = this.listeners.get(eventOrListener);
            if (set) {
                set.delete(listener);
                if (set.size === 0) {
                    this.listeners.delete(eventOrListener);
                }
            }
        } else {
            this.listeners.delete(eventOrListener);
        }
        return this;
    }

    emit(event: WorkflowExecutionEvent): void;
    emit<K extends WorkflowExecutionEventType>(type: K, event: WorkflowExecutionEventMap[K]): void;
    emit(eventOrType: WorkflowExecutionEvent | string, maybePayload?: any): void {
        const event: WorkflowExecutionEvent = typeof eventOrType === 'string'
            ? Object.assign({}, maybePayload, { type: eventOrType, timestamp: maybePayload?.timestamp || Date.now() })
            : eventOrType;

        if (!event || !event.type) {
            return;
        }

        if (this.namespaceFilter && event.namespace && event.namespace !== this.namespaceFilter) {
            return;
        }

        const specific = this.listeners.get(event.type);
        if (specific && specific.size > 0) {
            for (const fn of Array.from(specific)) {
                try {
                    Promise.resolve(fn(event)).catch(() => {});
                } catch {
                    // Non-functional requirement: resilience against listener failure
                }
            }
        }

        if (this.wildcardListeners.size > 0) {
            for (const fn of Array.from(this.wildcardListeners)) {
                try {
                    Promise.resolve(fn(event)).catch(() => {});
                } catch {
                    // Non-functional requirement: resilience against listener failure
                }
            }
        }
    }

    removeAllListeners(event?: string): this {
        if (event === '*') {
            this.wildcardListeners.clear();
        } else if (event) {
            this.listeners.delete(event);
        } else {
            this.listeners.clear();
            this.wildcardListeners.clear();
        }
        return this;
    }

    listenerCount(event?: string): number {
        if (event === '*') {
            return this.wildcardListeners.size;
        }
        if (event) {
            return (this.listeners.get(event)?.size || 0) + this.wildcardListeners.size;
        }
        let total = this.wildcardListeners.size;
        for (const set of this.listeners.values()) {
            total += set.size;
        }
        return total;
    }

    filterNamespace(namespace: string): WorkflowEventEmitter {
        const scoped = new WorkflowEventEmitter(namespace);
        this.on('*', (ev) => {
            if (!ev.namespace || ev.namespace === namespace) {
                scoped.emit(ev);
            }
        });
        return scoped;
    }

    toStorageAdapter(): StorageAdapter {
        return {
            name: 'workflow-event-emitter',
            onContextChange: (entry) => {
                this.emit({
                    type: 'context:change',
                    stackId: entry.stackId,
                    stepId: entry.stepId,
                    field: entry.field,
                    value: entry.value,
                    timestamp: entry.timestamp,
                    namespace: entry.namespace
                });
            },
            onCacheEvent: (event) => {
                if (event.type === 'hit') {
                    this.emit({
                        type: 'cache:hit',
                        stackId: event.stackId,
                        stepId: event.stepId,
                        key: event.key,
                        timestamp: event.timestamp,
                        namespace: event.namespace
                    });
                } else {
                    this.emit({
                        type: 'cache:miss',
                        stackId: event.stackId,
                        stepId: event.stepId,
                        key: event.key,
                        timestamp: event.timestamp,
                        namespace: event.namespace
                    });
                }
            },
            saveCheckpoint: async (checkpoint) => {
                this.emit({
                    type: 'checkpoint:save',
                    stackId: checkpoint.stackId,
                    status: checkpoint.status,
                    timestamp: checkpoint.timestamp || Date.now(),
                    namespace: checkpoint.namespace
                });
            }
        };
    }
}

export const defaultWorkflowEventEmitter = new WorkflowEventEmitter();

let globalDefaultMonitor: WorkflowEventEmitter | undefined;

export function setDefaultMonitor(monitor?: WorkflowEventEmitter): void {
    globalDefaultMonitor = monitor;
}

export function getDefaultMonitor(): WorkflowEventEmitter | undefined {
    return globalDefaultMonitor;
}

export function emitMonitoringEvent(options: any, event: WorkflowExecutionEvent): void {
    try { event = redactEvent(event); } catch { return; }
    const localMonitor = options?.monitor;
    const globalMonitor = globalDefaultMonitor;

    if (!localMonitor && !globalMonitor) {
        return;
    }

    const emitTo = (target: any) => {
        if (!target) return;
        try {
            if (typeof target.emit === 'function') {
                target.emit(event);
            } else if (typeof target === 'function') {
                target(event);
            }
        } catch {
            // Non-functional requirement: resilience against listener failure
        }
    };

    if (localMonitor) {
        emitTo(localMonitor);
    }
    if (globalMonitor && globalMonitor !== localMonitor) {
        emitTo(globalMonitor);
    }
}
