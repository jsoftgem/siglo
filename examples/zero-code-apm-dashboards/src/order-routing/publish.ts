import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { injectTraceContext } from '@siglo/opentelemetry';
import { startTelemetry } from './telemetry';
import { randomUUID } from 'node:crypto';
import type { Producer } from 'kafkajs';
import { kafka, topic } from './infrastructure';

export const scenarios = ['standard', 'gift', 'review', 'cancel', 'unsupported', 'invalid'] as const;

export function scenario(name: string, eventId: string, orderId = `order-${eventId}`) {
    if (!(scenarios as readonly string[]).includes(name)) throw new Error(`Unknown scenario: ${name}`);
    return {
        eventId, orderId,
        type: name === 'cancel' ? 'order.cancelled' : name === 'unsupported' ? 'order.refunded' : 'order.placed',
        amountCents: name === 'review' ? 120000 : 5000,
        giftWrap: name === 'gift',
    };
}

export async function publishScenario(producer: Pick<Producer, 'send'>, name = 'standard', eventId = `${name}-${randomUUID()}`, orderId?: string) {
    const order = scenario(name, eventId, orderId);
    return trace.getTracer('zero-code-apm-dashboards').startActiveSpan('kafka:publish apm.orders', {
        kind: SpanKind.PRODUCER,
        attributes: { 'messaging.system': 'kafka', 'messaging.destination.name': topic },
    }, async span => {
        try {
            const headers: Record<string, string> = { 'event-id': eventId, 'x-namespace': 'apm-demo' };
            injectTraceContext(headers);
            const metadata = await producer.send({ topic, messages: [{
                key: order.orderId,
                value: name === 'invalid' ? '{invalid JSON' : JSON.stringify(order),
                headers,
            }] });
            span.setStatus({ code: SpanStatusCode.OK });
            return { eventId, orderId: order.orderId, scenario: name, metadata, traceId: span.isRecording() ? span.spanContext().traceId : undefined };
        } catch (error) {
            span.recordException(error instanceof Error ? error : String(error));
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
        } finally { span.end(); }
    });
}

async function main() {
    const name = process.argv[2] || 'standard';
    const telemetry = startTelemetry('kafka-order-publisher');
    const producer = kafka('tutorial-publisher').producer();
    await producer.connect();
    try {
        console.log(JSON.stringify(await publishScenario(producer, name, process.argv[3], process.argv[4]), null, 2));
    } finally {
        await producer.disconnect();
        await telemetry?.shutdown();
    }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
