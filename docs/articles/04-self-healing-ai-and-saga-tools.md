# Self-Healing Structured Outputs and Saga-Backed Tool Calls for LLMs with `@siglo/ai`

---

Shipping an LLM feature in a prototype takes 20 lines of `fetch()`. Shipping that same LLM feature in a transactional backend service immediately hits four reliability walls:

1. **Malformed Structured Outputs**: Even with JSON mode enabled, models occasionally violate domain constraints (e.g., returning a negative refund amount or missing a required enum field). If you just call `JSON.parse()`, your request crashes.
2. **Provider Outages & Rate Limits**: When Anthropic returns a `529 Overloaded` or OpenAI hits a `429` rate limit, your workflow needs to fail over cleanly to a secondary provider without losing prompt context or blowing past your request deadline.
3. **Uncompensated Tool Side Effects**: When an LLM agent calls two tools in sequence—say, `reserveInventory` followed by `issueRefund`—and then fails on the final step, standard AI SDKs leave the first tool's database mutation dangling in production.
4. **SSRF & Unrestricted Network Egress**: Giving an LLM agent arbitrary tool-execution capabilities without step-level network egress policies is a security incident waiting to happen.

We built **`@siglo/ai`** on top of the [**Siglo**](https://github.com/jsoftgem/siglo) workflow runtime to solve these exact failure modes: turning LLM calls and agentic tool loops into **self-healing, Saga-compensated, and network-sandboxed workflow steps**.

---

## 1. Self-Healing Structured Outputs (`maxRepairAttempts` + Standard Schema)

`@siglo/ai` accepts any validator that implements the [Standard Schema (`StandardSchemaV1`)](https://standardschema.dev/) specification—including **Zod**, **Valibot**, and **ArkType**.

When you pass a `schema` to `aiStep()`, two things happen automatically:

1. **Preflight Native Schema Enforcement**: Before sending the request, `@siglo/ai` extracts the JSON Schema to enforce native structured outputs on providers that support it (OpenAI, Anthropic, Gemini, Ollama).
2. **Bounded Self-Healing Repair Loop**: When the model responds, `@siglo/ai` parses the JSON and validates it against your `StandardSchemaV1` validator. If validation fails and `repairs < maxRepairAttempts`, `@siglo/ai` does **not** throw immediately—it appends the assistant's invalid output and the exact schema validation diagnostics back into the conversation history:

```text
Your previous output failed validation. Return ONLY corrected JSON.
Validation diagnostics: [{"message":"Refund amount must be <= 500","path":["refundUsd"]}]
```

The model repairs its own JSON in the next turn, and your downstream workflow step receives a statically typed, guaranteed-valid TypeScript object—plus full token and cost telemetry under `$ai`:

```typescript
import { z } from 'zod';
import { flow } from '@siglo/core';
import { aiStep, anthropic, openai, gemini } from '@siglo/ai';

const TriageSchema = z.object({
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    summary: z.string().min(10),
    suggestedRefundUsd: z.number().min(0).max(500),
});

const triageTicket = aiStep('triageTicket', {
    // Primary model with automatic multi-provider failover cascade
    model: anthropic('claude-3-7-sonnet-latest'),
    fallbackModels: [openai('gpt-4o-mini'), gemini('gemini-2.5-flash')],
    schema: TriageSchema,
    maxRepairAttempts: 2,
    prompt: (ctx: { ticketId: string; body: string }) =>
        `Analyze support ticket ${ctx.ticketId} and return triage JSON:\n\n${ctx.body}`,
});
```

If all `maxRepairAttempts` are exhausted, `@siglo/ai` throws a typed `AiOutputValidationError` containing the structured validation diagnostics.

---

## 2. Step-as-Tool: Bringing LIFO Saga Rollbacks to LLM Tool Calls (`defineAiTool`)

In most AI frameworks, a "tool" is just an arbitrary async callback. If an LLM calls a tool that mutates state (creates a Jira ticket, reserves stock, or issues a credit) and a subsequent step in the workflow fails, you have no built-in way to roll back the tool's side effects.

In `@siglo/ai`, **every AI tool is a full `@siglo/core` `Step`**.

When you wrap a `Step` with `defineAiTool()`:

1. **Batch Pre-Validation Before Side Effects**: If the model emits multiple tool calls in a single turn, `@siglo/ai` validates the tool names, call IDs, and `inputSchema` payloads for the **entire batch** before executing the first side effect (`packages/ai/src/step.ts`).
2. **Parent Saga Registration**: Each tool executes via `Step.start(tool.step, input, { stackId, ... })`, binding its `.compensate()` handler directly to the **parent workflow's execution stack**.

```typescript
import { z } from 'zod';
import { Step, flow } from '@siglo/core';
import { aiStep, defineAiTool, anthropic, openai } from '@siglo/ai';

// 1. Define a normal Siglo Step with a Saga compensation handler
const issueStoreCredit = Step.create(
    'issueStoreCredit',
    async ({ ticketId, amountUsd }: { ticketId: string; amountUsd: number }) => ({
        creditId: await billingApi.grantCredit(ticketId, amountUsd),
    }),
).compensate(async ctx => {
    // Runs automatically if ANY downstream step in the parent workflow fails!
    await billingApi.revokeCredit(ctx.creditId);
});

// 2. Expose the Step as a schema-validated AI Tool
const creditTool = defineAiTool({
    name: 'issue_store_credit',
    description: 'Grant store credit to a customer for a verified service issue.',
    inputSchema: z.object({ amountUsd: z.number().min(1).max(100) }),
    step: issueStoreCredit,
    mapInput: (args, ctx: { ticketId: string; body: string }) => ({
        ticketId: ctx.ticketId,
        amountUsd: args.amountUsd,
    }),
});

// 3. Use the tool inside an aiStep and compose with downstream steps
const resolveSupportTicket = flow(
    aiStep('agentResolution', {
        model: anthropic('claude-3-7-sonnet-latest'),
        fallbackModels: [openai('gpt-4o-mini')],
        tools: [creditTool],
        maxToolTurns: 3,
        schema: z.object({ resolutionNote: z.string() }),
        prompt: (ctx: { ticketId: string; body: string }) =>
            `Resolve ticket ${ctx.ticketId}. Issue store credit if appropriate:\n${ctx.body}`,
    }),
    Step.create('notifyCustomer', async ctx => {
        // If notifyCustomer throws, issueStoreCredit.compensate() automatically revokes the credit!
        await emailService.send(ctx.ticketId, ctx.resolutionNote);
    }),
);
```

Notice the safety invariant enforced by `AiStep`: if an `aiStep` is configured with `tools`, `@siglo/ai` explicitly forbids step-level `.cache()`, `.onFail()` retries, or `.idempotent()` replay on the outer `aiStep` (`TypeError: AI steps with tools cannot use caching, retries, failure recovery or idempotent replay`), preventing accidental duplicate tool executions while keeping individual tool steps and parent Sagas in full control.

---

## 3. Automatic Zero-Trust Network Egress Policies

When you instantiate an `AiStep`, it automatically computes a least-privilege network egress allowlist (`this.allowNetwork(...)`) consisting **only** of:

- The hostnames of the configured primary `model` and `fallbackModels` (e.g., `api.anthropic.com`, `api.openai.com`).
- Any hosts explicitly allowed by the attached `tools` (`tool.step.networkPolicyConfig?.allowedHosts`).

When combined with `Step.installNetworkInterceptors()`, neither the AI step nor any tool invoked during the agent loop can make unauthorized outbound requests to internal metadata services (`169.254.169.254`), private VPC subnets, or unapproved third-party domains.

---

## 4. Built-In Token Cost & Latency Telemetry (`$ai`)

Every `aiStep` returns an `AiStepResult<TOutput>` that merges your parsed schema output alongside a non-enumerable `$ai` metrics summary (and emits OpenTelemetry GenAI semantic conventions plus live `@siglo/monitor` inspection cards):

```typescript
const result = await resolveSupportTicket.run({
    ticketId: 'tkt_901',
    body: 'My package arrived damaged. Order total was $45.',
});

console.log(result.resolutionNote);
console.log(result.$steps.agentResolution.$ai);
// {
//   promptTokens: 312,
//   completionTokens: 84,
//   totalTokens: 396,
//   latencyMs: 1140,
//   modelUsed: 'claude-3-7-sonnet-latest',
//   providerUsed: 'anthropic',
//   repairAttempts: 0,
//   fallbackCount: 0,
//   estimatedCostUsd: 0.002196
// }
```

---

## Try `@siglo/ai`

```bash
npm install @siglo/core @siglo/ai zod
```

- **AI Adapter Documentation**: [`docs/adapters/ai.md`](../adapters/ai.md)
- **Source Code**: [`packages/ai/src/`](https://github.com/jsoftgem/siglo/tree/main/packages/ai/src)
