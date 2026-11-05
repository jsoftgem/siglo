# Phase 1A Roadmap: `@siglo/http` (Resilient, Traced HTTP Client Steps)

> Detailed implementation design, runtime execution contracts, TypeScript API signatures, and resiliency specifications for Siglo's enterprise HTTP client step package.

---

## 1. Executive Summary & Problem Space

In modern backend architectures, workflow steps frequently interact with third-party SaaS APIs, legacy internal services, and microservices via HTTP/REST. However, developers commonly write ad-hoc `fetch()` or `axios()` calls inside steps, which introduces severe systemic failure modes:

| Ad-Hoc HTTP Anti-Pattern | Operational Risk in Distributed Workflows | How `@siglo/http` Solves It |
|---|---|---|
| **Uncoordinated Retries** | Ad-hoc Axios retries conflict with Siglo's step-level retry policies, causing thundering herds and multiplying request volume. | Unified status code classifier and jittered backoff coordinated directly through Siglo's retry engine. |
| **Dangling Sockets on Timeout** | Standard `fetch` keeps background TCP sockets alive even after a workflow timeout expires, leaking file descriptors. | First-class `AbortSignal` binding: Siglo step timeouts and flow cancellation instantly abort socket connections. |
| **Silent Distributed Tracing Gaps** | Outgoing requests lack W3C trace context, fragmenting OpenTelemetry spans across service boundaries. | Automatic W3C `traceparent` and `tracestate` header injection from the active workflow span. |
| **Unregulated Network Egress** | Vulnerable to SSRF, data exfiltration, or rogue API calls by untrusted dependencies. | Enforces Siglo's AsyncLocalStorage (ASL) network egress perimeter (`allowNetwork`) with host verification. |
| **No Transactional Rollback** | If step 3 of a pipeline fails, previous POST requests (charges, reservations) remain uncompensated. | Declarative `.compensateWithHttp()` automatically executes compensating REST rollbacks (e.g., `DELETE`). |
| **Runtime Data Corruption** | Unvalidated API responses cause runtime crashes deep in downstream steps. | Seamless Standard Schema (`zod`, `valibot`, `arktype`) parsing for request and response payloads. |

---

## 2. Architectural Design & Step Lifecycle Integration

Siglo executes steps through a formal 5-phase lifecycle: `before` &rarr; `validation` &rarr; `action` &rarr; `after` &rarr; `onFail` / `compensate`. `@siglo/http` hooks directly into every phase:

```
+---------------------------------------------------------------------------------------------------+
|                                  httpStep('chargeCustomer', ...)                                  |
+---------------------------------------------------------------------------------------------------+
| 1. BEFORE Phase                                                                                   |
|    - Dynamically resolves URL, path parameters, query string, and headers from Context.           |
|    - Extracts destination hostname (e.g., 'api.stripe.com').                                      |
|    - Asserts hostname against active AsyncLocalStorage (ASL) network policy.                      |
|      (Throws NetworkPolicyViolationException if blocked by Flow perimeter).                      |
|                                                                                                   |
| 2. VALIDATION Phase (Input)                                                                       |
|    - If requestSchema is defined, validates outgoing payload before touching the network.         |
|                                                                                                   |
| 3. ACTION Phase (Network Execution)                                                               |
|    - Obtains active OpenTelemetry Span from AsyncLocalStorage context.                           |
|    - Injects W3C 'traceparent' and 'tracestate' headers.                                          |
|    - Links Step timeout signal and Flow AbortSignal to globalThis.fetch / Undici.                 |
|    - Dispatches HTTP call.                                                                        |
|    - Intercepts Response:                                                                         |
|        * 2xx Success: Parses body (JSON / Text / Blob).                                           |
|          Validates against responseSchema.                                                        |
|          Returns validated payload into accumulated context.                                      |
|        * 429 Rate Limit: Extracts 'Retry-After' header (seconds or HTTP Date).                     |
|          Calculates backoff delay and signals Siglo retry engine.                                 |
|        * 502/503/504 Transient Server Errors: Tags error as retryable for exponential backoff.    |
|        * 4xx Client Errors: Fast-fails as non-retryable SigloError (phase: 'action').             |
|                                                                                                   |
| 4. AFTER Phase                                                                                    |
|    - Attaches HTTP telemetry ($steps.<name>.httpMetadata: status, duration, cUrl, traceId).       |
|    - Caches response if step.cache() is configured.                                               |
|                                                                                                   |
| 5. COMPENSATION Phase (Sagas)                                                                     |
|    - Registers compensating rollback action in Siglo's CompensationManager.                       |
|    - If a downstream step fails, automatically executes compensating HTTP request (e.g., DELETE). |
+---------------------------------------------------------------------------------------------------+
```

---

## 3. Deep Technical Specifications

### 3.1 AsyncLocalStorage (ASL) Network Egress Enforcement
`@siglo/http` integrates natively with Siglo's least-privilege egress governance (see `docs/network-egress-policy.md`):
1. **Dynamic Target Resolution**: When the URL is resolved (either static string or dynamic function `(ctx) => string`), `@siglo/http` extracts the destination hostname:
   ```typescript
   const parsedUrl = new URL(resolvedUrl);
   const host = parsedUrl.hostname; // e.g., 'api.stripe.com'
   ```
2. **Perimeter Verification**: The step automatically checks if the host is authorized under the active `networkPolicyStorage.getStore()`:
   - If authorized: Proceed to network dispatch.
   - If forbidden: Throws `NetworkPolicyViolationException` (with `phase: 'before'`, `retryable: false`), preventing unmonitored egress before a single byte leaves the application.
3. **Automatic Step Allowlist Assertion**: `httpStep` automatically adds the resolved host to its step metadata so static graph validators (`flow.toMermaid()`, `validateGraph()`) accurately display outbound network edges.

### 3.2 W3C Distributed Trace Propagation
To maintain unbroken observability across distributed microservices:
1. `@siglo/http` inspects the active OTel context using `@opentelemetry/api`.
2. Automatically generates W3C headers:
   - `traceparent`: `00-{traceId}-{spanId}-{traceFlags}`
   - `tracestate`: vendor-specific routing state (if present).
3. Attaches OTel span semantic conventions:
   - `http.request.method`: `POST`
   - `url.full`: `https://api.stripe.com/v1/charges`
   - `server.address`: `api.stripe.com`
   - `http.response.status_code`: `200`

### 3.3 Status Code Classification & Retries

| Status Code / Error | Classification | Behavior |
|---|---|---|
| `429 Too Many Requests` | **Transient (Rate Limited)** | Inspects `Retry-After` header. If present, sleeps for the specified seconds or parses the HTTP Date before retrying. |
| `502 Bad Gateway`, `503 Service Unavailable`, `504 Gateway Timeout` | **Transient (Server Overload)** | Retries using Siglo's exponential backoff with full decorrelated jitter. |
| `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN` | **Transient (Network Transport)** | Retries using exponential backoff up to `maxRetries`. |
| `400 Bad Request`, `422 Unprocessable Entity` | **Fatal (Contract Mismatch)** | Fails fast with `ValidationException`. Never retried. |
| `401 Unauthorized`, `403 Forbidden` | **Fatal (Authentication Failure)** | Fails fast with `SigloError`. Never retried. |
| `404 Not Found` | **Fatal (Resource Missing)** | Fails fast with `SigloError` (unless `allowNotFound: true` is configured). |

#### `Retry-After` Header Resolution Logic:
```typescript
function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  
  // Scenario A: Integer seconds (e.g., "120")
  const seconds = Number(headerValue);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  
  // Scenario B: RFC 1123 HTTP Date (e.g., "Wed, 21 Oct 2026 07:28:00 GMT")
  const parsedDate = Date.parse(headerValue);
  if (!Number.isNaN(parsedDate)) {
    const delay = parsedDate - Date.now();
    return Math.max(0, delay);
  }
  
  return undefined;
}
```

### 3.4 Sagas & Declarative Compensation (`.compensateWithHttp`)
When an HTTP request creates an external state change (e.g. charging a card, reserving inventory, creating an AWS resource), and a subsequent step in the workflow fails, Siglo's Saga engine rolls back the state in reverse order (LIFO).

`@siglo/http` allows declaring this rollback inline:
```typescript
export const bookFlightStep = httpStep('bookFlight', {
  url: 'https://api.airline.com/bookings',
  method: 'POST',
  body: (ctx) => ({ flightNumber: ctx.flightNumber, passenger: ctx.passenger }),
  schema: BookingResponseSchema,
  // Automatically registered with Siglo's CompensationManager:
  compensate: {
    url: (ctx, res) => `https://api.airline.com/bookings/${res.bookingId}`,
    method: 'DELETE',
    headers: (ctx) => ({ Authorization: `Bearer ${ctx.airlineApiKey}` }),
  },
});
```

---

## 4. TypeScript API Signatures

```typescript
import { Step } from '@siglo/core';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface HttpMetadata {
  status: number;
  statusText: string;
  durationMs: number;
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  traceId?: string;
  retryAttempts: number;
  cUrl?: string;
}

export interface CompensationHttpConfig<TInput = any, TOutput = Record<string, any>> {
  url: string | ((ctx: TInput, res: TOutput) => string);
  method?: 'DELETE' | 'POST' | 'PUT';
  headers?: Record<string, string> | ((ctx: TInput, res: TOutput) => Record<string, string>);
  query?: Record<string, string | number | boolean | undefined> | ((ctx: TInput, res: TOutput) => Record<string, string | number | boolean | undefined>);
  body?: ((ctx: TInput, res: TOutput) => any) | Record<string, any> | any[] | string | number | boolean | null;
}

export interface HttpStepOptions<TInput = any, TOutput = Record<string, any>, TRequestSchema = unknown, TResponseSchema = unknown> {
  url: string | ((ctx: TInput) => string);
  method?: HttpMethod;
  headers?: Record<string, string> | ((ctx: TInput) => Record<string, string>);
  query?: Record<string, string | number | boolean | undefined> | ((ctx: TInput) => Record<string, string | number | boolean | undefined>);
  body?: ((ctx: TInput) => any) | Record<string, any> | any[] | string | number | boolean | null;
  
  /** Schema for validating outgoing request payload */
  requestSchema?: TRequestSchema;
  
  /** Schema for validating and typing incoming response payload */
  responseSchema?: TResponseSchema;
  
  /** Parser type: 'json' (default), 'text', 'blob', 'arrayBuffer' */
  responseType?: 'json' | 'text' | 'blob' | 'arrayBuffer';
  
  /** Custom status codes to trigger retry (defaults to [429, 502, 503, 504]) */
  retryOnStatus?: number[];
  
  /** Maximum number of retry attempts (defaults to 3) */
  maxRetries?: number;
  
  /** If true, 404 does not throw but returns { notFound: true, data: null } */
  allowNotFound?: boolean;
  
  /** Request timeout in milliseconds (overrides step-level timeout) */
  timeoutMs?: number;
  
  /** Declarative saga compensation */
  compensate?: CompensationHttpConfig<TInput, TOutput>;
}

export type HttpStepResult<TOutput = Record<string, any>> = TOutput & { $httpMetadata: HttpMetadata };

export interface HttpStepInstance<TInput = any, TOutput = Record<string, any>, TName extends string = string>
  extends Step<TInput, HttpStepResult<TOutput>, TName> {
  compensateWithHttp(config: CompensationHttpConfig<TInput, TOutput>): this;
}

export function httpStep<const TName extends string, TInput = any, TOutput = Record<string, any>>(
  name: TName,
  options: HttpStepOptions<TInput, TOutput>
): HttpStep<TInput, TOutput, TName>;
```

---

## 5. Concrete Usage Examples

### Example 1: E-Commerce Payment with Refund Compensation

```typescript
import { flow, Step } from '@siglo/core';
import { httpStep } from '@siglo/http';
import { z } from 'zod';

const StripeChargeResponse = z.object({
  id: z.string(),
  amount: z.number(),
  currency: z.string(),
  status: z.literal('succeeded'),
});

interface CheckoutContext {
  orderId: string;
  customerId: string;
  amount: number;
  stripeApiKey: string;
}

export const processPayment = httpStep('processPayment', {
  url: 'https://api.stripe.com/v1/charges',
  method: 'POST',
  headers: (ctx: CheckoutContext) => ({
    Authorization: `Bearer ${ctx.stripeApiKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }),
  body: (ctx: CheckoutContext) => ({
    customer: ctx.customerId,
    amount: ctx.amount,
    currency: 'usd',
    'metadata[orderId]': ctx.orderId,
  }),
  responseSchema: StripeChargeResponse,
  retryOnStatus: [429, 502, 503],
  maxRetries: 3,
  // Automatic saga compensation: Refund charge if fulfillment fails
  compensate: {
    url: 'https://api.stripe.com/v1/refunds',
    method: 'POST',
    headers: (ctx: CheckoutContext) => ({
      Authorization: `Bearer ${ctx.stripeApiKey}`,
    }),
    body: (ctx: CheckoutContext, res) => ({
      charge: res.id,
      reason: 'fraudulent',
    }),
  },
});

export const checkoutWorkflow = flow(
  processPayment,
  Step.create('fulfillInventory', async (ctx) => {
    // If this step throws, processPayment.compensate automatically fires!
    throw new Error('Warehouse out of stock');
  })
);
```

---

## 6. Testing & Verification Specifications

1. **Deterministic Mocking**:
   - Provide `@siglo/http/testing` containing `createMockHttpServer()` based on Undici's native `MockAgent`.
   - Allows mocking specific URLs, methods, headers, and responses without launching actual network listeners.
2. **`FakeClock` Retry Testing**:
   - Use `@siglo/testing`'s `FakeClock` to fast-forward `Retry-After: 60` headers instantly in test runs without waiting 60 actual seconds.
3. **Socket Abort Tests**:
   - Verify that when `step.timeout(100)` fires, the socket is immediately terminated and no lingering handles remain in the Node.js event loop.

---

## 7. Package File Structure & Deliverables

```
packages/http/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts                     # Public API exports
│   ├── step.ts                      # httpStep factory implementation
│   ├── types.ts                     # TypeScript interfaces
│   ├── client/
│   │   ├── fetch.ts                 # Fetch wrapper with AbortSignal & timeout
│   │   ├── retry.ts                 # Status classifier & Retry-After parser
│   │   └── trace.ts                 # W3C traceparent / tracestate injector
│   ├── policy/
│   │   └── asl-bridge.ts            # Bridge to Siglo ASL network policy
│   ├── schema/
│   │   └── validator.ts             # Standard Schema integration
│   └── testing/
│       ├── index.ts                 # MockHttpProvider exports
│       └── mock-agent.ts            # Undici MockAgent test utilities
└── test/
    ├── http-step.test.ts
    ├── retry-after.test.ts
    ├── asl-enforcement.test.ts
    ├── trace-propagation.test.ts
    └── compensation.test.ts
```

### Implementation Checklist
- [x] Scaffold `packages/http` package in monorepo with `package.json` and `tsconfig.json`.
- [x] Implement `parseRetryAfter` handling numeric seconds and RFC 1123 date strings.
- [x] Implement W3C trace propagation helper (`injectTraceHeaders`).
- [x] Connect URL hostname extraction to Siglo's ASL `networkPolicyStorage`.
- [x] Implement `httpStep` with standard 5-phase lifecycle hooks.
- [x] Implement `.compensateWithHttp` handler registered with `CompensationManager`.
- [x] Implement `@siglo/http/testing` mock client utilities.
- [x] Verify 100% test coverage with zero flake rate across unit and integration tests.
