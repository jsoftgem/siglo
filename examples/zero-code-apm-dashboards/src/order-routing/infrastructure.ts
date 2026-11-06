import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Kafka, logLevel } from 'kafkajs';
import { PostgresIdempotencyStore } from '@siglo/postgres';
import type { OrderOutcome } from './workflow';

export const groupId = 'apm-order-routing-v1';
export const topic = 'apm.orders';
export const deadLetterTopic = 'apm.orders.dead-letter';
export const channel = 'tutorial:zero-code-apm:events';
export const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6383';
export function kafka(clientId: string) {
    return new Kafka({ clientId, brokers: (process.env.KAFKA_BROKERS || '127.0.0.1:39092').split(','), logLevel: logLevel.ERROR });
}
export function database() {
    return new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://siglo:siglo@127.0.0.1:5436/apm_orders', connectionTimeoutMillis: 5000 });
}
export function pubsubClient(redis: Redis) {
    return {
        publish: (name: string, message: string) => redis.publish(name, message),
        subscribe: (name: string) => redis.subscribe(name),
        on: (event: 'message', listener: (name: string, message: string) => void) => redis.on(event, listener),
    };
}
export function outcomeWriter(pool: Pool, instance: string) {
    return async (outcome: OrderOutcome): Promise<OrderOutcome> => {
        // Pick domain fields explicitly: workflow contexts also carry runtime metadata.
        const result: OrderOutcome = {
            eventId: outcome.eventId, type: outcome.type, orderId: outcome.orderId,
            tenant: outcome.tenant, amountCents: outcome.amountCents,
            giftWrap: outcome.giftWrap, status: outcome.status, actions: outcome.actions,
            giftWrapped: outcome.giftWrapped ?? false, handledBy: instance,
        };
        const saved = await pool.query(
            `INSERT INTO tutorial_order_results(tenant, event_id, result)
             VALUES ($1, $2, $3::jsonb) ON CONFLICT (tenant, event_id)
             DO UPDATE SET executions = tutorial_order_results.executions + 1 RETURNING result`,
            [result.tenant, result.eventId, JSON.stringify(result)],
        );
        return saved.rows[0].result;
    };
}

async function initialize() {
    const pool = database();
    const admin = kafka('tutorial-init').admin();
    try {
        await new PostgresIdempotencyStore({ client: pool }).ensureTable();
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tutorial_order_results (
                tenant text NOT NULL, event_id text NOT NULL, result jsonb NOT NULL, executions integer NOT NULL DEFAULT 1,
                PRIMARY KEY (tenant, event_id)
            );
            CREATE TABLE IF NOT EXISTS tutorial_dead_letters (
                record_id text PRIMARY KEY, event_id text, error text NOT NULL
            );
        `);
        await admin.connect();
        await admin.createTopics({ topics: [
            { topic, numPartitions: 4, replicationFactor: 1 },
            { topic: deadLetterTopic, numPartitions: 1, replicationFactor: 1 },
        ] });
    } finally { await admin.disconnect(); await pool.end(); }
}
if (require.main === module) initialize().catch(error => { console.error(error); process.exitCode = 1; });
