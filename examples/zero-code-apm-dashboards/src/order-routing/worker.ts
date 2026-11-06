import {startTelemetry, traceKafkaHandler} from './telemetry';
import {createServer} from 'node:http';
import {Redis} from 'ioredis';
import {WorkflowEventEmitter, setDefaultMonitor} from '@siglo/core';
import {createKafkaMessageHandler, getKafkaRecordId} from '@siglo/kafka';
import {PostgresIdempotencyStore} from '@siglo/postgres';
import {RedisMonitoringAdapter} from '@siglo/monitor';
import {handlePublishEvent} from './event-api';
import {createOrderRoutingWorkflow, validateOrderEvent, UnsupportedOrderEvent, type OrderEvent} from './workflow';
import {
    channel,
    database,
    deadLetterTopic,
    groupId,
    kafka,
    outcomeWriter,
    pubsubClient,
    redisUrl,
    topic
} from './infrastructure';

async function main() {
    const instance = process.env.INSTANCE_ID || 'worker-host';
    const telemetry = startTelemetry(instance);
    const pool = database();
    const redis = new Redis(redisUrl, {lazyConnect: true});
    redis.on('error', error => console.error('Redis:', error.message));
    await redis.connect();
    const emitter = new WorkflowEventEmitter();
    new RedisMonitoringAdapter({publisher: pubsubClient(redis), channel}).attachToEmitter(emitter);
    // Nested branch targets use the default emitter; the root uses the same one.
    setDefaultMonitor(emitter);
    const workflow = createOrderRoutingWorkflow(outcomeWriter(pool, instance), telemetry ? {tracer: telemetry.tracer} : undefined).monitor(emitter);
    const client = kafka(instance);
    const consumer = client.consumer({groupId, sessionTimeout: 15000, heartbeatInterval: 1000});
    const producer = client.producer();
    const shutdown = new AbortController();
    const idempotencyStore = new PostgresIdempotencyStore({client: pool});
    const handler = createKafkaMessageHandler<OrderEvent>(workflow, {
        groupId, idempotencyStore, idempotencyTtlMs: 60000, timeout: 10000,
        heartbeatIntervalMs: 1000, signal: shutdown.signal,
        idempotencyKey: message => String(message.headers?.['event-id'] ?? getKafkaRecordId(message)),
        input: message => ({
            ...JSON.parse(String(message.value)),
            tenant: String(message.headers?.['x-namespace'] || 'apm-demo')
        }),
        validate: (event, message) => {
            validateOrderEvent(event);
            if (message.headers?.['event-id'] !== undefined && String(message.headers['event-id']) !== event.eventId) {
                throw new Error('event-id header must match eventId');
            }
        },
        retry: {maxAttempts: 2, delayMs: 100, shouldRetry: error => !(error instanceof UnsupportedOrderEvent)},
        deadLetter: async ({message, recordId, error, attempts}) => {
            await producer.send({
                topic: deadLetterTopic, messages: [{
                    key: recordId, value: JSON.stringify({
                        recordId, eventId: String(message.headers?.['event-id'] || ''),
                        sourceTopic: message.topic, partition: message.partition, offset: message.offset,
                        raw: String(message.value), error: String(error), attempts,
                    })
                }]
            });
            await pool.query(
                'INSERT INTO tutorial_dead_letters VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                [recordId, String(message.headers?.['event-id'] || ''), String(error)],
            );
        },
    });
    let ready = false;
    let assignedPartitions: number[] = [];
    consumer.on(consumer.events.GROUP_JOIN, event => {
        ready = true;
        assignedPartitions = event.payload.memberAssignment[topic] || [];
    });
    consumer.on(consumer.events.CRASH, () => {
        ready = false;
    });
    consumer.on(consumer.events.DISCONNECT, () => {
        ready = false;
    });
    await producer.connect();
    await consumer.connect();
    await consumer.subscribe({topic, fromBeginning: true});
    await consumer.run({partitionsConsumedConcurrently: 2, eachMessage: traceKafkaHandler(handler)});

    const server = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        try {
            const path = new URL(request.url || '/', 'http://localhost').pathname;
            if (path === '/events') {
                await handlePublishEvent(request, response, producer);
            } else if (path === '/health') {
                response.statusCode = ready ? 200 : 503;
                response.end(JSON.stringify({instance, ready, assignedPartitions}));
            } else if (path === '/results') {
                response.end(JSON.stringify((await pool.query('SELECT result, executions FROM tutorial_order_results ORDER BY tenant, event_id')).rows.map(row => ({
                    ...row.result,
                    executions: row.executions
                }))));
            } else if (path === '/dead-letters') {
                response.end(JSON.stringify((await pool.query('SELECT * FROM tutorial_dead_letters ORDER BY record_id')).rows));
            } else {
                response.statusCode = 404;
                response.end(JSON.stringify({error: 'Not found'}));
            }
        } catch (error) {
            response.statusCode = 500;
            response.end(JSON.stringify({error: String(error)}));
        }
    });
    server.listen(Number(process.env.PORT || 3400), '0.0.0.0');
    const close = async () => {
        ready = false;
        shutdown.abort();
        server.close();
        await consumer.disconnect();
        await producer.disconnect();
        redis.disconnect();
        await pool.end();
        setDefaultMonitor(undefined);
        await telemetry?.shutdown();
    };
    process.once('SIGTERM', () => {
        void close();
    });
    process.once('SIGINT', () => {
        void close();
    });
    console.log(`${instance} consumes ${topic} in ${groupId}`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
