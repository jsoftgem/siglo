import { kafka, topic } from './infrastructure';

export function scenario(name: string, eventId: string, orderId = `order-${eventId}`) {
    if (!['standard', 'gift', 'review', 'cancel', 'unsupported', 'invalid'].includes(name)) throw new Error(`Unknown scenario: ${name}`);
    return {
        eventId, orderId,
        type: name === 'cancel' ? 'order.cancelled' : name === 'unsupported' ? 'order.refunded' : 'order.placed',
        amountCents: name === 'review' ? 120000 : 5000,
        giftWrap: name === 'gift',
    };
}
async function main() {
    const name = process.argv[2] || 'standard';
    const eventId = process.argv[3] || `${name}-${Date.now()}`;
    const order = scenario(name, eventId, process.argv[4]);
    const producer = kafka('tutorial-publisher').producer();
    await producer.connect();
    try {
        const metadata = await producer.send({ topic, messages: [{
            key: order.orderId,
            value: name === 'invalid' ? '{invalid JSON' : JSON.stringify(order),
            headers: { 'event-id': eventId, 'x-namespace': 'shop-demo' },
        }] });
        console.log(JSON.stringify({ eventId, orderId: order.orderId, scenario: name, metadata }, null, 2));
    } finally { await producer.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
