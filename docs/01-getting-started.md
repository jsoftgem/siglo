# 01. Getting Started: Build a Checkout That Handles Failure

An online shop needs to reserve stock, charge a customer, and arrange delivery. The happy path is three service calls. The difficult part starts when a payment gateway is temporarily unavailable or a courier rejects a shipment after the customer has paid.

In this tutorial, we’ll build that checkout with **Siglo**, a TypeScript workflow library that runs inside your Node.js application. We’ll retry a temporary payment failure, undo completed work when shipping fails, and test both outcomes. The demo uses fake services, so you can run it without accounts, API keys, Docker, or a database.

By the end, you’ll know what a step is, how data moves between steps, and where a workflow library helps in an ordinary backend.

## 1. The Problem: A Few Service Calls Become Recovery Logic

A first checkout implementation often looks like this sketch:

```typescript
// Pseudocode: inventory, payments, and shipping represent your service clients.
const reservation = await inventory.reserve(order);
const payment = await payments.charge(order);
const shipment = await shipping.create(order, reservation, payment);
```

Now consider what can go wrong:

| What happens? | What the application needs to do |
|---|---|
| Payment gateway is unavailable before accepting a charge | Retry payment without reserving stock again |
| Card is declined | Stop and release reserved stock |
| No courier is available after payment succeeds | Refund payment, then release stock |
| Customer submits the same checkout twice | Recognize the same request and reuse a completed result |

You can implement these rules with functions, loops, and `try/catch`. Siglo becomes useful when those rules repeat across business processes: each operation becomes a named **step**, and a **flow** defines their order. Retry and recovery policies live beside the operation they belong to.

This is still your application calling your services. Siglo coordinates those calls; your inventory system, payment provider, and database remain responsible for their own records.

## 2. Set Up a Small Project

Use Node.js `^22.13.0 || >=24.0.0` and TypeScript 5 or later. In an empty directory, run:

```bash
mkdir siglo-checkout
cd siglo-checkout
npm init -y
npm install @siglo/core
npm install --save-dev typescript tsx @types/node
```

The files below use the CommonJS default created by `npm init -y`; `tsx` runs the TypeScript directly. No build configuration is needed for this demo.

**Already working in this repository?** The completed files are in [`examples/src/getting-started`](../examples/src/getting-started). With the repository dependencies installed, build core and run:

```bash
npm run build --workspace=@siglo/core
node --import tsx examples/src/getting-started/checkout-demo.ts
node --import tsx --test examples/src/getting-started/checkout.test.ts
```

## 3. Define the Checkout

Create `checkout.ts` with the following code. The service interface describes the business operations without tying the workflow to a particular provider. This lets us use fake services now and real API clients later.

```typescript
import { Step, flow } from '@siglo/core';

export interface Order {
    orderId: string;
    sku: string;
    quantity: number;
    amountCents: number;
}

export interface CheckoutServices {
    reserve(order: Order): Promise<string>;
    release(reservationId: string): Promise<void>;
    charge(order: Order): Promise<string>;
    refund(paymentId: string): Promise<void>;
    ship(order: Order & { reservationId: string; paymentId: string }): Promise<string>;
}

export class TemporaryPaymentError extends Error {}

export function createCheckout(services: CheckoutServices) {
    const validateOrder = Step.create('validateOrder', (order: Order) => {
        if (!order.orderId || !order.sku || !Number.isInteger(order.quantity) || order.quantity < 1
            || !Number.isSafeInteger(order.amountCents) || order.amountCents < 1) {
            throw new Error('An order needs an ID, SKU, positive quantity, and amount in cents');
        }
        return { validated: true };
    });

    const reserveStock = Step.create('reserveStock', async (order: Order) => ({
        reservationId: await services.reserve(order)
    })).compensate(async (output: { reservationId: string }) => {
        await services.release(output.reservationId);
    });

    const chargePayment = Step.create('chargePayment', async (order: Order) => ({
        paymentId: await services.charge(order)
    })).onFail({
        maxRetries: 2,
        delay: 10,
        backoff: 'exponential',
        retryIf: (error) => error instanceof TemporaryPaymentError
    }).compensate(async (output: { paymentId: string }) => {
        await services.refund(output.paymentId);
    });

    const arrangeShipping = Step.create('arrangeShipping', async (
        order: Order & { reservationId: string; paymentId: string }
    ) => ({
        trackingId: await services.ship(order)
    }));

    return flow(validateOrder, reserveStock, chargePayment, arrangeShipping);
}
```

Let’s unpack the parts that matter.

### A step receives context and returns new fields

`Step.create('reserveStock', action)` gives an operation a name. Its action receives the order and returns `{ reservationId }`.

Siglo adds returned fields to the accumulated context. Later steps can read both the original order and earlier results:

| After this step | Fields available to later steps |
|---|---|
| `validateOrder` | Original order fields, `validated` |
| `reserveStock` | Everything above, `reservationId` |
| `chargePayment` | Everything above, `paymentId` |
| `arrangeShipping` | Everything above, `trackingId` |

Return the fields you produce instead of mutating the input. Prefer distinct names such as `paymentId` and `trackingId` so separate operations don’t accidentally overwrite one another’s data.

### A flow defines the business sequence

The last line, `flow(validateOrder, reserveStock, chargePayment, arrangeShipping)`, says what happens and in which order. It doesn’t call the services until we run the flow.

The validation step runs first, so an invalid order fails before stock is reserved. A step failure stops forward execution unless its failure policy recovers.

### Retry only the operation that can recover

The payment step uses `.onFail(...)` to retry `TemporaryPaymentError`. `maxRetries: 2` allows an initial attempt plus up to two retries, with exponential backoff starting at 10 milliseconds. The short delay keeps this local demo quick; choose delays appropriate to the provider in a real integration.

The predicate matters: a declined card won’t become valid after another attempt. It should stop the checkout instead. Our fake gateway fails before accepting the first charge; an ambiguous network timeout after a provider accepts payment needs provider-side idempotency and reconciliation, discussed below.

### Compensation undoes completed business operations

`.compensate(...)` registers a recovery action for a successfully completed step. If shipping fails after payment succeeds, Siglo calls the payment compensation to refund the charge, then the stock compensation to release the reservation.

That reverse order is called a **saga**. It’s useful when several independent services cannot share a database transaction. A refund is a new business operation, so the original charge can still appear in the customer’s payment history.

If payment fails before completing, only the stock reservation needs compensation. The payment step has no successful output to refund.

### Explore the workflow in your IDE

Siglo provides extensions for [VS Code](../plugins/vscode/README.md) and [IntelliJ IDEA](../plugins/intellij/README.md). They turn JavaScript and TypeScript workflow definitions into interactive graphs without executing your application. You can inspect step input contracts, retries, timeouts, and compensation policies, click steps to navigate to their source, and refresh the graph as you edit with **Auto-Reload**. Use **All Flows** to explore multiple workflows in one file.

Follow the linked guides to build and install the VS Code VSIX or IntelliJ plugin ZIP, including each IDE’s analyzer requirements. Open and trust your project, then open `checkout.ts`:

- **VS Code:** open the Command Palette and run **Siglo: Open Workflow Visualizer**.
- **IntelliJ IDEA:** right-click the editor and choose **Visualize Siglo Workflow**, or open **View → Tool Windows → Siglo Workflows**.

The graph shows the workflow’s declared structure and policies. To inspect actual runs, retries, and failures, continue with [Serve a REST Endpoint and Watch It Run Live](rest-and-live-monitoring.md).

## 4. Run the Happy Path and a Failure

Create `checkout-demo.ts` alongside `checkout.ts`:

```typescript
import { createCheckout, TemporaryPaymentError } from './checkout';
import type { CheckoutServices, Order } from './checkout';

export function createDemoServices(failShipping = false) {
    const events: string[] = [];
    let paymentAttempts = 0;

    const services: CheckoutServices = {
        async reserve(order) {
            events.push('reserve stock');
            return `reservation-${order.orderId}`;
        },
        async release() { events.push('release stock'); },
        async charge(order) {
            paymentAttempts++;
            events.push(`charge attempt ${paymentAttempts}`);
            if (paymentAttempts === 1) {
                // Simulate an unavailable gateway BEFORE it accepts a charge.
                throw new TemporaryPaymentError('Payment gateway unavailable');
            }
            return `payment-${order.orderId}`;
        },
        async refund() { events.push('refund payment'); },
        async ship(order) {
            events.push('arrange shipping');
            if (failShipping) throw new Error('No courier available');
            return `tracking-${order.orderId}`;
        }
    };

    return { services, events };
}

export const sampleOrder: Order = {
    orderId: 'order-1001', sku: 'coffee-kit', quantity: 1, amountCents: 4500
};

async function main() {
    for (const failShipping of [false, true]) {
        const { services, events } = createDemoServices(failShipping);
        const checkout = createCheckout(services);
        console.log(failShipping ? 'Shipping failure:' : 'Successful checkout:');
        try {
            const result = await checkout.run(sampleOrder, { pojo: true });
            console.log(result.trackingId);
        } catch (error) {
            console.log(error instanceof Error ? error.message : String(error));
        }
        console.log(events.join(' -> '));
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
```

Run it:

```bash
node --import tsx checkout-demo.ts
```

Expected output:

```text
Successful checkout:
tracking-order-1001
reserve stock -> charge attempt 1 -> charge attempt 2 -> arrange shipping
Shipping failure:
No courier available
reserve stock -> charge attempt 1 -> charge attempt 2 -> arrange shipping -> refund payment -> release stock
```

On the first run, payment recovers on its second attempt. Stock is reserved once, and shipping proceeds. `result.trackingId` is available directly because `.run(..., { pojo: true })` returns plain object context.

On the second run, shipping fails. The log shows the refund before the stock release. The flow still rejects after successful compensation: recovery cleaned up the partial checkout, but the order was never fulfilled.

Each demo run creates fresh fake services. The attempt counter and event log exist only to make the behavior visible; real integrations would use your service clients and their persistent records. In production, calculate the amount from trusted catalog or order data before charging a customer.

## 5. Test the Recovery Rule

A useful checkout test checks the business outcome, including cleanup order. Create `checkout.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCheckout } from './checkout';
import { createDemoServices, sampleOrder } from './checkout-demo';

test('refunds payment before releasing stock when shipping fails', async () => {
    const { services, events } = createDemoServices(true);

    await assert.rejects(
        createCheckout(services).run(sampleOrder, { pojo: true }),
        /No courier available/
    );
    assert.deepEqual(events, [
        'reserve stock', 'charge attempt 1', 'charge attempt 2', 'arrange shipping',
        'refund payment', 'release stock'
    ]);
});
```

Run it with Node’s test runner:

```bash
node --import tsx --test checkout.test.ts
```

The [complete test file](../examples/src/getting-started/checkout.test.ts) also checks payment recovery, invalid orders, permanent payment failure, and duplicate completed requests. Because services are passed into `createCheckout`, tests can substitute behavior without contacting external APIs.

For step spies, recorded traces, and replay tools, continue with [Testing and Replay](09-testing-and-replay.md).

## 6. Handle a Duplicate Checkout Request

Retries inside a step and duplicate incoming requests are separate problems. A browser can submit twice even when every service call succeeds.

At the application boundary, give repeated submissions of the same logical checkout a stable idempotency key. With a `checkout` created as above, these two calls illustrate reuse of a completed result:

```typescript
const options = {
    pojo: true,
    namespace: 'shop-demo',
    idempotencyKey: `checkout:${sampleOrder.orderId}`,
    idempotencyTtlMs: 60 * 60 * 1000
};

const first = await checkout.run(sampleOrder, options);
const second = await checkout.run(sampleOrder, options);
// The second successful request reuses the completed workflow result.
```

Use the same key only for the same logical request. If the cart changes, validate the request against the stored order and define whether it represents a new checkout.

The default idempotency store is in memory. For multiple application instances or restarts, configure a shared persistent store such as [PostgreSQL](adapters/postgres.md) or [Redis](adapters/redis.md).

Workflow deduplication also cannot close the gap between “the payment provider accepted the charge” and “the application recorded success.” Pass a stable provider-supported idempotency key to the actual payment API, and reconcile unknown outcomes before charging again. See [Idempotency and Deduplication](idempotency.md) for store configuration and step-level policies.

## 7. Apply the Same Idea to Other Problems

Checkout is one example. Look for a business operation with several stages and explicit rules for failure or waiting.

| Real-world problem | Where Siglo helps | Continue with |
|---|---|---|
| A travel booking reserves a flight, then fails to book a hotel | Attach cancellation actions to completed reservations and compensate in reverse order | [Travel booking example](../examples/src/workflow/usecases/usecase-11-distributed-saga-compensation.ts) |
| An expense claim waits for a manager’s decision | Suspend at an event wait, persist the checkpoint, and resume when a verified approval arrives | [Durable workflows](06-durable-workflows.md) |
| A document import overloads an embedding service when every item runs at once | Use bounded `map` concurrency to limit active work | [Batch ingestion example](../examples/src/workflow/usecases/usecase-12-bounded-batch-mapping.ts) |
| A Kafka message needs validation, customer enrichment, and an audit write | Reuse named steps inside a consumer, with retry and deduplication policies | [Kafka adapter](adapters/kafka.md) |
| A support assistant needs structured model output and an alternate provider on failure | Compose AI steps with output validation and fallback policies | [AI adapter](adapters/ai.md) |

For durable approvals, persistence and resumption must be configured explicitly. If a wait needs to expire while no worker is running it, configure a [scheduler](adapters/scheduler.md) or an external dispatch mechanism. An in-memory demo does not survive a process restart.

## 8. Decide Whether Siglo Fits

Siglo fits when an application needs reusable business steps with retries, compensation, branching, or waits, and you want to define those rules in TypeScript inside the existing service.

A single database transaction should usually stay a database transaction. A short function with no recovery rules can stay a function. A queue still handles delivery and worker scheduling; Siglo can coordinate the operations inside its consumer.

For this checkout, the next production work is concrete: replace fake clients, add provider idempotency, configure shared storage where required, and observe failures. If a refund itself fails, handle the reported compensation failure and arrange reconciliation; registering a handler does not guarantee that an external refund succeeds. Start with [Compensation and Sagas](compensation-and-sagas.md), then [Production Operations](11-production-operations.md).

## 9. Where to Go Next

- [Serve a REST Endpoint and Watch It Run Live](rest-and-live-monitoring.md): expose this checkout through Express and inspect successful and failed requests.

- [Core Concepts](02-core-concepts.md): context, step lifecycle, and execution options.
- [Branching and Parallelism](04-branching-and-parallelism.md): conditional routes and concurrent work.
- [Retries, Timeouts, and Cancellation](05-retries-timeouts-and-cancellation.md): deadlines and cooperative cancellation for real clients.
- [Observability](08-observability.md): inspect and visualize what ran.
- [Runnable Examples](../examples/README.md): adapt a workflow close to your own use case.
