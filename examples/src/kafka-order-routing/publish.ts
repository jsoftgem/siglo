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
    const metadata = await producer.send({ topic, messages: [{
        key: order.orderId,
        value: name === 'invalid' ? '{invalid JSON' : JSON.stringify(order),
        headers: { 'event-id': eventId, 'x-namespace': 'shop-demo' },
    }] });
    return { eventId, orderId: order.orderId, scenario: name, metadata };
}

async function main() {
    const name = process.argv[2] || 'standard';
    const producer = kafka('tutorial-publisher').producer();
    await producer.connect();
    try {
        console.log(JSON.stringify(await publishScenario(producer, name, process.argv[3], process.argv[4]), null, 2));
    } finally { await producer.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
