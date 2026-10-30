# Phase 3 Roadmap: `@siglo/ai` (Resilient LLMs & Structured Outputs)

> Detailed implementation design, runtime contracts, TypeScript API signatures, and testing specifications for Siglo's AI inference and structured output step package.

---

## 1. Executive Overview

Phase 3 introduces **`@siglo/ai`**, bringing workflow-grade predictability, resilience, and type safety to Large Language Model (LLM) operations. Rather than treating LLMs as unpredictable black boxes, `@siglo/ai` turns completions into deterministic, schema-validated pipeline steps.

Key highlights include:
1. **Standard Schema Output Validation**: Guarantees typed JSON extraction using Zod, Valibot, or ArkType.
2. **Self-Healing Prompt Repair Loops**: Automatically feeds schema validation errors back into an ephemeral repair prompt before failing.
3. **Model Fallback Cascades**: Instantly falls back to secondary models if primary providers hit rate limits (`429`) or timeouts.
4. **Token Cost & Usage Telemetry**: Logs granular token counts and cost estimates directly to step history (`$steps.<name>.metrics`).
5. **Deterministic Step Caching**: Integrates with Siglo's caching engine to avoid redundant LLM invocations for identical inputs.

---

## 2. Architecture & Runtime Lifecycle

```
[Context Input]
       |
       v
+-----------------------------------------------------------------------------------+
| aiStep('analyzeContract', { ... })                                                |
|                                                                                   |
| 1. Cache Check                                                                    |
|    - If cache enabled and input fingerprint matches, returns cached output        |
|                                                                                   |
| 2. Dynamic Prompt & Model Resolution                                              |
|    - Interpolates context into messages (System, User, Assistant)                 |
|    - Selects primary model (e.g. Anthropic Claude 3.5 Sonnet)                     |
|                                                                                   |
| 3. Execution & Fallback Cascade                                                   |
|    - Dispatches to Provider (Anthropic) with cooperative AbortSignal              |
|    - IF Rate Limited (429) OR Timeout:                                            |
|         Cascades to fallback model (e.g. Gemini 1.5 Flash / GPT-4o-mini)          |
|                                                                                   |
| 4. Structured Output Extraction & Validation                                      |
|    - Parses JSON output against Standard Schema (Zod / Valibot)                   |
|    - IF Schema Validation Fails:                                                  |
|         Triggers Self-Healing Repair Loop (up to maxRepairAttempts)               |
|         Appends error diagnostics to prompt and re-invokes model                  |
|                                                                                   |
| 5. Telemetry & Cost Accounting                                                    |
|    - Calculates prompt_tokens, completion_tokens, estimatedCostUsd                |
|    - Injects metrics into step output ($steps.analyzeContract.metrics)            |
+-----------------------------------------------------------------------------------+
       |
       v
[Typed Accumulated Context with Inferred Schema]
```

---

## 3. Core Features & Capabilities

1. **Multi-Provider Support**:
   - Anthropic (Messages API, Claude 3.5 Sonnet / Haiku).
   - OpenAI (Responses / Chat Completions, GPT-4o / GPT-4o-mini).
   - Google Gemini (Gemini 1.5 Pro / Flash).
   - Local / Self-Hosted (Ollama, vLLM via OpenAI-compatible endpoints).
2. **Self-Healing Repair Loop**:
   - When structured JSON outputs fail schema parsing, rather than crashing the workflow, `@siglo/ai` automatically constructs a targeted repair prompt (including the invalid JSON and the specific schema validation errors) and prompts the model to correct its mistakes.
3. **Model Fallback Cascades**:
   - Allows declaring a list of fallback models (e.g., `['claude-3-5-sonnet', 'gpt-4o', 'gemini-1.5-flash']`). If the primary model encounters a `429 Too Many Requests`, high latency, or timeout, the step seamlessly falls back to the next model in the list.
4. **Token Cost Tracking**:
   - Automatically computes token consumption and estimated cost using built-in provider pricing tables, recording metrics in context without polluting business keys.

---

## 4. TypeScript API Signatures

```typescript
import { Step } from 'siglo';

export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'custom';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  latencyMs: number;
  modelUsed: string;
}

export interface AiStepOptions<TInput, TOutput, TSchema = unknown> {
  provider?: AiProvider;
  model: string;
  fallbackModels?: string[];
  
  /** Dynamic prompt function or static string/messages */
  prompt: string | ((ctx: TInput) => string | ChatMessage[]);
  
  /** Standard Schema (Zod / Valibot / ArkType) for structured JSON output */
  schema?: TSchema;
  
  temperature?: number;
  maxTokens?: number;
  
  /** Maximum number of self-healing attempts if schema validation fails (default: 2) */
  maxRepairAttempts?: number;
  
  /** Optional custom base URL (e.g. for local Ollama / vLLM instances) */
  baseUrl?: string;
  apiKey?: string | ((ctx: TInput) => string);
}

export function aiStep<const TName extends string, TInput, TOutput>(
  name: TName,
  options: AiStepOptions<TInput, TOutput>
): Step<TInput, TOutput & { $aiMetrics?: AiMetrics }>;
```

---

## 5. Concrete Usage Example

```typescript
import { flow } from 'siglo';
import { aiStep } from '@siglo/ai';
import { z } from 'zod';

const RiskAssessmentSchema = z.object({
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  confidenceScore: z.number().min(0).max(1),
  redFlags: z.array(z.string()),
  recommendedAction: z.enum(['APPROVE', 'MANUAL_REVIEW', 'DECLINE']),
  reasoning: z.string(),
});

export const assessLoanApplication = aiStep('assessLoan', {
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  fallbackModels: ['gpt-4o', 'gemini-1.5-flash'],
  temperature: 0.1,
  schema: RiskAssessmentSchema,
  maxRepairAttempts: 2,
  prompt: (ctx: { applicantName: string; creditScore: number; loanAmount: number; debtToIncome: number }) => [
    {
      role: 'system',
      content: 'You are an expert financial risk officer. Analyze the loan application strictly against underwriting standards.',
    },
    {
      role: 'user',
      content: `Applicant: ${ctx.applicantName}\nCredit Score: ${ctx.creditScore}\nAmount Requested: $${ctx.loanAmount}\nDTI: ${ctx.debtToIncome}%`,
    },
  ],
});

// Composed into a typed workflow:
export const loanPipeline = flow(
  fetchCreditReportStep,
  assessLoanApplication,
  // TypeScript accurately knows ctx.riskLevel and ctx.recommendedAction exist here!
  decideStep
);
```

---

## 6. Testing Strategy

1. **Deterministic Offline Replay**:
   - Provide `@siglo/ai/testing` with `MockAiProvider` to record and replay exact LLM completions without touching live APIs.
2. **Schema Repair Simulation**:
   - Test self-healing repair logic by configuring mock responses that emit malformed JSON on attempt 1 and valid JSON on attempt 2. Assert repair loop succeeds.
3. **Fallback Transition Tests**:
   - Simulate a `429 Rate Limit` on the primary provider and assert seamless transition to the fallback model within the step's lifecycle.

---

## 7. Phase 3 Checklist & Deliverables

- [ ] Monorepo package directory setup: `packages/ai`.
- [ ] Provider adapters:
  - [ ] Anthropic (Messages API).
  - [ ] OpenAI (Chat Completions & JSON Mode).
  - [ ] Google Gemini.
  - [ ] Generic OpenAI-compatible adapter (Ollama, vLLM).
- [ ] Standard Schema (`zod`, `valibot`, `arktype`) output extractor.
- [ ] Self-healing repair loop algorithm.
- [ ] Model fallback cascade logic.
- [ ] Token and cost calculation module.
- [ ] Deterministic mock provider in `@siglo/ai/testing`.
- [ ] 100% test coverage with zero external network calls in CI.
