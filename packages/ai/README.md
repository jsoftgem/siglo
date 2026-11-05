# @siglo/ai

[![CI](https://github.com/jsoftgem/siglo/actions/workflows/ci.yml/badge.svg)](https://github.com/jsoftgem/siglo/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)](https://github.com/jsoftgem/siglo)

Resilient, multi-provider AI steps and agentic execution for Siglo workflows. Built for production reliability with native JSON Schema structured outputs, automated self-healing repair loops, multi-model fallback cascades, Step-as-Tool agent loops with saga compensations, ASL network perimeter enforcement, deterministic caching, and OpenTelemetry GenAI observability.

Supported providers:
- **Anthropic Messages API** (Claude 3.5 Sonnet, Claude 3.5 Haiku, Claude 3.7 Sonnet)
- **OpenAI Chat Completions** (GPT-4o, GPT-4o-mini, o1, o3-mini) with native Structured Outputs
- **Google Gemini** (Gemini 2.0 Flash, Gemini 1.5 Pro) with `responseJsonSchema`
- **Ollama / vLLM / LocalAI** (OpenAI-compatible `/chat/completions`)
- **Custom Endpoints** via customizable `baseUrl`

---

## Installation

```bash
npm install @siglo/core @siglo/ai @siglo/http
```

Peer dependencies:
- `@siglo/core`: `^1.0.0`
- `@siglo/http`: `^1.0.0`
- `@opentelemetry/api`: `^1.0.0` (optional, for distributed trace context propagation)

---

## Quickstart

```typescript
import { flow } from '@siglo/core';
import { aiStep } from '@siglo/ai';
import { z } from 'zod';

// Define output schema using Standard Schema (Zod, Valibot, ArkType)
const SummarySchema = z.object({
  summary: z.string(),
  keyTakeaways: z.array(z.string()),
  sentiment: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE'])
});

export const summarizeDocument = aiStep('summarizeDocument', {
  model: {
    provider: 'openai',
    model: 'gpt-4o',
    requestTimeoutMs: 15_000
  },
  fallbackModels: [
    { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', requestTimeoutMs: 12_000 },
    { provider: 'gemini', model: 'gemini-2.0-flash', requestTimeoutMs: 10_000 }
  ],
  prompt: (ctx: { text: string }) => `Analyze and summarize this document:\n\n${ctx.text}`,
  schema: SummarySchema,
  jsonSchema: z.toJSONSchema(SummarySchema), // Explicit conversion or Standard JSON Schema
  temperature: 0.2
});

const result = await flow(summarizeDocument).run({
  text: 'Quarterly revenue grew by 18% driven by enterprise expansion...'
});

// Fully typed output:
console.log(result.data.summary);
console.log(result.data.sentiment);

// Step metrics:
console.log(result.$steps.summarizeDocument.aiMetrics);
```

---

## Core Capabilities

### 1. Consistent Wrapped Output Contract
Every AI step yields a standardized wrapped result:
```typescript
{
  data: TOutput,          // Validated structured output or raw text string
  $aiMetrics: AiMetrics,  // Telemetry, token counts, latency, and estimated cost
  aiMetrics: AiMetrics    // Alias for $aiMetrics
}
```
Schema-free steps return `data: string` without JSON parsing. Schema-backed steps infer the exact transformed output type (`StandardSchemaV1.InferOutput<TSchema>`).

### 2. Native Structured Outputs & Primitive Enveloping
Native schema enforcement passes schemas directly to providers:
- **OpenAI**: `response_format: { type: 'json_schema', strict: true, schema: ... }`
- **Gemini**: `generationConfig.responseJsonSchema`
- **Anthropic**: Dedicated output tool `siglo_structured_output` with `tool_choice: { type: 'any' }`

Primitive (`z.string()`, `z.number()`) and array (`z.array(...)`) schemas are automatically wrapped into an internal `{ data: schema }` object envelope for OpenAI and Anthropic to comply with provider object root requirements; the public `data` returned to your workflow remains the pure primitive or array.

To run with models that lack native structured output support, set `enforceNativeStructuredOutputs: false` to rely on prompt instructions and local validation with self-healing repairs.

### 3. Self-Healing Prompt Repair Loops
When a model produces malformed JSON or values violating schema constraints, `@siglo/ai` intercepts the error and executes an automated correction turn:
- Injects previous invalid output and structured error diagnostics into an ephemeral user repair message.
- Re-invokes the model up to `maxRepairAttempts` (default: `2`).
- If repair attempts are exhausted, throws `AiOutputValidationError` containing the structured diagnostic issues.

### 4. Resilient Fallback Cascades
Configure primary and fallback models:
```typescript
fallbackModels: [
  { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
  { provider: 'gemini', model: 'gemini-2.0-flash' }
]
```
Automatic failover triggers on:
- HTTP `429 Too Many Requests` (rate limits)
- HTTP `5xx` transient server errors (`500`, `502`, `503`, `504`)
- Per-request timeouts (`requestTimeoutMs`)

Fatal errors (authentication `401`/`403`, client errors `400`/`422`, policy violations, workflow cancellation) fail fast without fallback.

### 5. Step-as-Tool Agent Loop with Saga Compensations
Expose existing Siglo workflow steps directly to LLMs as typed tools using `defineAiTool`:

```typescript
import { Step } from '@siglo/core';
import { defineAiTool, aiStep } from '@siglo/ai';
import { z } from 'zod';

const calculateArgs = z.object({ principal: z.number(), rate: z.number(), years: z.number() });

const calculateInterestStep = Step.create('calculateInterest', async ({ principal, rate, years }: { principal: number; rate: number; years: number }) => {
  return { totalInterest: principal * rate * years };
});

const calculateTool = defineAiTool({
  name: 'calculateInterest',
  description: 'Calculate simple interest over a number of years',
  inputSchema: calculateArgs,
  jsonSchema: z.toJSONSchema(calculateArgs),
  mapInput: (args) => args,
  step: calculateInterestStep
});

export const advisorStep = aiStep('advisor', {
  model: { provider: 'openai', model: 'gpt-4o' },
  prompt: 'Calculate interest on $5,000 principal at 4% for 3 years.',
  tools: [calculateTool],
  maxToolTurns: 5
});
```

- **Batch Pre-Validation**: Validates the entire batch of requested tool calls before executing any side effects.
- **Parent Saga Integration**: Runs tool steps on the active workflow stack (`stackId`). Successful tool steps with compensations roll back in reverse order (LIFO) if subsequent inference or downstream steps fail.
- **Tool Restrictions**: Tool-bearing AI steps strictly forbid caching, failure recovery/retries, and idempotent replay to prevent skipping or repeating external effects.
- **Turn Limits**: Bounded by `maxToolTurns` (default: `5`).

### 6. Zero-Trust ASL Network Perimeter
Integrates with Siglo's AsyncLocalStorage (ASL) network egress perimeter:
- Primary and fallback hostnames (`api.openai.com`, `api.anthropic.com`, etc.) and declared tool step hosts are registered in the step's `.allowNetwork()` policy.
- Preflights all endpoints in `BEFORE` and re-verifies right before network dispatch.
- Localhost endpoints (e.g. Ollama on `http://localhost:11434`) are denied by default and require explicit `allowLocalhost: true`.
- HTTP redirects are rejected (`redirect: 'error'`) to prevent perimeter escalation and credential leaks.

### 7. Deterministic Caching
Inference steps without tools support Siglo's `.cache()`:
```typescript
aiStep('cachedAnalyze', options).cache({ ttl: 3600 });
```
Computes a SHA-256 digest over `cacheVersion`, prompt, model cascade, credentials scope, schema, validator code, sampling parameters, and input context. Stampede protection defaults to `false` so independent workflow cancellations never abort concurrent callers.

### 8. OpenTelemetry & Cost Accounting
- Injects standard OpenTelemetry GenAI Semantic Convention attributes (`gen_ai.system`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`).
- Injects W3C `traceparent` and `tracestate` headers into provider requests.
- Emits typed `ai:complete` monitoring events containing metrics (prompts and output text are excluded to prevent secret/PII leaks).
- Calculates `estimatedCostUsd` using baseline pricing tables or per-model custom pricing overrides (`pricing: { inputPerMillion, outputPerMillion }`).

---

## Offline Testing & Deterministic Replay

Test AI workflows deterministically in CI with zero external network calls using `MockAiProvider`:

```typescript
import { flow } from '@siglo/core';
import { WorkflowHarness } from '@siglo/testing';
import { MockAiProvider } from '@siglo/ai/testing';
import { aiStep } from '@siglo/ai';
import { z } from 'zod';

const schema = z.object({ summary: z.string() });

// Scripted mock provider (simulates a malformed response followed by a valid repair)
const mock = new MockAiProvider([
  { text: 'bad JSON', promptTokens: 10, completionTokens: 2 },
  { text: '{"summary":"Workflow completed"}', promptTokens: 15, completionTokens: 5 }
]);

const step = aiStep('offlineStep', {
  model: { provider: 'openai', model: 'gpt-4o', adapter: mock },
  prompt: 'Summarize text',
  schema,
  jsonSchema: z.toJSONSchema(schema)
});

await new WorkflowHarness(flow(step)).run({});
mock.assertDone();

// Export recording for strict replay regression tests:
const recording = mock.exportRecording();
const replayAdapter = MockAiProvider.replay(recording);
```

---

## Configuration Reference

### `AiStepOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | `AiModelConfig` | *Required* | Primary model configuration. |
| `fallbackModels` | `AiModelConfig[]` | `[]` | Sequential fallback models for `429`, `5xx`, and timeouts. |
| `prompt` | `string \| ChatMessage[] \| ((ctx: TInput) => string \| ChatMessage[])` | *Required* | Static prompt string, ChatMessage array, or dynamic prompt function. |
| `schema` | `TSchema extends StandardSchemaV1` | `undefined` | Standard Schema V1 validator for structured JSON output. |
| `jsonSchema` | `Record<string, unknown>` | `undefined` | Native JSON Schema for provider structured output. |
| `inputSchema` | `StandardSchemaV1` | `undefined` | Validates step input context before inference. |
| `temperature` | `number` | `undefined` | Sampling temperature between `0` and `2`. |
| `maxTokens` | `number` | `undefined` | Maximum completion tokens to generate. |
| `maxRepairAttempts` | `number` | `2` | Maximum self-healing repair attempts on validation failure. |
| `tools` | `AiTool[]` | `[]` | Typed tools created with `defineAiTool` exposed to the model. |
| `maxToolTurns` | `number` | `5` | Maximum agentic tool interaction rounds. |
| `enforceNativeStructuredOutputs` | `boolean` | `true` | Set to `false` to disable provider-native schema enforcement. |
| `cacheVersion` | `string` | `'1'` | Cache namespace identifier; bump when prompt closures change. |

### `AiModelConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | `'anthropic' \| 'openai' \| 'gemini' \| 'ollama' \| 'custom'` | *Required* | AI provider type. |
| `model` | `string` | *Required* | Provider model identifier (e.g. `'gpt-4o'`, `'claude-3-5-sonnet-20241022'`). |
| `baseUrl` | `string` | Provider default | Custom endpoint base URL (required for `'custom'`). |
| `apiKey` | `string \| ((ctx: TInput) => string)` | Environment variable | API key or dynamic key resolver. |
| `requestTimeoutMs` | `number` | `undefined` | Per-request timeout in milliseconds before triggering fallback. |
| `adapter` | `AiProviderAdapter` | Built-in REST adapter | Injectable provider adapter (e.g. `MockAiProvider`). |
| `pricing` | `TokenPricing` | Baseline snapshot | Override token pricing: `{ inputPerMillion, outputPerMillion }`. |

---

## Documentation & References

- 📘 [Dedicated Adapter Guide](../../docs/adapters/ai.md): In-depth architecture, lifecycle phases, and complete production scenarios.
- 🗺️ [Phase 3 AI Roadmap](../../docs/roadmap/ecosystem-phase-3-ai.roadmap.md): Specification design, binding contracts, and initial release boundaries.
- 🌐 [Official Provider References]:
  - [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
  - [Anthropic Messages Tool Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
  - [Gemini Generate Content](https://ai.google.dev/api/generate-content)
