---
title: 'Express Adapter'
description: 'Express middleware adapter for executing Siglo workflows with correlation propagation, cancellation, and semantic status code mapping.'
---

# @siglo/express Adapter Guide

For a complete walkthrough, see [Serve a REST Endpoint and Watch It Run Live](/rest-and-live-monitoring).

`@siglo/express` provides an Express middleware adapter for executing `Siglo` workflows within traditional Node.js web applications. It automates HTTP request extraction, correlation identifier propagation, cooperative cancellation, timeout enforcement, and semantic error-to-HTTP status code mapping.

---

## 1. Overview & Architecture

The Express adapter acts as a route-level or path-level middleware:

```mermaid
flowchart TD
    Req["HTTP Request (Client)"] --> MW["sigloExpressMiddleware<br/>• Extract Correlation ID (Set X-Correlation-Id header)<br/>• Extract Input (body / query)<br/>• Partition Namespace Scope<br/>• Extract req.signal (Abort)"]
    MW --> WF["Siglo Workflow<br/>• Validations & Computations<br/>• Cooperative Cancellation<br/>• Distributed Steps & Sagas"]
    WF -->|Success| Success["Set Stack ID<br/>200 OK / Custom JSON"]
    WF -->|Waiting| Waiting["Set Stack ID<br/>202 Accepted / Suspension JSON"]
    WF -->|Error| Error["getErrorStatusCode(err)<br/>• 504 Gateway Timeout<br/>• 400 Bad Request<br/>• 409 Conflict<br/>• 499 Client Closed Req<br/>• 500 Server Error"]
```

---

## 2. Installation & Requirements

Install `@siglo/express` and `Siglo`:

```bash
npm install @siglo/core @siglo/express express
npm install --save-dev @types/express
```

Peer dependency matrix:

- `Siglo`: `*` (v1.0.0+)
- `express`: `^4.18.0 || ^5.0.0`

---

## 3. API Reference

### `sigloExpressMiddleware(workflow, options)`

> [!NOTE]
> **Backward Compatibility**:
> `rivuletExpressMiddleware` is exported as an identical alias for legacy workflows.

Returns a standard Express middleware function `(req, res, next) => Promise<any>`.

```typescript
function sigloExpressMiddleware<TInput = any, TOutput = any, TReq = any>(
    workflow: Flow<TInput, TOutput>,
    options?: SigloExpressOptions<TReq, TInput, TOutput>,
): (req: any, res: any, next: (err?: any) => void) => Promise<any>;
```

---

## 4. Configuration Options (`SigloExpressOptions`)

| Option                 | Type                                                         | Default                                 | Description                                                                                                                              |
| :--------------------- | :----------------------------------------------------------- | :-------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `input`                | `(req: TReq) => Promise<TInput> \| TInput`                   | `req.body \|\| req.query`               | Custom mapping function from `Request` to workflow input parameters.                                                                     |
| `output`               | `(result: TOutput, res: Response) => Promise<any> \| any`    | `res.json(result)`                      | Custom responder to set custom status codes, headers, or response shapes.                                                                |
| `timeout`              | `number`                                                     | `undefined`                             | Execution timeout in milliseconds. Throws `StepTimeoutException` / `FlowTimeoutException` if exceeded.                                   |
| `durable`              | `boolean \| ((req: TReq) => boolean)`                        | `undefined`                             | Enables durable suspension, either for every request or through a request-specific resolver.                                             |
| `namespace`            | `string \| ((req: TReq) => string \| undefined)`             | `undefined`                             | Namespace string or extractor function for tenant data partitioning.                                                                     |
| `allowHeaderNamespace` | `boolean`                                                    | `false`                                 | When true, permits extracting tenant namespace from incoming `x-namespace` headers. Keep disabled when client requests are untrusted.    |
| `exposeErrorDetails`   | `boolean`                                                    | `process.env.NODE_ENV !== 'production'` | Controls whether 500 error messages expose internal details. In production, a generic `'Internal workflow execution error'` is returned. |
| `onError`              | `(err: any, req: TReq, res: any, next: NextFunction) => any` | Default JSON handler                    | Custom error responder. If omitted, maps status codes and returns sanitized `{ error: message }`.                                        |
| `correlationIdHeader`  | `string`                                                     | `'x-correlation-id'`                    | Header name to inspect for incoming correlation IDs.                                                                                     |

Without a custom `output` callback, a workflow result with `status: 'waiting'` returns **202 Accepted** with the suspension descriptor as JSON. Completed workflows use the normal **200 OK** response. Suspension is a successful result and does not invoke `onError`. A custom `output` callback controls both the response body and status.

When `durable` is omitted, Express also accepts `X-Durable: true`, `?durable=true`, or a JSON body containing `durable: true`. An explicit `durable: false` overrides these request hints.

---

## 5. Built-in Headers & Tracing

The middleware automatically enriches HTTP headers:

- **`X-Correlation-Id`**: Inspects incoming request headers (matching `correlationIdHeader` or `x-request-id`). If present, the value is mirrored in the outgoing response header `X-Correlation-Id`.
- **`X-Workflow-Stack-Id`**: Upon workflow completion or suspension, injects the unique execution stack ID into the response headers. Useful for log correlation and customer support triage.

---

## 6. HTTP Error Status Code Mapping

When an unhandled exception is thrown inside a workflow, the adapter's `getErrorStatusCode(err)` inspects the error hierarchy and sets appropriate HTTP status codes:

| Error Name / Type                               | HTTP Status Code            | Description                                                  |
| :---------------------------------------------- | :-------------------------- | :----------------------------------------------------------- |
| `StepTimeoutException` / `FlowTimeoutException` | `504 Gateway Timeout`       | Step or workflow timeout SLA was exceeded.                   |
| `ValidationException` / `SpecFailedException`   | `400 Bad Request`           | Input schema, parameter, or contract validation failed.      |
| `IdempotencyConflictException`                  | `409 Conflict`              | Concurrent claim detected on an in-progress idempotency key. |
| `CancellationException` / `AbortError`          | `499 Client Closed Request` | Client terminated connection or request was cancelled.       |
| `CompensationException` / Generic `Error`       | `500 Internal Server Error` | Unexpected runtime error or failed saga compensation.        |

---

## 7. Cooperative Request Cancellation

When a client closes an HTTP connection early (e.g. user closes browser or upstream proxy aborts), Express exposes `req.signal` (in Express 5) or `req.raw?.signal`.

`@siglo/express` passes this abort signal directly to the workflow engine (`ExecutionOptions.signal`). Steps inside your workflow can listen to this signal via `param.$signal?.()`:

```typescript
const fetchExternalInventory = Step.create(async param => {
    const signal = param.$signal?.(); // AbortSignal combined from HTTP request & step timeout
    const res = await fetch('https://inventory.internal/check', { signal });
    return await res.json();
});
```

If the client terminates the connection while the fetch is pending, the HTTP request is cancelled immediately, freeing server sockets.

---

## 8. Complete Production Example

```typescript
import express, { Request, Response } from 'express';
import { Step, flow } from '@siglo/core';
import { sigloExpressMiddleware } from '@siglo/express';

const app = express();
app.use(express.json());

// 1. Define Domain Steps
interface CheckoutInput {
    cartId: string;
    userId: string;
    currency: string;
}

const validateCart = Step.create('validateCart', async (input: CheckoutInput) => {
    if (!input.cartId) {
        const err = new Error('Field cartId is required');
        err.name = 'ValidationException';
        throw err;
    }
    return { validated: true, subtotal: 150 };
});

const chargeCustomer = Step.create('chargeCustomer', async (param: any) => {
    // Perform payment processing
    return { transactionId: `txn_${Date.now()}`, charged: true };
});

const createOrderRecord = Step.create('createOrderRecord', async (param: any) => {
    return { orderId: `ord_${Date.now()}`, status: 'PLACED' };
});

const checkoutFlow = flow(validateCart, chargeCustomer, createOrderRecord);

// 2. Mount Siglo Route
app.post(
    '/api/v1/checkout',
    sigloExpressMiddleware(checkoutFlow, {
        timeout: 10000, // 10s execution SLA
        correlationIdHeader: 'x-request-id',
        input: (req: Request) => ({
            cartId: req.body.cartId,
            userId: req.body.userId,
            currency: req.body.currency || 'USD',
        }),
        output: (result, res: Response) => {
            return res.status(201).json({
                success: true,
                orderId: result.orderId,
                transactionId: result.transactionId,
                status: result.status,
            });
        },
        onError: (err, req, res, next) => {
            if (err.name === 'ValidationException') {
                return res.status(400).json({ error: err.message, code: 'INVALID_INPUT' });
            }
            if (err.name === 'StepTimeoutException') {
                return res.status(504).json({ error: 'Checkout SLA timed out', code: 'TIMEOUT' });
            }
            return res.status(500).json({ error: 'Internal order failure', detail: err.message });
        },
    }),
);

app.listen(3000, () => {
    console.log('Checkout service running on http://localhost:3000');
});
```

---

## 9. Durable Workflows and Automatic HTTP Responses

Enable `durable: true` so `waitForEvent()` or `wait()` can suspend execution. The adapter automatically returns **202 Accepted** when the result has `status: 'waiting'`, including the suspension descriptor and `X-Workflow-Stack-Id` header. A workflow that completes uses **200 OK** by default.

```typescript
import express from 'express';
import { Step, flow, waitForEvent, resumeWorkflow } from '@siglo/core';
import { sigloExpressMiddleware } from '@siglo/express';

const app = express();
app.use(express.json());

const approvalWorkflow = flow(
    waitForEvent('order.approved', {
        correlationKey: (input: { orderId: string }) => `order:${input.orderId}`,
        timeout: '24h',
    }),
    Step.create('confirmOrder', () => ({ status: 'confirmed' })),
);

// POST JSON: { "orderId": "order-5001" }
// Returns 202 with status: 'waiting'; no output callback is required.
app.post(
    '/api/orders',
    sigloExpressMiddleware(approvalWorkflow, {
        durable: true,
        namespace: 'orders',
    }),
);

// In a separate approval webhook handler, resume the existing execution:
// await resumeWorkflow(approvalWorkflow, 'order:order-5001', { approved: true });
```

The waiting JSON includes `status`, `stackId`, `stepId`, `correlationKey`, `eventName`, `expiresAt` (a Unix timestamp in milliseconds when a timeout is set), and `continuationStepIndex`. Suspension is a successful result, so it does not invoke `onError`. Calling the submission handler again starts a new execution; approval webhooks must call `resumeWorkflow()` to continue the suspended one.

For request-specific control, replace `durable: true` with `durable: (req) => req.headers['x-durable'] === 'true'`. Explicit `durable: false` disables suspension; wait nodes then use their non-durable behavior.

| Workflow outcome                          | Default HTTP response                                 |
| :---------------------------------------- | :---------------------------------------------------- |
| Suspended at `waitForEvent()` or `wait()` | `202 Accepted` with the waiting descriptor            |
| Completed                                 | `200 OK` with the clean workflow result               |
| Failed                                    | Existing error-to-status mapping, or custom `onError` |

A custom `output` callback takes full control of the response body and status, including for waiting results. If you supply one, handle `result.status === 'waiting'` explicitly when you want to preserve the `202` response.

The HTTP adapter does not supply persistence. Configure a shared storage adapter that supports checkpoints and wait records to survive process restarts and resume across replicas. Timer waits also need a scheduler to resume them when due. See [Durable Workflows](/06-durable-workflows), [Storage and Adapters](/07-storage-and-adapters), and [the distributed checkout tutorial](/durable-distributed-checkout).
