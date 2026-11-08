import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Kafka } from 'kafkajs';
import { WorkflowEventEmitter } from '@siglo/core';
import { createKafkaMessageHandler } from '@siglo/kafka';
import { createRoutingWorkflow } from './routing';
import { createApp, listenForRequests } from './app';
import { startLiveMonitor } from './monitoring';
import type { ClientKey } from './security';

async function main() {
    const keys = new Map<string, ClientKey>([
        [
            'shop-demo-key',
            {
                publicKey: readFileSync(
                    resolve(__dirname, '../../signed-order-intake/.local/client-public.pem'),
                    'utf8',
                ),
                clientId: 'shop-demo',
                active: true,
            },
        ],
    ]);
    const port = Number(process.env.SIGNED_ORDER_PORT ?? 3400);
    const kafka = new Kafka({
        clientId: 'signed-order-intake',
        brokers: [process.env.SIGNED_ORDER_BROKER ?? '127.0.0.1:39092'],
    });
    const topic = 'signed-order-intake.orders';
    const producer = kafka.producer();
    const consumer = kafka.consumer({ groupId: 'signed-order-intake.routing-v1' });
    const emitter = new WorkflowEventEmitter();
    let ready = false;
    const app = createApp(
        keys,
        async event => {
            await producer.send({
                topic,
                messages: [
                    {
                        key: event.orderId,
                        value: JSON.stringify(event),
                        headers: { 'event-id': event.eventId, 'x-namespace': event.tenant },
                    },
                ],
            });
        },
        undefined,
        emitter,
        () => ready,
    );
    // Reserve HTTP first. A duplicate process must not start a competing consumer/dashboard.
    const server = await listenForRequests(app, port);
    let monitor: Awaited<ReturnType<typeof startLiveMonitor>> | undefined;
    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        ready = false;
        await new Promise<void>((done, reject) => server.close(error => (error ? reject(error) : done())));
        try {
            await consumer.disconnect();
        } finally {
            try {
                await producer.disconnect();
            } finally {
                await monitor?.close();
            }
        }
    };
    try {
        monitor = await startLiveMonitor(undefined, emitter);
        const admin = kafka.admin();
        try {
            await admin.connect();
            await admin.createTopics({
                topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
                waitForLeaders: true,
            });
        } finally {
            await admin.disconnect();
        }
        await producer.connect();
        const routing = createRoutingWorkflow(result => {
            console.log(JSON.stringify(result));
        }).monitor(emitter);
        await consumer.connect();
        await consumer.subscribe({ topic, fromBeginning: true });
        await consumer.run({
            eachMessage: createKafkaMessageHandler(routing, {
                input: message => JSON.parse(String(message.value)),
            }),
        });
        ready = true;
    } catch (error) {
        await stop();
        throw error;
    }
    const shutdown = () => {
        void stop().catch(error => {
            console.error(error);
            process.exitCode = 1;
        });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    console.log(`Signed order intake ready: http://127.0.0.1:${port}`);
}
main().catch(error => {
    console.error('Signed order intake startup failed:', error.message);
    process.exitCode = 1;
});
