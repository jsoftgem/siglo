# @fluid-func/fastify Adapter Guide

`@fluid-func/fastify` provides an idiomatic Fastify route handler adapter for executing `fluid-func` workflows. It is optimized for high-throughput, low-overhead microservices, taking advantage of Fastify's asynchronous request lifecycle, schema validation, and raw Node.js HTTP stream signals for cooperative cancellation.

---

## 1. Overview & Architecture

Fastify is designed for minimal overhead. The `@fluid-func/fastify` handler adapter integrates as a standard Fastify route handler:

```
    Fastify HTTP Request
             │
             ▼
    ┌─────────────────────────────────┐
    │       fluidFastifyHandler       │
    │  • Extract request.body / query │
    │  • Extract request.raw.signal   │ (Native AbortSignal)
    │  • Mirror X-Correlation-Id      │
    │  • Resolve Tenant Namespace     │
    └────────────────┬────────────────┘
                     │
                     ▼
    ┌─────────────────────────────────┐
    │       fluid-func Workflow       │
    │  • Typed Input Parameters       │
    │  • Timeout Deadlines            │
    │  • Subgraph Step Execution      │
    └────────────────┬────────────────┘
                     │
           ┌─────────┴─────────┐
       (Success)            (Error)
           │                   │
           ▼                   ▼
    ┌──────────────┐   ┌───────────────────────────┐
    │ Set Stack ID │   │ getErrorStatusCode(err)   │
    │ Return JSON  │   │ reply.status(code).send() │
    └──────────────┘   └───────────────────────────┘
```

---

## 2. Installation & Requirements

Install `@fluid-func/fastify` alongside Fastify:

```bash
npm install fluid-func @fluid-func/fastify fastify
```

Peer dependency matrix:
- `fluid-func`: `*` (v1.0.0+)
- `fastify`: `^4.0.0 || ^5.0.0`

---

## 3. API Reference

### `fluidFastifyHandler(workflow, options)`

Creates a Fastify route handler `(request, reply) => Promise<any>`:

```typescript
function fluidFastifyHandler<TInput = any, TOutput = any, TReq = any>(
    workflow: Flow<TInput, TOutput>,
    options?: FluidFastifyOptions<TReq, TInput, TOutput>
): (request: any, reply: any) => Promise<any>;
```

---

## 4. Configuration Options (`FluidFastifyOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `input` | `(req: TReq) => Promise<TInput> \| TInput` | `request.body \|\| request.query` | Function transforming incoming Fastify request into workflow parameters. |
| `output` | `(result: TOutput, reply: FastifyReply) => Promise<any> \| any` | `result` | Function formatting the final response. If omitted, Fastify serializes the clean result. |
| `timeout` | `number` | `undefined` | Execution timeout in milliseconds. |
| `namespace` | `string \| ((req: TReq) => string \| undefined)` | `req.headers['x-namespace']` | Namespace identifier for tenant partitioning. |
| `onError` | `(err: any, reply: FastifyReply) => Promise<any> \| any` | Default JSON error handler | Custom error responder. |
| `correlationIdHeader` | `string` | `'x-correlation-id'` | Header name for correlation propagation. |

---

## 5. Status Code Resolution & Error Semantics

If a workflow throws an unhandled error and no `onError` hook is specified, the adapter automatically categorizes the error and formats the response:

| Error Name / Hierarchy | Status Code | HTTP Status |
| :--- | :--- | :--- |
| `StepTimeoutException` / `FlowTimeoutException` | `504` | Gateway Timeout |
| `ValidationException` / `SpecFailedException` | `400` | Bad Request |
| `IdempotencyConflictException` | `409` | Conflict |
| `CancellationException` / `AbortError` | `499` | Client Closed Request |
| Other `Error` instances | `500` | Internal Server Error |

*Default Error JSON Payload:*
```json
{
  "error": "Timeout occurred while executing step 'chargeCustomer'"
}
```

---

## 6. Native Request Abort & Cooperative Cancellation

Fastify exposes Node.js's native `request.raw.signal`. When an HTTP client aborts (e.g. closes connection or timeout occurs on the client proxy), Fastify emits an abort event on `request.raw.signal`.

The adapter extracts `request.raw.signal` and attaches it to the workflow's `ExecutionOptions`. Any workflow step calling external APIs can link their child operations:

```typescript
const queryExternalAPI = Step.create(async (param) => {
    const signal = param.$signal?.();
    const res = await fetch('https://api.upstream.io/data', { signal });
    return await res.json();
}).modern();
```

---

## 7. Complete Production Example

```typescript
import Fastify from 'fastify';
import { Step, flow } from 'fluid-func';
import { fluidFastifyHandler } from '@fluid-func/fastify';

const fastify = Fastify({
    logger: true,
});

// 1. Workflow Definition
interface KYCInput {
    customerId: string;
    ssn: string;
    country: string;
}

const verifyIdentity = Step.create('verifyIdentity', async (input: KYCInput) => {
    if (!input.customerId || !input.ssn) {
        const err = new Error('customerId and ssn are required');
        err.name = 'ValidationException';
        throw err;
    }
    return { verified: true, riskScore: 12 };
}).modern();

const runSanctionCheck = Step.create('runSanctionCheck', async (param: any) => {
    // Upstream sanctions database check
    return { sanctioned: false, clearanceId: `clear_${Date.now()}` };
}).modern();

const kycPipeline = flow(verifyIdentity, runSanctionCheck);

// 2. Fastify Route Schema + Handler Adapter
fastify.post(
    '/api/v1/kyc/verify',
    {
        schema: {
            body: {
                type: 'object',
                required: ['customerId', 'ssn'],
                properties: {
                    customerId: { type: 'string' },
                    ssn: { type: 'string' },
                    country: { type: 'string', default: 'US' },
                },
            },
        },
    },
    fluidFastifyHandler(kycPipeline, {
        timeout: 8000, // 8-second timeout SLA
        correlationIdHeader: 'x-request-id',
        namespace: (req) => req.headers['x-tenant-id'] as string,
        output: (result, reply) => {
            reply.status(200).send({
                success: true,
                clearanceId: result.clearanceId,
                verified: result.verified,
                riskScore: result.riskScore,
            });
        },
        onError: (err, reply) => {
            if (err.name === 'ValidationException') {
                return reply.status(400).send({ error: err.message, type: 'BAD_REQUEST' });
            }
            if (err.name === 'StepTimeoutException') {
                return reply.status(504).send({ error: 'KYC check timed out', type: 'TIMEOUT' });
            }
            reply.status(500).send({ error: 'KYC verification failed', detail: err.message });
        },
    })
);

// Start server
const start = async () => {
    try {
        await fastify.listen({ port: 3000, host: '0.0.0.0' });
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
```
