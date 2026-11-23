import {
    WorkflowExecutionEvent,
    WorkflowEventEmitter,
    redactEvent,
    RedactionOptions,
    isPlainObject,
} from '@siglo/core';

export interface RedisPubSubClient {
    publish(channel: string, message: string): Promise<unknown> | unknown;
    subscribe(channel: string, listener?: (message: string) => void): Promise<unknown> | unknown;
    on?(event: 'message', listener: (channel: string, message: string) => void): unknown;
}

export interface RedisMonitoringOptions {
    channel?: string;
    publisher?: RedisPubSubClient;
    subscriber?: RedisPubSubClient;
    emitter?: WorkflowEventEmitter;
    redaction?: RedactionOptions;
}

export class RedisMonitoringAdapter {
    private channel: string;
    private publisher?: RedisPubSubClient;
    private subscriber?: RedisPubSubClient;
    private emitter?: WorkflowEventEmitter;
    private redaction?: RedactionOptions;

    constructor(options: RedisMonitoringOptions) {
        this.channel = options.channel || 'siglo:monitor:events';
        this.publisher = options.publisher;
        this.subscriber = options.subscriber;
        this.emitter = options.emitter;
        this.redaction = options.redaction;

        if (this.subscriber) {
            this.setupSubscription();
        }
    }

    private setupSubscription(): void {
        if (!this.subscriber) return;

        if (typeof this.subscriber.on === 'function') {
            this.subscriber.on('message', (chan: string, msg: string) => {
                if (chan === this.channel) {
                    this.handleIncoming(msg);
                }
            });
            this.subscriber.subscribe(this.channel);
        } else {
            this.subscriber.subscribe(this.channel, (msg: string) => {
                this.handleIncoming(msg);
            });
        }
    }

    private handleIncoming(raw: string): void {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!isPlainObject(parsed) || typeof parsed.type !== 'string' || typeof parsed.stackId !== 'string') {
                return;
            }
            if (this.emitter) {
                this.emitter.emit(parsed as unknown as WorkflowExecutionEvent);
            }
        } catch {
            // Ignore corrupted json
        }
    }

    async publish(event: WorkflowExecutionEvent): Promise<void> {
        if (!this.publisher || !event) return;
        const sanitized = redactEvent(event, this.redaction);
        const serialized = JSON.stringify(sanitized);
        try {
            await this.publisher.publish(this.channel, serialized);
        } catch {
            // Non-functional requirement: monitoring failures never crash execution
        }
    }

    attachToEmitter(emitter: WorkflowEventEmitter): this {
        this.emitter = emitter;
        emitter.on('*', event => {
            this.publish(event).catch(() => {});
        });
        return this;
    }
}
