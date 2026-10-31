import { WorkflowExecutionEvent, WorkflowEventEmitter, redactEvent, RedactionOptions } from 'siglo';

export interface RedisPubSubClient {
    publish(channel: string, message: string): Promise<number | any> | number | any;
    subscribe(channel: string, listener?: (message: string) => void): Promise<any> | any;
    on?(event: 'message', listener: (channel: string, message: string) => void): any;
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
            const event = JSON.parse(raw) as WorkflowExecutionEvent;
            if (this.emitter) {
                this.emitter.emit(event);
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
        emitter.on('*', (event) => {
            this.publish(event).catch(() => {});
        });
        return this;
    }
}
