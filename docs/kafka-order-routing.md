---
title: 'Route Kafka Order Events with branch and when'
description: 'Consume Kafka order events, route conditional fulfillment with branch and when, deduplicate with PostgreSQL, and monitor live decisions in Siglo.'
---

In [Suspend Checkout for Approval and Resume Across Servers](/durable-distributed-checkout), an HTTP request started checkout and another request resumed it after approval. Now imagine a storefront publishing order events while fulfillment services consume them independently.

This tutorial uses **`@siglo/kafka`** to start a Siglo workflow for each Kafka record. Two consumer replicas share **`@siglo/postgres` idempotency**, and a Redis-backed live monitor shows the workflow's routing decisions:

- **`branch`** selects a path for placed orders, cancellation requests, or unsupported event types.
- **`when` with an else path** sends high-value orders to review and ordinary orders to fulfillment.
- **`when` without an else path** adds gift wrapping only when requested.

The fulfillment operations are fake. You can explore routing, consumer groups, duplicate events, and dead-letter handling without payment or shipping accounts. A `review-required` outcome records a decision; it does not suspend a durable workflow. The previous tutorial remains the example for persisted waits and cross-server resumption.

The integration point in [worker.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/kafka-order-routing/worker.ts) is **`createKafkaMessageHandler` from `@siglo/kafka`**. Once the workflow and KafkaJS consumer are defined and the consumer is connected and subscribed:

```typescript
import { createKafkaMessageHandler } from '@siglo/kafka';

const handleOrder = createKafkaMessageHandler(orderWorkflow);

await consumer.run({
    eachMessage: handleOrder,
});
```

KafkaJS supplies each record to the adapter. `@siglo/kafka` prepares its input and runs the Siglo workflow; `branch` and `when` select the workflow's path. The runnable worker also configures the adapter's validation, PostgreSQL deduplication, heartbeats, retries, cancellation, and dead-letter callback. Section 3 shows that wiring with its imports.

---

## Run the Example

You need a repository checkout, a running Docker daemon, and Docker Compose supporting `up --wait`. From the repository root:

```bash
docker compose -f examples/kafka-order-routing/docker-compose.yml up --build -d --wait
```

The separate **`siglo-kafka-order-routing`** project uses its own image, Kafka and PostgreSQL volumes, Redis channel, database, and host ports. The earlier checkout examples can keep running.

| Service                             | Local address                                                  |
| ----------------------------------- | -------------------------------------------------------------- |
| Worker A: health and shared results | http://127.0.0.1:3300/health and http://127.0.0.1:3300/results |
| Worker B: health and shared results | http://127.0.0.1:3301/health and http://127.0.0.1:3301/results |
| Live monitor                        | http://127.0.0.1:4300                                          |
| Kafka                               | 127.0.0.1:29092                                                |
| PostgreSQL                          | postgres://siglo:siglo@127.0.0.1:5435/kafka_orders             |
| Redis                               | redis://127.0.0.1:6382                                         |

Publish a gift order using the producer in worker A's container:

```bash
docker compose -f examples/kafka-order-routing/docker-compose.yml exec worker-a \
  node --import tsx examples/src/kafka-order-routing/publish.ts gift
```

The producer prints the event ID and Kafka partition/offset metadata. Either worker can process the event; the container running the producer does not choose its consumer.

Open **http://127.0.0.1:4300** and inspect the completed run. Then read the persisted outcome:

```bash
curl -s http://127.0.0.1:3300/results
```

Find the event ID printed by the producer. Its result includes:

```json
{
    "status": "shipped",
    "giftWrapped": true,
    "actions": ["reserveStock", "chargePayment", "wrapGift", "shipOrder"],
    "handledBy": "worker-a",
    "executions": 1
}
```

`handledBy` may be `worker-a` or `worker-b`. Both `/results` endpoints read the same PostgreSQL table. `executions` counts visits to the workflow's final persistence step; ordinary duplicate delivery should leave it at one.

Try the other paths by changing the publisher's scenario argument:

| Scenario      | Event / condition                | Expected result                                                    |
| ------------- | -------------------------------- | ------------------------------------------------------------------ |
| `standard`    | `order.placed`, 5,000 cents      | Reserve, charge, ship; no gift wrap                                |
| `gift`        | `order.placed`, `giftWrap: true` | Reserve, charge, wrap, ship                                        |
| `review`      | `order.placed`, 120,000 cents    | `review-required`; no charge or shipping                           |
| `cancel`      | `order.cancelled`                | `cancellation-recorded`; no fulfillment                            |
| `unsupported` | `order.refunded`                 | Explicit fallback fails; record goes to the dead-letter topic      |
| `invalid`     | Malformed JSON                   | Rejected before the workflow; record goes to the dead-letter topic |

Run the smoke check, including restarting **both workers** and replaying an already completed business event:

```bash
sh examples/kafka-order-routing/smoke.sh
```

Stop this example with:

```bash
docker compose -f examples/kafka-order-routing/docker-compose.yml down
```

Kafka records, consumer offsets, and PostgreSQL results survive `down`. Add `--volumes` only to reset this example's data.

### Example Files to Explore

| File                                                                                                 | Purpose                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [workflow.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/kafka-order-routing/workflow.ts)                                       | Event routing, nested conditions, named steps, and validation                              |
| [worker.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/kafka-order-routing/worker.ts)                                           | Kafka adapter, PostgreSQL idempotency, retries, dead letters, and health/results endpoints |
| [infrastructure.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/kafka-order-routing/infrastructure.ts)                           | Kafka topics, shared database schema, and result persistence                               |
| [publish.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/kafka-order-routing/publish.ts)                                         | Six scenarios with event IDs, entity keys, and tenant headers                              |
| [monitor.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/kafka-order-routing/monitor.ts)                                         | Shared live monitor consuming Redis events                                                 |
| [workflow.test.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/kafka-order-routing/workflow.test.ts)                             | Routing, threshold, optional-step, and validation tests                                    |
| [smoke.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/kafka-order-routing/smoke.ts)                                             | Real Kafka, PostgreSQL, Redis, and restart assertions                                      |
| [docker-compose.yml](https://github.com/jsoftgem/siglo/tree/main/examples/kafka-order-routing/docker-compose.yml)                             | Isolated broker, database, Redis, two workers, and monitor                                 |
| [Example README](https://github.com/jsoftgem/siglo/blob/main/examples/kafka-order-routing/README.md) | Commands, ports, and rebuilding after edits                                                |

---

## 1. How Kafka and Siglo Fit Together

```mermaid
flowchart TD
    Storefront["Storefront producer"] --> Topic["tutorial.orders: 4 partitions"]
    Topic --> Group["Consumer group: tutorial-order-routing-v1"]
    Group --> A["Worker A"]
    Group --> B["Worker B"]
    A --> Adapter["createKafkaMessageHandler"]
    B --> Adapter
    Adapter --> Route{"branch: event.type"}
    Route -->|order.placed| Review{"when: amount >= 100,000 cents"}
    Review -->|true| Queue["queueReview"]
    Review -->|false| Reserve["reserveStock → chargePayment"]
    Reserve --> Gift{"when: giftWrap"}
    Gift -->|true| Wrap["wrapGift"]
    Gift -->|false: skip| Ship["shipOrder"]
    Wrap --> Ship
    Route -->|order.cancelled| Cancel["recordCancellation"]
    Route -->|fallback| Reject["rejectUnsupported → dead-letter topic"]
    Queue --> Save["saveOutcome"]
    Ship --> Save
    Cancel --> Save
```

For each record:

1. KafkaJS delivers the topic, partition, record, and heartbeat callback to `eachMessage`.
2. The adapter claims the event in PostgreSQL within its consumer-group and tenant scope.
3. The input mapper parses JSON and adds the tenant from the Kafka header. Validation runs before any workflow step.
4. Siglo selects a branch and executes the chosen steps within that worker process.
5. The workflow saves its outcome, and the adapter completes the claim. KafkaJS can then advance the consumer group's offsets.

Kafka distributes **records by partition** between the workers. It does not send `reserveStock` to one server and `shipOrder` to another. Each selected workflow runs on the consumer handling its record.

The order ID is the Kafka key, keeping an entity's events in the same partition under a stable partitioning configuration. Different event IDs for that order still represent different work.

---

## 2. Define the Event and Its Routing Rules

The publisher sends JSON like this, with `event-id` and `x-namespace` headers:

```json
{
    "eventId": "gift-1001",
    "type": "order.placed",
    "orderId": "order-1001",
    "amountCents": 5000,
    "giftWrap": true
}
```

The input mapper supplies `tenant: "shop-demo"` from the header. [workflow.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/kafka-order-routing/workflow.ts) validates identifiers, positive integer amounts for placed orders, and the optional boolean flag.

### Use `branch` to Choose an Event Handler

After defining the named steps and subflows, the workflow's outer structure is:

```typescript
return flow(
    branch(
        event => event.type,
        {
            'order.placed': placedOrder,
            'order.cancelled': cancelOrder,
        },
        rejectUnsupported,
    ),
    saveOutcome,
);
```

`branch` evaluates the selector once and executes the matching target. Each target can be a step or a composed flow. Its output merges into the context available to `saveOutcome`.

The fallback is deliberate. An unknown event should not silently reach `saveOutcome` as if fulfillment succeeded. `rejectUnsupported` throws an application error derived from `SigloError` with `retryable: false`; the worker's retry predicate sends it directly to quarantine after one workflow attempt.

This fallback differs from invalid JSON or a missing required field: those are rejected before the workflow starts.

### Use `when` for a Business Decision

The placed-order route selects between review and fulfillment:

```typescript
const placedOrder = when(order => order.amountCents >= 100000, queueReview, fulfillment);
```

An order at or above the threshold executes only `queueReview`, producing `review-required`. It does not reserve inventory, charge a payment, or ship. An ordinary order executes the fulfillment flow instead.

The demo records the review decision and completes processing of that Kafka record. To wait for approval, model a separate approval event or follow the persisted-wait design in the [durable checkout tutorial](/durable-distributed-checkout). A returned review status alone does not register a durable wait.

### Use `when` Without an Else for an Optional Step

The fulfillment path contains another condition:

```typescript
const fulfillment = flow(
    reserveStock,
    chargePayment,
    when(order => order.giftWrap === true, wrapGift),
    shipOrder,
);
```

When gift wrapping is requested, `wrapGift` adds `giftWrapped: true` and appends its action. Otherwise that target is skipped and execution continues to `shipOrder`. Prior results remain in the workflow context.

The same pattern can add an audit, notification, or optional enrichment without duplicating the rest of a flow. Keep irreversible external actions idempotent because retries restart the selected workflow.

---

## 3. Connect `@siglo/kafka` to `@siglo/postgres`

The initializer creates the topics, outcome tables, and `PostgresIdempotencyStore` table once before either worker starts. Both workers connect to that same database and use the same consumer group.

The key adapter options in [worker.ts](https://github.com/jsoftgem/siglo/tree/main/examples/src/kafka-order-routing/worker.ts) are:

```typescript
import { createKafkaMessageHandler, getKafkaRecordId } from '@siglo/kafka';
import { PostgresIdempotencyStore } from '@siglo/postgres';
import { createOrderRoutingWorkflow, validateOrderEvent, type OrderEvent } from './workflow';
import { database, groupId, kafka, outcomeWriter, topic } from './infrastructure';

// Excerpt from the worker's async startup function.
const pool = database();
const shutdown = new AbortController();
const workflow = createOrderRoutingWorkflow(outcomeWriter(pool, 'orders-worker'));
const consumer = kafka('orders-worker').consumer({ groupId });
const idempotencyStore = new PostgresIdempotencyStore({ client: pool });

// This adapter turns each Kafka record into a Siglo workflow execution.
const handler = createKafkaMessageHandler<OrderEvent>(workflow, {
    groupId,
    idempotencyStore,
    idempotencyTtlMs: 60000,
    timeout: 10000,
    heartbeatIntervalMs: 1000,
    signal: shutdown.signal,
    idempotencyKey: message => String(message.headers?.['event-id'] ?? getKafkaRecordId(message)),
    input: message => ({
        ...JSON.parse(String(message.value)),
        tenant: String(message.headers?.['x-namespace'] || 'shop-demo'),
    }),
    validate: (event, message) => {
        validateOrderEvent(event);
        if (message.headers?.['event-id'] !== undefined && String(message.headers['event-id']) !== event.eventId) {
            throw new Error('event-id header must match eventId');
        }
    },
    // The full worker also configures retry and deadLetter below.
});

await consumer.connect();
await consumer.subscribe({ topic, fromBeginning: true });
await consumer.run({
    partitionsConsumedConcurrently: 2,
    eachMessage: handler, // The handler returned by @siglo/kafka.
});
```

The initializer has already called `idempotencyStore.ensureTable()` before the workers start. The complete [worker.ts](../examples/src/kafka-order-routing/worker.ts) also connects a producer for dead-letter publication, attaches monitoring, and wires shutdown to `shutdown.abort()`.

| Responsibility                                                                                                                                       | Supplied by       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Broker connection, subscriptions, consumer groups, partitions, and offset commits                                                                    | KafkaJS           |
| Input mapping and validation, idempotency claims, heartbeats during processing, bounded retries, cancellation, and awaiting the dead-letter callback | `@siglo/kafka`    |
| Persisting shared claims and cached outcomes                                                                                                         | `@siglo/postgres` |
| Executing named steps and selecting `branch` / `when` paths                                                                                          | `@siglo/core`     |

The event header provides **business-event deduplication across offsets**. The adapter automatically scopes that identity by `groupId` and `x-namespace`, so independent groups and tenants do not suppress one another's work.

The Kafka key has a different purpose: `orderId` chooses the partition. Using that entity key for deduplication would incorrectly suppress a later cancellation event for the same order.

If you omit the custom `idempotencyKey`, the adapter deduplicates by topic, partition, and offset. That handles redelivery of one record, but a second published record with a new offset is a distinct event.

---

## 4. Walk Through the Decisions in the Live Monitor

Open **http://127.0.0.1:4300** before publishing. Worker events travel through their own Redis channel to this monitor process. The workers set the same emitter as both the root flow's monitor and the default monitor, so nested branch targets also report their named steps.

Try one scenario at a time:

```bash
docker compose -f examples/kafka-order-routing/docker-compose.yml exec worker-a \
  node --import tsx examples/src/kafka-order-routing/publish.ts standard

docker compose -f examples/kafka-order-routing/docker-compose.yml exec worker-a \
  node --import tsx examples/src/kafka-order-routing/publish.ts review
```

For the standard order, inspect the selected `order.placed` route, the fulfillment path, and the absent `wrapGift` action. For the review order, inspect `queueReview` and confirm that payment and shipping did not execute. Use the `gift` scenario to compare the optional step's true path.

The monitor's graph shows the complete workflow definition: labeled `branch` routes and `when` then/else paths, including the skip path. Selected routes are green and untaken routes are dimmed; a false `when` without an else action highlights “Continue without action” before continuing to the next step. Conditional routes reconnect directly without an extra join card. Executed steps display their live status and timing. Click an executed step for its details. The same view shows parallel fan-out and fan-in, race joins labeled “First result,” and map item processing templates.

These screenshots show real events processed by the Docker example through Kafka, the workers, PostgreSQL, and Redis. Each view focuses on the relevant decision, with the selected step's details visible on the right. Execution IDs and timings will differ on your machine.

### Standard: Skip Gift Wrapping and Ship

The optional `when` takes its green `else` path through **Continue without action** to `shipOrder`. The dimmed `wrapGift` step is marked **Not taken**, while the details panel confirms that shipping completed.

![Live monitor showing a standard order taking the green else bypass around gift wrapping and completing shipOrder, with shipping details on the right](assets/kafka-order-routing/standard.png)

### Gift: Take the Optional Step

With `giftWrap: true`, the same decision takes the green `then` path through `wrapGift` before shipping. Selecting `wrapGift` keeps its status, duration, and attempt count beside the graph.

![Live monitor showing a gift order taking the green then route through wrapGift to shipOrder, with wrapGift selected and its details on the right](assets/kafka-order-routing/gift.png)

### Review: Route a High-Value Order Away from Fulfillment

The `order.placed` route reaches the first `when`, which selects `queueReview`. Payment and shipping remain on the dimmed, untaken fulfillment path. This run completes with `review-required`; it is not suspended for approval.

![Live monitor showing a high-value order routed through order.placed and then to queueReview, with fulfillment dimmed and review step details on the right](assets/kafka-order-routing/review.png)

### Cancel: Choose a Different Event Branch

An `order.cancelled` event goes directly to `recordCancellation`. The placed-order decision tree stays dimmed because none of its fulfillment steps run.

![Live monitor showing the green order.cancelled branch reaching recordCancellation, with the placed-order tree dimmed and cancellation details on the right](assets/kafka-order-routing/cancel.png)

The [unsupported-event screenshot below](#6-unsupported-events-invalid-input-and-dead-letters) shows how the same graph exposes a failed fallback and its error details.

The outcome's `actions` array provides a simple, persisted record of the demo path. Graph connections describe possible control flow, not proof that every route ran. This example enables observation but disables remote resumption; it has no suspended runs to resume. Rebuild the Compose image after updating the monitor UI or runtime so workers and the dashboard use the updated graph metadata.

Kafka offsets and PostgreSQL claims survive worker restarts. The monitor's run history is held in memory, and Redis Pub/Sub does not replay old monitoring events after a monitor restart.

---

## 5. Replay an Event After Both Consumers Restart

Publish a standard order with explicit event and order IDs:

```bash
docker compose -f examples/kafka-order-routing/docker-compose.yml exec worker-a \
  node --import tsx examples/src/kafka-order-routing/publish.ts standard replay-1001 order-1001
```

Wait until `replay-1001` appears in `/results`. Restart both consumers, then publish the same business event again:

```bash
docker compose -f examples/kafka-order-routing/docker-compose.yml restart worker-a worker-b

docker compose -f examples/kafka-order-routing/docker-compose.yml exec worker-a \
  node --import tsx examples/src/kafka-order-routing/publish.ts standard replay-1001 order-1001
```

Kafka assigns the second record a new offset. The shared PostgreSQL claim is already completed for this group, tenant, and event ID, so the adapter returns the cached result without running fulfillment again. The result's `executions` stays at one.

Now publish a distinct cancellation event for the same entity:

```bash
docker compose -f examples/kafka-order-routing/docker-compose.yml exec worker-a \
  node --import tsx examples/src/kafka-order-routing/publish.ts cancel cancellation-1001 order-1001
```

This has the same Kafka key but a different event ID. It takes the cancellation branch and creates a second outcome. Cancellation here records a request; the fake demo does not implement refunds, warehouse cancellation, or a complete order state machine.

Use fresh event IDs when repeating the walkthrough with different data. A completed business-event ID represents the original event, not permission to change its payload and execute again.

---

## 6. Unsupported Events, Invalid Input, and Dead Letters

Try both failure paths:

```bash
docker compose -f examples/kafka-order-routing/docker-compose.yml exec worker-a \
  node --import tsx examples/src/kafka-order-routing/publish.ts unsupported

docker compose -f examples/kafka-order-routing/docker-compose.yml exec worker-a \
  node --import tsx examples/src/kafka-order-routing/publish.ts invalid

curl -s http://127.0.0.1:3300/dead-letters
```

The worker retries eligible workflow failures up to two attempts, with a short delay. Unsupported event types are permanent errors and do not retry. Parsing or validation failures happen before any workflow attempt.

Its `deadLetter` callback awaits publication to `tutorial.orders.dead-letter`, then saves a local audit row. Only after that callback succeeds does the adapter consider the failed record handled. If publication or audit persistence fails, processing rejects and Kafka may redeliver the record.

Inspect the real dead-letter topic with Kafka's console consumer:

```bash
docker compose -f examples/kafka-order-routing/docker-compose.yml exec kafka \
  kafka-console-consumer --bootstrap-server kafka:9092 \
  --topic tutorial.orders.dead-letter --from-beginning --max-messages 2
```

With a fresh stack and the two commands above, expect one unsupported-event record with `attempts: 1` and one malformed-JSON record with `attempts: 0`. On a reused stack, the command can also show earlier dead letters.

The unsupported event creates a failed workflow run in the monitor even though its Kafka record is later quarantined successfully. Malformed JSON does not create a workflow run because parsing fails first.

### Unsupported: Inspect the Failed Fallback

The green `default` connection identifies the selected route; the red `rejectUnsupported` step and failed run status identify its outcome. Its details panel shows `UnsupportedOrderEvent: Unsupported event type: order.refunded`. Selecting a route does not mean that its action succeeded.

![Live monitor showing an unsupported order.refunded event taking the default route into the failed rejectUnsupported step, with its error and stack trace in the right-hand details panel](assets/kafka-order-routing/unsupported.png)

### Invalid: Rejected Before a Workflow Exists

The `invalid` scenario sends malformed JSON. There is no DAG or step-details screenshot for this case: the adapter rejects the record before starting the workflow, so the monitor's run count does not increase. Inspect `/dead-letters` or `tutorial.orders.dead-letter` instead; the record has `attempts: 0`. This differs from the unsupported event above, whose workflow starts and fails with `attempts: 1`.

---

## 7. Test the Tutorial

After installing repository dependencies and building `@siglo/core`, run the routing tests without Docker:

```bash
node --import tsx --test examples/src/kafka-order-routing/workflow.test.ts
```

They assert the exact selected actions, the high-value boundary, optional gift wrapping, the explicit fallback, and input validation. They also verify that an unsupported event never reaches `saveOutcome`.

With the stack running:

```bash
sh examples/kafka-order-routing/smoke.sh
```

The smoke check uses fresh event IDs and verifies actual Kafka delivery, four successful routing outcomes, two dead-letter records, Redis monitoring, and shared PostgreSQL deduplication after restarting both workers. It waits for the duplicate record's Kafka offset to advance before checking that the workflow execution count stayed at one.

---

## 8. What This Example Guarantees

- Records within a partition are processed in order by KafkaJS; different partitions can run concurrently. The group distributes partitions, so events are not assigned to workers in round-robin event order.
- Each chosen flow runs in-process. Worker failure restarts record processing; this adapter does not resume a partially completed workflow checkpoint.
- Completed claims can skip repeated business-event IDs across replicas. Claims are separate from business database writes and external provider effects; they do not make those effects atomic.
- The 10-second processing budget fits within the 60-second claim budget. The adapter cancels before claim expiry and retains uncertain claims after cancellation. External clients still need to honor cancellation and deduplicate effects.
- An accepted Kafka send is not proof that the workflow has completed. Inspect the persisted result, monitor, or another application-level completion channel.
- A dead-letter send and claim completion are separate writes. A crash between them can publish a duplicate dead letter; its stable `recordId` is available for downstream deduplication.

The result table's `executions` field is a demo audit counter, not an exactly-once business-effects mechanism. For database changes that must reliably publish follow-up Kafka events, use an application transaction and an outbox. Built-in outbox support and a separate tutorial are [recorded for later](/roadmap/kafka-outbox.roadmap).

For producer-to-consumer traces and provisioned Grafana metrics using a separate APM example with the same routing model, continue with [Zero-Code APM Dashboards](/zero-code-apm-dashboards).

Continue with the [Kafka adapter reference](/adapters/kafka), [branching and parallelism guide](/04-branching-and-parallelism), or the [durable checkout tutorial](/durable-distributed-checkout) when an event path needs a persisted wait.

To authenticate the HTTP producers feeding an order stream, continue with [Accept Asymmetrically Signed Orders](/signed-order-intake), using `@siglo/crypto` and `@siglo/express` in an independent example.
