---
title: 'Migrate 1 Endpoint in 5 Minutes'
description: 'Incremental adoption guide: wrap existing TypeScript service functions in Siglo steps without rewriting your codebase.'
---

You do not need to re-architect your application, deploy new infrastructure, or rewrite your existing business logic to adopt **Siglo**. Because Siglo runs in-process as a standard TypeScript library, the fastest path to adoption is migrating **one brittle endpoint**—such as checkout, user onboarding, or webhook processing—in under 5 minutes.

**Running from this repository?** A self-contained runnable comparison of this guide lives in [`examples/src/migrate-one-endpoint/migrate-one-endpoint.ts`](https://github.com/jsoftgem/siglo/blob/main/examples/src/migrate-one-endpoint/migrate-one-endpoint.ts). Execute it directly from the repository root with:

```bash
npm run demo:migrate-endpoint --workspace=siglo-examples
# or directly via tsx:
npx tsx examples/src/migrate-one-endpoint/migrate-one-endpoint.ts
```

---

## 1. Before: A Typical Express Controller with Manual Plumbing

Most backend endpoints start simple and gradually accumulate retry loops, manual rollback state flags, and nested `try/catch` blocks:

```typescript
// routes/checkout.ts (Before)
import express from 'express';
import { inventoryService, paymentService, shippingService } from '../services';

const router = express.Router();

router.post('/api/checkout', async (req, res, next) => {
    const { orderId, sku, quantity, amountCents } = req.body;
    let reservationId: string | undefined;
    let paymentId: string | undefined;

    try {
        // 1. Reserve inventory
        reservationId = await inventoryService.reserve({ orderId, sku, quantity });

        // 2. Charge payment with ad-hoc retry loop
        for (let attempt = 1; ; attempt++) {
            try {
                paymentId = await paymentService.charge({ orderId, amountCents });
                break;
            } catch (err) {
                if (attempt >= 3) throw err;
                await new Promise(r => setTimeout(r, 200 * 2 ** attempt));
            }
        }

        // 3. Create shipment
        const trackingId = await shippingService.dispatch({
            orderId,
            reservationId,
            paymentId,
        });

        return res.status(200).json({ orderId, reservationId, paymentId, trackingId });
    } catch (err) {
        // Manual reverse-order rollback
        if (paymentId) {
            try {
                await paymentService.refund(paymentId);
            } catch {
                // ignore rollback failure
            }
        }
        if (reservationId) {
            try {
                await inventoryService.release(reservationId);
            } catch {
                // ignore rollback failure
            }
        }
        return next(err);
    }
});
```

---

## 2. Step-by-Step Migration (Zero Service Changes)

Notice that `inventoryService`, `paymentService`, and `shippingService` are ordinary async TypeScript modules. **Do not change them.** Instead, wrap each call in `Step.create()` and attach its retry and rollback policy directly to the step.

### Step A: Install `@siglo/core`

```bash
npm install @siglo/core
```

_(Optional)_ Install the route adapter for your HTTP framework (`@siglo/express`, `@siglo/fastify`, or `@siglo/hono`):

```bash
npm install @siglo/express
```

### Step B: Wrap Your Existing Service Calls in `Step.create`

Create `workflows/checkout.workflow.ts`:

```typescript
// workflows/checkout.workflow.ts
import { Step, flow } from '@siglo/core';
import { inventoryService, paymentService, shippingService } from '../services';

export interface CheckoutInput {
    orderId: string;
    sku: string;
    quantity: number;
    amountCents: number;
}

// 1. Wrap inventory reservation + attach its rollback compensation
const reserveStock = Step.create('reserveStock', async (input: CheckoutInput) => {
    const reservationId = await inventoryService.reserve(input);
    return { reservationId };
}).compensate(async ctx => {
    await inventoryService.release(ctx.reservationId);
});

// 2. Wrap payment charge + declarative retry backoff + refund compensation
const chargeCustomer = Step.create('chargeCustomer', async ({ orderId, amountCents }) => {
    const paymentId = await paymentService.charge({ orderId, amountCents });
    return { paymentId };
})
    .onFail({ maxRetries: 3, backoff: 'exponential', delay: 200, jitter: 'full' })
    .compensate(async ctx => {
        await paymentService.refund(ctx.paymentId);
    });

// 3. Wrap shipment creation (receives reservationId & paymentId with full static type inference)
const createShipment = Step.create('createShipment', async ({ orderId, reservationId, paymentId }) => {
    const trackingId = await shippingService.dispatch({
        orderId,
        reservationId,
        paymentId,
    });
    return { trackingId };
});

export const checkoutWorkflow = flow(reserveStock, chargeCustomer, createShipment).timeout(10_000);
```

### Step C: Call the Flow from Your Route Handler

You can either invoke `checkoutWorkflow.run()` directly inside your existing controller or mount it as a one-liner using `@siglo/express`, `@siglo/fastify`, or `@siglo/hono`:

```typescript
// Option 1: Direct invocation inside any controller (Express, NestJS, Next.js Server Action)
router.post('/api/checkout', async (req, res, next) => {
    try {
        const result = await checkoutWorkflow.run(req.body, {
            signal: req.signal, // Cooperatively aborts in-flight steps on client disconnect
            idempotencyKey: req.headers['idempotency-key'] as string | undefined,
        });
        return res.status(200).json(result);
    } catch (err) {
        return next(err);
    }
});

// Option 2: One-line Express middleware adapter (@siglo/express)
import { sigloExpressMiddleware } from '@siglo/express';

router.post('/api/checkout', sigloExpressMiddleware(checkoutWorkflow, { timeout: 10_000 }));
```

---

## 3. What You Just Gained (With Zero New Infrastructure)

By migrating that single endpoint:

1. **Guaranteed LIFO Rollbacks**: If `createShipment` fails, `chargeCustomer` refunds the payment first, and `reserveStock` releases the inventory second.
2. **Instant Architecture Diagrams in PRs**: Run `npx @siglo/cli export workflows/checkout.workflow.ts --format=mermaid` to generate an up-to-date Mermaid diagram with retry, timeout, and saga badges.
3. **Deterministic Unit Tests in `<5ms`**: Test retries and rollbacks deterministically without hitting real APIs or waiting on real timers using [`@siglo/testing`](/09-testing-and-replay) (`createWorkflowHarness`, `FakeClock`, `mockStep`).
4. **Drop-In Observability**: Add [`@siglo/monitor`](/live-monitoring) for a live local DevTools waterfall (`http://localhost:4000`) or [`@siglo/opentelemetry`](/08-observability) for automatic step-level spans in Jaeger, Grafana, or Datadog.
