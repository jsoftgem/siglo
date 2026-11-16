---
name: siglo-ecosystem-adapters
description: 'Integrate Siglo workflows into production web applications, message queues, AI pipelines, and enterprise systems. Use when connecting Siglo to web frameworks (@siglo/express, @siglo/fastify, @siglo/hono), message brokers and event queues (@siglo/bullmq, @siglo/kafka, @siglo/sqs with AWS partial batch failures), multi-provider AI steps and agentic tool calling (@siglo/ai), resilient HTTP client steps (@siglo/http with ASL network policies), multi-channel notifications and approval URLs (@siglo/notifications), cryptographic security (@siglo/crypto), and observability (@siglo/opentelemetry, @siglo/monitor).'
---

# Siglo Ecosystem Adapters

Siglo provides first-party integration packages to seamlessly embed workflows into HTTP web frameworks, background queues, AI agent pipelines, cloud providers, and enterprise observability stacks.

---

## 1. Web Framework Adapters

Siglo provides native middleware adapters that map HTTP requests to workflow executions and translate engine exceptions to standard HTTP status codes:

- `200 OK`: Workflow executed successfully.
- `202 Accepted`: Workflow suspended at a durable wait node (`waitForEvent` or `wait`).
- `400 Bad Request`: `ValidationException` or `.schema()` failure.
- `409 Conflict`: `IdempotencyConflictException` or OCC version conflict.
- `504 Gateway Timeout`: `StepTimeoutException` or workflow timeout.

### Express (`@siglo/express`)

```typescript
import express from 'express';
import { sigloExpressMiddleware } from '@siglo/express';
import { checkoutWorkflow } from './checkout.workflow';

const app = express();
app.use(express.json());

app.post(
    '/api/checkout',
    sigloExpressMiddleware(checkoutWorkflow, {
        input: req => req.body, // Extract typed input from request
        output: (result, res) => res.json(result), // Custom response formatter
        namespace: 'ecommerce', // Logical domain partitioning
        timeout: 10_000, // Request timeout in ms
        durable: false, // Set true for suspendable flows
        correlationIdHeader: 'x-request-id', // Propagation header
    }),
);
```

### Hono (`@siglo/hono`)

Compatible with Cloudflare Workers, Bun, Deno, and Node.js:

```typescript
import { Hono } from 'hono';
import { sigloHonoMiddleware } from '@siglo/hono';
import { orderFlow } from './order.flow';

const app = new Hono();

app.post(
    '/api/orders',
    sigloHonoMiddleware(orderFlow, {
        input: async c => await c.req.json(),
        namespace: 'orders',
    }),
);
```

---

## 2. Background Queues & Streaming Consumers

### BullMQ Worker (`@siglo/bullmq`)

Runs Siglo workflows as BullMQ jobs with atomic deduplication and automatic lock releasing on failures:

```typescript
import { Worker } from 'bullmq';
import { createBullMQProcessor } from '@siglo/bullmq';
import { defaultIdempotencyStore } from '@siglo/core';
import { videoProcessingFlow } from './video.flow';

const worker = new Worker(
    'video-transcode-queue',
    createBullMQProcessor(videoProcessingFlow, {
        input: job => job.data,
        idempotencyStore: defaultIdempotencyStore, // Deduplicate concurrent identical jobs
        namespace: 'media-processing',
    }),
    { connection: { host: 'localhost', port: 6379 } },
);
```

### AWS SQS & Lambda Partial Batch Failures (`@siglo/sqs`)

Handles AWS Lambda SQS event source mappings using AWS `ReportBatchItemFailures`:

```typescript
import { createSqsBatchHandler } from '@siglo/sqs';
import { orderProcessingFlow } from './order.flow';

export const handler = createSqsBatchHandler(orderProcessingFlow, {
    input: record => JSON.parse(record.body),
    namespace: 'order-events',
});
```

If 1 out of 10 messages fails, only the failed message ID is reported in `batchItemFailures`, preventing duplicate executions of the 9 successful messages.

---

## 3. Multi-Provider AI Steps & Agents (`@siglo/ai`)

`@siglo/ai` brings production resiliency to LLMs with JSON Schema structured outputs, multi-model fallback cascades, and Step-as-Tool calling loops with automatic Saga rollbacks.

Supported Providers: **Anthropic (Claude 3.5 / 3.7)**, **OpenAI (GPT-4o, o1, o3-mini)**, **Google Gemini (2.0 Flash, 1.5 Pro)**, and **Ollama / LocalAI**.

### Structured Output with Automatic Repair Loop

```typescript
import { flow } from '@siglo/core';
import { aiStep } from '@siglo/ai';
import { z } from 'zod';

const SentimentAnalysisSchema = z.object({
    sentiment: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE']),
    confidenceScore: z.number().min(0).max(1),
    keyTopics: z.array(z.string()),
});

export const analyzeFeedbackFlow = flow(
    aiStep('analyzeFeedback', {
        model: 'anthropic/claude-3-5-sonnet',
        fallbackModel: 'openai/gpt-4o-mini', // Auto-fallback if primary provider is down
        prompt: (ctx: { reviewText: string }) => [
            { role: 'system', content: 'You are an expert customer feedback analyzer.' },
            { role: 'user', content: ctx.reviewText },
        ],
        schema: SentimentAnalysisSchema, // Native JSON Schema structured output
        maxRepairAttempts: 2, // Self-healing schema validation loop
        temperature: 0.1,
    }),
);
```

### Agentic Tool Calling with Sagas

When LLMs execute tools, each tool is a typed Siglo `Step` with full Saga compensation support:

```typescript
const refundTool = Step.create('refundTool', async ({ amount, chargeId }) => {
    return await stripe.refund(chargeId, amount);
}).compensate(async ({ refundId }) => {
    await stripe.cancelRefund(refundId);
});

const agentStep = aiStep('supportAgent', {
    model: 'openai/gpt-4o',
    tools: [refundTool, checkInventoryTool],
    maxSteps: 5,
});
```

---

## 4. Resilient HTTP Client Steps (`@siglo/http`)

Enterprise HTTP step with automatic retries on `429`, `502`, `503`, `504`, `Retry-After` header parsing, AsyncLocalStorage (ASL) egress network perimeter enforcement, and REST saga compensation.

```typescript
import { flow } from '@siglo/core';
import { httpStep } from '@siglo/http';

export const syncCustomerFlow = flow(
    httpStep('callCrm', {
        url: (ctx: { customerId: string }) => `https://crm.example.com/api/v1/customers/${ctx.customerId}`,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: ctx => ({ email: ctx.email, name: ctx.name }),
        maxRetries: 3,
        timeoutMs: 5000,
    }).compensateWithHttp({
        method: 'DELETE',
        url: (output, ctx) => `https://crm.example.com/api/v1/customers/${ctx.customerId}`,
    }),
);
```

---

## 5. Multi-Channel Notifications & Approvals (`@siglo/notifications`)

Sends tamper-proof HMAC-SHA256 signed approval links via Slack Block Kit or HTML Email and pauses until clicked:

```typescript
import { flow } from '@siglo/core';
import { sendInteractiveApprovalStep } from '@siglo/notifications';

export const expenseFlow = flow(
    sendInteractiveApprovalStep('managerApproval', {
        channel: 'slack',
        recipient: 'C0123456789', // Slack Channel ID
        title: 'Expense Approval Required',
        message: ctx => `User ${ctx.user} requested reimbursement of $${ctx.amount}`,
        timeout: '3d',
        correlationKey: ctx => ctx.expenseId,
    }),
    payoutStep,
);
```

---

## 6. Cryptography & Security (`@siglo/crypto`)

### Timing-Safe Webhook Signature Verification

```typescript
import { flow } from '@siglo/core';
import { verifyWebhookStep } from '@siglo/crypto';

export const stripeWebhookFlow = flow(
    verifyWebhookStep('verifyStripe', {
        provider: 'stripe',
        secret: process.env.STRIPE_WEBHOOK_SECRET!,
        toleranceSeconds: 300, // Replay attack tolerance window
    }),
    handleStripeEvent,
);
```

### AEAD AES-256-GCM Envelope Field Encryption

Safely encrypt sensitive PII or credentials before persisting durable checkpoints:

```typescript
import { encryptFieldsStep, decryptFieldsStep } from '@siglo/crypto';

const secureCheckout = flow(
    encryptFieldsStep('encryptCard', {
        fields: ['creditCardNumber', 'cvv'],
        key: process.env.ENCRYPTION_MASTER_KEY!,
    }),
    durableWaitStep,
    decryptFieldsStep('decryptCard', {
        fields: ['creditCardNumber', 'cvv'],
        key: process.env.ENCRYPTION_MASTER_KEY!,
    }),
);
```

---

## 7. Observability: OpenTelemetry & DevTools Monitor

### OpenTelemetry (`@siglo/opentelemetry`)

Injects W3C `traceparent` headers and streams spans for every workflow, step, and retry attempt into Jaeger, Datadog, or Honeycomb:

```typescript
import { registerOpenTelemetryPlugin } from '@siglo/opentelemetry';

// Register once on app boot
registerOpenTelemetryPlugin({
    serviceName: 'order-service',
    captureInputs: true,
    captureOutputs: true,
});
```

### Live DevTools Monitor (`@siglo/monitor`)

Embed a live real-time visual DevTools dashboard into local or staging environments:

```typescript
import { createMonitorServer } from '@siglo/monitor';

const monitor = await createMonitorServer({
    port: 4000,
    host: '127.0.0.1',
});

// Attach to any workflow execution
const result = await checkoutFlow.monitor(monitor.emitter).run(input);
```

Visit `http://localhost:4000` to inspect live waterfalls, step timings, and state diffs.
