# Database changes and follow-up Kafka events

A workflow cannot atomically commit a PostgreSQL update and a Kafka send. Put the database change, a processed-event marker, and an outbox row in **one PostgreSQL transaction**. A separate relay publishes committed outbox rows. This makes database effects safe to replay and prevents losing a follow-up event between the update and the send.

The adapter's `idempotencyStore` is optional for this pattern: the database transaction owns deduplication for these database effects. Other effects, such as a payment-provider request, still need the provider's own idempotency key.

## Schema

Run this migration in your application's database:

```sql
CREATE TABLE processed_order_events (
    consumer_group text NOT NULL,
    tenant text NOT NULL,
    event_id text NOT NULL,
    PRIMARY KEY (consumer_group, tenant, event_id)
);

CREATE TABLE accepted_orders (
    tenant text NOT NULL,
    order_id text NOT NULL,
    PRIMARY KEY (tenant, order_id)
);

CREATE TABLE order_outbox (
    event_id text PRIMARY KEY,
    payload jsonb NOT NULL,
    published_at timestamptz
);
CREATE INDEX order_outbox_pending ON order_outbox (event_id)
    WHERE published_at IS NULL;
```

## Workflow step

Install `pg` and its TypeScript types alongside the getting-started dependencies. The producer of an order must supply an `eventId` that stays the same on business-event retries; the Kafka record key can still identify the order.

```typescript
import { Pool } from 'pg';
import { Step, flow } from '@siglo/core';
import { createKafkaMessageHandler } from '@siglo/kafka';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const groupId = 'order-acceptance';
interface OrderEvent { eventId: string; tenant: string; orderId: string }

const acceptOrder = Step.create('acceptOrder', async (event: OrderEvent) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const inserted = await client.query(
            `INSERT INTO processed_order_events VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING RETURNING event_id`,
            [groupId, event.tenant, event.eventId],
        );
        if (inserted.rowCount === 0) {
            await client.query('COMMIT');
            return { duplicate: true };
        }
        await client.query(
            'INSERT INTO accepted_orders VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [event.tenant, event.orderId],
        );
        const outgoingId = JSON.stringify([groupId, event.tenant, event.eventId, 'order.accepted']);
        await client.query(
            'INSERT INTO order_outbox(event_id, payload) VALUES ($1, $2::jsonb)',
            [outgoingId, JSON.stringify({
                eventId: outgoingId, tenant: event.tenant, orderId: event.orderId,
            })],
        );
        await client.query('COMMIT');
        return { accepted: true };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
});

const handler = createKafkaMessageHandler<OrderEvent>(flow(acceptOrder), {
    validate: event => {
        if (!event || ![event.eventId, event.tenant, event.orderId]
            .every(value => typeof value === 'string' && value.length > 0)) {
            throw new Error('eventId, tenant, and orderId are required');
        }
    },
});
// Pass handler to a connected KafkaJS consumer's eachMessage option.
```

A crash before the transaction commits rolls everything back. A crash after commit but before Kafka offset completion causes redelivery; the primary key prevents repeating the database change or creating another outbox event. Keep processed-event markers for at least as long as you permit source-event replay.

## Relay

With a connected KafkaJS `producer`, call this function repeatedly from a worker, backing off when there is no pending row or an error occurs:

```typescript
async function publishNextOutbox(): Promise<boolean> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT event_id, payload FROM order_outbox
             WHERE published_at IS NULL ORDER BY event_id
             LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        if (rows.length === 0) {
            await client.query('COMMIT');
            return false;
        }
        const row = rows[0];
        await producer.send({
            topic: 'orders.accepted',
            messages: [{ key: row.event_id, value: JSON.stringify(row.payload) }],
        });
        await client.query(
            'UPDATE order_outbox SET published_at = NOW() WHERE event_id = $1',
            [row.event_id],
        );
        await client.query('COMMIT');
        return true;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
```

Multiple relay workers can claim different rows using `SKIP LOCKED`. Configure bounded database and producer timeouts because this simple relay holds a database transaction while sending. It does not guarantee per-order publication ordering across workers; use partitioned relay ownership or sequence enforcement when ordering is required.

A crash after sending but before marking the row published can publish the event again. Downstream consumers must deduplicate by `payload.eventId`, scoped to their group and tenant, using a transactional processed-event marker or a suitable idempotency store. A Kafka message key alone does not deduplicate records.
