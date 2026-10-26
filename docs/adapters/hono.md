# @fluid-func/hono Adapter Guide

`@fluid-func/hono` provides a modern, Web Standards-compliant middleware and route handler adapter for executing `fluid-func` workflows. It is optimized for cross-runtime deployment across Cloudflare Workers, Fastly Compute, Deno, Bun, AWS Lambda (via Hono), and traditional Node.js servers.

---

## 1. Overview & Architecture

Because Hono is built on standard `Request` and `Response` Web APIs, `@fluid-func/hono` enables portable, edge-ready workflow orchestration without any platform-specific Node.js bindings:

```
    Web Standards HTTP Request (Fetch Event / Edge Worker)
                          │
                          ▼
             ┌─────────────────────────┐
             │     fluidMiddleware     │
             │  • Extract c.req.json() │
             │  • Extract raw.signal   │ (Web Standard AbortSignal)
             │  • Set X-Correlation-Id │
             │  • Namespace Header     │
             └────────────┬────────────┘
                          │
                          ▼
             ┌─────────────────────────┐
             │   fluid-func Workflow   │
             │  • In-Memory Sagas      │
             │  • Parallel Combinators │
             │  • Two-Tier Timeouts    │
             └────────────┬────────────┘
                          │
                ┌─────────┴─────────┐
            (Success)            (Error)
                │                   │
                ▼                   ▼
         ┌──────────────┐    ┌───────────────────────────┐
         │ Set Stack ID │    │ getErrorStatusCode(err)   │
         │ c.json(...)  │    │ • 504 Gateway Timeout     │
         │ 200/201 OK   │    │ • 400 Bad Request         │
         └──────────────┘    │ • 409 Conflict            │
                             │ • 499 Client Closed Req   │
                             │ • 500 Server Error        │
                             └───────────────────────────┘
```

---

## 2. Installation & Requirements

Install `@fluid-func/hono` and Hono:

```bash
npm install fluid-func @fluid-func/hono hono
```

Peer dependency matrix:
- `fluid-func`: `*` (v2.0.0+)
- `hono`: `^3.0.0 || ^4.0.0`

---

## 3. API Reference

### `fluidMiddleware(workflow, options)`

Creates a Hono route handler or middleware `(c: Context, next?: Next) => Promise<any>`:

```typescript
function fluidMiddleware<TInput = any, TOutput = any, TReq = any>(
    workflow: Flow<TInput, TOutput>,
    options?: FluidHonoMiddlewareOptions<TReq, TInput, TOutput>
): (c: any, next?: () => Promise<void>) => Promise<any>;
```

---

## 4. Configuration Options (`FluidHonoMiddlewareOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `input` | `(c: Context) => Promise<TInput> \| TInput` | `await c.req.json()` or `c.req.query()` | Custom parameter extraction from Hono context. |
| `output` | `(result: TOutput, c: Context) => Promise<any> \| any` | `c.json(result)` | Custom responder formatting the HTTP response body and status code. |
| `timeout` | `number` | `undefined` | SLA execution timeout in milliseconds. |
| `namespace` | `string \| ((c: Context) => string \| undefined)` | `c.req.header('x-namespace')` | Namespace identifier for tenant partitioning. |
| `onError` | `(err: any, c: Context) => Promise<any> \| any` | Default JSON error response | Custom exception handler. |
| `correlationIdHeader` | `string` | `'x-correlation-id'` | Header name for correlation tracking. |

---

## 5. Web Standard Request Cancellation

In modern edge runtimes (Cloudflare Workers, Bun, Deno), clients closing the connection abort the native Web Standard `c.req.raw.signal`.

`@fluid-func/hono` passes this signal directly to `ExecutionOptions.signal`. Within workflow steps, access the cancellation signal via `param.$signal?.()`:

```typescript
const fetchExchangeRates = Step.create(async (param) => {
    const signal = param.$signal?.(); // Combined step timeout & request abort signal
    const response = await fetch('https://api.fx.internal/rates', { signal });
    return await response.json();
}).modern();
```

---

## 6. Multi-Runtime Deployment Guides

### A. Cloudflare Workers

```typescript
import { Hono } from 'hono';
import { Step, flow } from 'fluid-func';
import { fluidMiddleware } from '@fluid-func/hono';

const app = new Hono();

const geoLookup = Step.create('geoLookup', async (param: any) => {
    return { country: param.country || 'US', edgeRegion: 'WAF-EDGE-01' };
}).modern();

const rateCalculation = Step.create('rateCalculation', async (param: any) => {
    return { taxRate: param.country === 'US' ? 0.08 : 0.20 };
}).modern();

const edgeFlow = flow(geoLookup, rateCalculation);

app.post(
    '/api/calculate-tax',
    fluidMiddleware(edgeFlow, {
        input: async (c) => {
            const body = await c.req.json();
            return {
                ...body,
                country: c.req.header('cf-ipcountry') || 'US',
            };
        },
        output: (result, c) => c.json({ result }, 200),
    })
);

export default app;
```

---

### B. Bun / Node.js Server

```typescript
import { Hono } from 'hono';
import { serve } from '@hono/node-server'; // Or run directly with `bun run server.ts`
import { Step, flow } from 'fluid-func';
import { fluidMiddleware } from '@fluid-func/hono';

const app = new Hono();

const echoWorkflow = flow(
    Step.create('echo', async (input: any) => ({
        echoed: input,
        timestamp: Date.now(),
    })).modern()
);

app.post('/api/echo', fluidMiddleware(echoWorkflow));

// For Node.js:
serve(app, (info) => {
    console.log(`Hono server listening on http://localhost:${info.port}`);
});
```

---

## 7. Error Handling & Status Code Mapping

When a step fails, `@fluid-func/hono` checks the error type using `getErrorStatusCode(err)`:

```typescript
app.post(
    '/api/orders',
    fluidMiddleware(orderFlow, {
        onError: (err, c) => {
            if (err.name === 'IdempotencyConflictException') {
                return c.json({ error: 'Order is currently being processed by another request.' }, 409);
            }
            if (err.name === 'StepTimeoutException') {
                return c.json({ error: 'Order processing timed out.' }, 504);
            }
            return c.json({ error: err.message }, 500);
        },
    })
);
```

Default HTTP status mappings:
- `StepTimeoutException` / `FlowTimeoutException`: `504 Gateway Timeout`
- `ValidationException` / `SpecFailedException`: `400 Bad Request`
- `IdempotencyConflictException`: `409 Conflict`
- `CancellationException` / `AbortError`: `499 Client Closed Request`
- Unhandled `Error`: `500 Internal Server Error`
