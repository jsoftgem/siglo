// Child process fixture: simulate a provider that deduplicates an external effect by event ID.
const fs = require('node:fs');
const { Kafka, logLevel } = require('kafkajs');
const { createKafkaMessageHandler } = require('../dist');
const [broker, topic, groupId, effectsPath, crashMode] = process.argv.slice(2);
const consumer = new Kafka({
    clientId: `crash-${process.pid}`,
    brokers: [broker],
    logLevel: logLevel.NOTHING,
}).consumer({
    groupId,
    sessionTimeout: 6000,
    heartbeatInterval: 200,
});
const handler = createKafkaMessageHandler(
    {
        run: async event => {
            const effects = fs.existsSync(effectsPath) ? JSON.parse(fs.readFileSync(effectsPath, 'utf8')) : [];
            if (!effects.includes(event.eventId)) {
                effects.push(event.eventId);
                fs.writeFileSync(effectsPath, JSON.stringify(effects));
            }
            process.send({ type: 'effect', eventId: event.eventId });
            if (crashMode === 'crash') await new Promise(() => {});
            return { processed: true };
        },
    },
    { heartbeatIntervalMs: 200 },
);
(async () => {
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({ eachMessage: handler });
})().catch(error => {
    process.send({ type: 'error', error: String(error) });
    process.exit(1);
});
process.on('message', async message => {
    if (message === 'stop') {
        await consumer.disconnect();
        process.exit(0);
    }
});
