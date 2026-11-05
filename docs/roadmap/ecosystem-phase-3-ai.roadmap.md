# Phase 3 Roadmap: `@siglo/ai` (Resilient LLMs, Native Structured Outputs & Agentic Steps)

> Detailed implementation design, runtime execution contracts, TypeScript API signatures, and testing specifications for Siglo's AI inference, structured output, and agentic step package.

---

## Implementation status: Phase 3 implemented and verified offline

The runtime lives in `packages/ai/src` and exports `aiStep`, `AiStep`, REST provider
adapters, and deterministic `MockAiProvider` testing helpers. Tests exercise provider
wire formats with injected transports and workflow behavior through `WorkflowHarness`.
No live provider credentials or external requests are required. The contracts below
supersede earlier string-only model lists, bare `Step[]` tools, and flattened outputs.

Validation: full monorepo build, core regression suite, AI runtime/provider tests and
compile-time inference checks. AI coverage is 100% lines/statements/functions; branch
coverage is reported separately. Live provider smoke tests remain deployment-specific.

- [x] Official Standard Schema V1 types and inference helpers re-exported from `@siglo/http`.
- [x] Native schema resolution from explicit `jsonSchema` or Standard JSON Schema conversion.
- [x] Independent provider/model/credential/base URL configurations with network policy checks.
- [x] Separate provider request deadlines and enclosing execution cancellation.
- [x] Typed tool descriptors and lifecycle execution on the parent saga stack.
- [x] Uniform `{ data, $aiMetrics, aiMetrics }` output for every output type.
- [x] Offline runtime integration tests and compile-time inference checks.

### Binding execution contracts

**Schemas:** `schema` validates the final parsed JSON and supplies the inferred output
(including transforms). Native enforcement defaults to true when an output schema is
present. Supply `jsonSchema` or implement Standard JSON Schema output conversion;
otherwise reject configuration before dispatch. With native enforcement disabled,
local validation and bounded repair still apply. Conversion uses `draft-2020-12`;
provider adapters must explicitly translate supported dialects or reject unsupported
schemas. They must not silently drop constraints. Tool schemas use **input** conversion,
whereas final response schemas use **output** conversion. Without a schema, return raw
response text as `data: string` and do not JSON-parse it.

**Fallback:** Every entry is an `AiModelConfig` with an explicit provider. Credentials
resolve from that entry's `apiKey` (static or contextual), then its provider's standard
environment variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`). Custom
and Ollama providers have no implicit credentials; custom providers require `baseUrl`.
Check every configured endpoint in BEFORE, and recheck the selected destination before
each request. Never reuse credentials across providers or forward them on redirects.
Adapters must disable automatic redirects. `resolveModel` validates and checks a
single model; the engine calls it for the complete cascade.

**Deadlines:** `requestTimeoutMs` aborts one provider request and may trigger fallback.
`getExecutionSignal(ctx)` resolves the runtime's callable `$signal()` accessor or plain
`signal`. `withAiRequest` combines it with a request timer, cleans up resources, and
passes the resulting signal to the adapter. Adapters must bind that signal to transport.
An aborted execution signal, exhausted step deadline, policy violation, authentication
failure, tool failure, or invalid configuration terminates execution. Only typed
`AiRequestTimeoutError` and `AiProviderError` statuses 429/500–599 qualify for fallback.
Do not classify an arbitrary `AbortError` as a request timeout. All attempts share the
remaining enclosing step budget; fallback never resets it.

**Tools and sagas:** Use `defineAiTool` with an argument schema, native input JSON Schema,
and explicit `mapInput(args, ctx)`. Reject duplicate/unknown names and malformed arguments
before invoking any step. `executeAiTool` invokes `Step.start` with the parent `stackId`,
signal, and effective network perimeter; it does not call `step.action` directly. The
returned value is the tool step's output snapshot, excluding workflow metadata/history.
The agent loop executes calls sequentially, at most `maxToolTurns` rounds (default 5),
and stops on any tool failure. Successful tool compensations immediately join the parent
saga and run in reverse order if inference later fails or a downstream step fails.
Do not add a second AI-level rollback handler for those same tools. Side effects without
step compensation remain irreversible. Automatic AI-step retries and caching with tools
are prohibited in the initial engine; they can replay or skip side effects. Durable
mid-agent resume is out of scope for the initial engine.

**Outputs and metrics:** Always return `AiStepResult<T>`; downstream steps read `ctx.data`
or `$steps.<name>.data`. Never flatten model-generated fields into execution context.
Count tokens for every successful provider response, including tool and repair turns.
Unknown prices yield `estimatedCostUsd: undefined`; adapters must not invent prices.
A typed `ai:complete` core event carries metrics without prompt/response bodies.
Existing lifecycle events also cover tool execution.

---

## 1. Executive Summary & Problem Space

Integrating Large Language Models (LLMs) and generative AI into enterprise workflow orchestrations introduces non-deterministic outputs, transient rate limits (`429`), latency spikes, and severe security challenges. When developers call LLM SDKs directly within workflow steps, workflows suffer from systemic failure modes:

| Ad-Hoc LLM Anti-Pattern | Operational Risk in Distributed Workflows | How `@siglo/ai` Solves It |
|---|---|---|
| **Unregulated Network Egress** | AI SDK calls bypass the workflow network perimeter, risking SSRF, data leakage, or unauthorized API access. | Enforces Siglo's AsyncLocalStorage (ASL) network egress policy (`allowNetwork`). Statically asserts provider hosts (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`) in the `BEFORE` phase. |
| **Runtime Data Corruption** | Unstructured or malformed JSON responses crash downstream steps without clear type guarantees. | Native JSON Schema structured output APIs backed by Standard Schema V1 (`~standard` with Zod, Valibot, ArkType), inferring typed outputs directly into the workflow context. |
| **Fragile One-Shot Failures** | Minor JSON syntax or enum hallucinations fail the entire workflow. | Automatic **Self-Healing Prompt Repair Loop**: captures validation diagnostics and feeds them into an ephemeral correction turn before failing. |
| **Provider Rate Limiting (`429`) & Outages** | Sudden traffic spikes or provider outages crash critical business pipelines. | **Model Fallback Cascades**: automatically routes requests through fallback providers (e.g., Claude 3.5 Sonnet &rarr; GPT-4o &rarr; Gemini 2.0 Flash) on `429`, `5xx`, or timeout. |
| **Dangling TCP Sockets on Timeout** | Standard AI client calls hang indefinitely during heavy generation or streaming when a workflow timeout triggers. | First-class `AbortSignal` binding: Siglo step timeouts and flow cancellation cooperatively abort the provider request and close underlying sockets. |
| **Redundant Token Expense on Retries** | Upstream step failures or idempotent retries re-execute expensive LLM prompts repeatedly. | Integrates with Siglo's deterministic step caching (`step.cache()`) and prompt input hashing, returning cached outputs without touching the network. |
| **Telemetry & Cost Black Holes** | No visibility into token consumption, latency, or dollar cost inside APM tools. | Injects OpenTelemetry GenAI Semantic Convention attributes (`gen_ai.*`), emits live DevTools events, and records metrics in `$steps.<name>.aiMetrics`. |
| **Isolated Execution (No Tool Access)** | LLMs cannot interact with workflow state or invoke internal business steps. | **Agentic Step Calling**: exposes existing Siglo steps directly as typed tools to the model within a managed execution loop. |

---

## 2. Architectural Design & Step Lifecycle Integration

Siglo executes steps through a formal 5-phase lifecycle: `BEFORE` &rarr; `VALIDATION` &rarr; `ACTION` &rarr; `AFTER` &rarr; `COMPENSATE`. `@siglo/ai` hooks natively into every phase:

```
+---------------------------------------------------------------------------------------------------+
|                                  aiStep('analyzeContract', ...)                                   |
+---------------------------------------------------------------------------------------------------+
| 1. BEFORE Phase (Perimeter & Cache Check)                                                         |
|    - Evaluates input context to dynamically resolve prompt strings or ChatMessage[].              |
|    - Validates target provider hostname against active AsyncLocalStorage (ASL) network policy     |
|      (e.g., 'api.anthropic.com', 'api.openai.com'). Throws NetworkPolicyViolationException if blocked.|
|    - Evaluates step cache: if input fingerprint matches and cache is valid, bypasses inference.   |
|                                                                                                   |
| 2. VALIDATION Phase (Input Validation)                                                            |
|    - Validates dynamic prompt inputs against optional input schema before dispatching inference.  |
|                                                                                                   |
| 3. ACTION Phase (Inference, Fallback Cascade & Self-Healing Loop)                                |
|    - Obtains active OpenTelemetry Span and injects W3C trace headers.                             |
|    - Links Step timeout signal and Flow AbortSignal to cooperative provider AbortSignal.          |
|    - Selects primary model and dispatches request:                                                |
|        * Primary Success: Extracts structured JSON output.                                        |
|        * Rate Limit (429) / Transient (5xx) / Timeout:                                            |
|            Instantly cascades to next fallback model in options.fallbackModels.                   |
|    - Validates output against Standard Schema (Zod / Valibot / ArkType):                          |
|        * IF Validation Fails:                                                                     |
|            Enters Self-Healing Repair Loop (up to maxRepairAttempts).                             |
|            Feeds invalid JSON and schema error issues into an ephemeral repair prompt.            |
|            Extracts and re-validates corrected response.                                          |
|                                                                                                   |
| 4. AFTER Phase (Telemetry & Metrics Accounting)                                                   |
|    - Computes token usage (promptTokens, completionTokens, totalTokens) and estimatedCostUsd.     |
|    - Enriches context with $steps.<name>.aiMetrics and emits 'ai:complete' to Live DevTools.      |
|    - Caches output if step.cache() is configured.                                                 |
|                                                                                                   |
| 5. COMPENSATION Phase (Agentic Sagas)                                                             |
|    - If the AI step invoked side-effecting tools during an agentic tool loop, executes            |
|      compensating rollback handlers in reverse order upon downstream workflow failure.             |
+---------------------------------------------------------------------------------------------------+
```

---

## 3. Core Features & Capabilities

### 1. Modern Multi-Provider Abstraction
* **Anthropic**: Messages API with native Tool Use and JSON output (`claude-3-5-sonnet`, `claude-3-5-haiku`, `claude-3-7-sonnet`).
* **OpenAI**: Chat Completions & Structured Outputs (`gpt-4o`, `gpt-4o-mini`, `o1`, `o3-mini`).
* **Google Gemini**: Gemini API with Response Schema (`gemini-1.5-pro`, `gemini-1.5-flash`, `gemini-2.0-flash`).
* **Local & Self-Hosted**: Generic OpenAI-compatible client for Ollama, vLLM, and LocalAI (with explicit localhost/private IP policy verification).

### 2. Native Structured Outputs & Standard Schema V1
* Prioritizes **Native Provider Schema Enforcement** (OpenAI `response_format: { type: 'json_schema' }`, Gemini `responseJsonSchema`, Anthropic tool constraints).
* Uses the **Standard Schema V1 (`~standard`)** specification supported across Zod, Valibot, and ArkType.
* Inferred TypeScript types flow directly into accumulated context without manual type assertions.

### 3. Self-Healing Prompt Repair Algorithm
* If a model fails schema parsing or emits malformed output, `@siglo/ai` intercepts the error and executes an automated repair turn:
  ```
  System: You previously emitted invalid JSON that failed the required schema.
  Errors: [ { path: 'riskLevel', message: 'Expected LOW | MEDIUM | HIGH, received UNKNOWN' } ]
  Invalid Payload: { ... }
  Instruction: Output ONLY valid JSON fixing the schema violations.
  ```
* Bounded by `maxRepairAttempts` (default: 2) to prevent infinite loops and runaway costs.

### 4. Model Fallback Cascades
* Declares resilient fallback lists: `fallbackModels: [{ provider: 'openai', model: 'gpt-4o' }, { provider: 'gemini', model: 'gemini-2.0-flash' }]`.
* If the primary model hits a `429 Too Many Requests`, `503 Service Unavailable`, or timeout, `@siglo/ai` switches immediately to the secondary provider, preserving workflow momentum.

### 5. Step-as-Tool Agentic Execution
* Allows developers to wrap standard Siglo steps in typed tool descriptors into the AI step:
  ```typescript
  aiStep('researchAgent', {
    model: { provider: 'openai', model: 'gpt-4o' },
    prompt: 'Research the supplied topic.',
    tools: [searchDatabaseTool, fetchWeatherTool], // defineAiTool descriptors
    maxToolTurns: 5
  })
  ```
* Tool calls execute within Siglo's step lifecycle, respecting timeouts, ASL network policies, and saga compensations.

### 6. Observability & Token Cost Accounting
* Conforms to **OpenTelemetry GenAI Semantic Conventions** (`gen_ai.provider.name`, legacy `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`).
* Estimates baseline cost from a versioned token pricing snapshot and per-model overrides, recording metrics in `$steps.<name>.aiMetrics`.

---

## 4. TypeScript API contracts

Implemented source of truth: [`packages/ai/src/types.ts`](../packages/ai/src/types.ts).
`AiModelConfig`, `AiTool`, `AiStepOptions`, `AiStepResult`, and `AiOutput` are exported.
`AiStep` extends `Step<TInput, AiStepResult<TOutput>, TName>`. Its factory has separate
schema-present and schema-absent overloads: schema-free calls infer `string`, and
schema-backed calls infer `StandardSchemaV1.InferOutput<TSchema>`.

```typescript
import type { AiStepOptions, AiStepResult } from '@siglo/ai';
import type { StandardSchemaV1 } from '@siglo/http';

// An example configuration contract; no provider call is made by this object.
const options: AiStepOptions = {
  model: { provider: 'anthropic', model: 'your-claude-model', requestTimeoutMs: 15_000 },
  fallbackModels: [{ provider: 'openai', model: 'your-openai-model', requestTimeoutMs: 10_000 }],
  prompt: 'Summarize the supplied document.'
};
type StructuredResult<S extends StandardSchemaV1> =
  AiStepResult<StandardSchemaV1.InferOutput<S>>;
```

---

## 5. Usage scenarios

### Scenario: Structured Financial Risk Assessment with Fallback Cascade

```typescript
import { flow } from 'siglo';
import { aiStep } from '@siglo/ai';
import { z } from 'zod';

// Standard Schema definition
const RiskAssessmentSchema = z.object({
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  confidenceScore: z.number().min(0).max(1),
  flaggedItems: z.array(z.string()),
  recommendedAction: z.enum(['APPROVE', 'MANUAL_REVIEW', 'DECLINE']),
  reasoning: z.string()
});

interface LoanApplicationContext {
  applicantId: string;
  applicantName: string;
  creditScore: number;
  loanAmount: number;
  debtToIncomeRatio: number;
}

export const assessLoanApplication = aiStep('assessLoan', {
  model: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
  fallbackModels: [
    { provider: 'openai', model: 'gpt-4o' },
    { provider: 'gemini', model: 'gemini-2.0-flash' }
  ],
  temperature: 0.1,
  schema: RiskAssessmentSchema,
  jsonSchema: z.toJSONSchema(RiskAssessmentSchema), // Zod 4; explicit conversion
  maxRepairAttempts: 2,
  prompt: (ctx: LoanApplicationContext) => [
    {
      role: 'system',
      content: 'You are an expert underwriter. Analyze financial applications strictly against standard credit risk guidelines.'
    },
    {
      role: 'user',
      content: `Applicant: ${ctx.applicantName} (ID: ${ctx.applicantId})\nCredit Score: ${ctx.creditScore}\nRequested: $${ctx.loanAmount}\nDTI: ${ctx.debtToIncomeRatio}%`
    }
  ]
});

// Composed into a durable workflow:
export const loanPipeline = flow(
  fetchCreditReportStep,
  assessLoanApplication,
  // TypeScript guarantees ctx.data.riskLevel and ctx.data.recommendedAction are available!
  dispatchDecisionStep
);
```

### Scenario: Agentic Step Execution with Tools

```typescript
import { aiStep, defineAiTool } from '@siglo/ai';
import { z } from 'zod';
import { queryDatabaseStep, calculateMortgageStep } from './steps';

const querySchema = z.object({ customerId: z.string() });
const mortgageSchema = z.object({ principal: z.number(), annualRate: z.number(), months: z.number() });
const queryDatabaseTool = defineAiTool({
  name: 'queryDatabase', description: 'Look up a customer portfolio',
  step: queryDatabaseStep, inputSchema: querySchema, jsonSchema: z.toJSONSchema(querySchema),
  mapInput: (args) => args
});
const calculateMortgageTool = defineAiTool({
  name: 'calculateMortgage', description: 'Calculate mortgage payments',
  step: calculateMortgageStep, inputSchema: mortgageSchema, jsonSchema: z.toJSONSchema(mortgageSchema),
  mapInput: (args) => args
});
const advisorySchema = z.object({
  summary: z.string(), estimatedMonthlyPayment: z.number(), suggestedProducts: z.array(z.string())
});

export const agenticAdvisoryStep = aiStep('financialAdvisor', {
  model: { provider: 'openai', model: 'gpt-4o' },
  prompt: 'Provide personalized mortgage advice based on client portfolio.',
  tools: [queryDatabaseTool, calculateMortgageTool],
  maxToolTurns: 4,
  schema: advisorySchema,
  jsonSchema: z.toJSONSchema(advisorySchema)
});
```

---

## 6. Testing Strategy & Zero-Network Verification

1. **Deterministic Offline Replay (`MockAiProvider`)**:
   * Uses `@siglo/ai/testing`'s `MockAiProvider` to record and replay exact model responses without making external API calls.
   * Completely integrated with `@siglo/testing`'s `WorkflowHarness`.
2. **Schema Repair Simulation**:
   * Configures `MockAiProvider` to emit malformed JSON on attempt 1 and compliant JSON on attempt 2.
   * Asserts that `repairAttempts === 1` and that final step output satisfies the schema.
3. **Fallback Cascade Verification**:
   * Simulates a `429 Rate Limit` on the primary model (Anthropic).
   * Asserts seamless failover to the secondary model (OpenAI) with `fallbackCount === 1`.
4. **ASL Network Perimeter Egress Assertion**:
   * Asserts that custom base URLs (e.g. `http://malicious-host.com/v1`) are blocked by `NetworkPolicyViolationException` in the `BEFORE` phase.
   * Asserts localhost protection (`allowLocalhost: false`) prevents SSRF against internal services.

---

## 7. Phase 3 Checklist & Deliverables

- [x] Monorepo package directory setup and prerequisite helpers: `packages/ai`.
- [x] Provider adapters:
  - [x] Anthropic (Messages API, Claude 3.5/3.7 Sonnet).
  - [x] OpenAI (Chat Completions & native JSON Schema Structured Outputs).
  - [x] Google Gemini (Generate Content API with responseJsonSchema).
  - [x] Generic OpenAI-compatible adapter (Ollama, vLLM).
- [x] Standard Schema V1 (`~standard`) output extractor with full TypeScript inference.
- [x] Self-healing repair loop algorithm with error prompt synthesis.
- [x] Model fallback cascade engine (`429`, `5xx`, and timeout failover).
- [x] Step-as-Tool execution bridge (parent saga, lifecycle, policy and cancellation).
- [x] Managed agent loop, tool-turn bounds, and provider tool-message serialization.
- [x] OpenTelemetry GenAI Semantic Convention telemetry & token pricing module.
- [x] Integration with `@siglo/core`'s `step.cache()` and ASL network policies.
- [x] Deterministic mock provider in `@siglo/ai/testing` (100% lines/statements/functions; zero external network egress in AI tests).


## 8. Initial release boundaries

- Streaming and durable resume inside an agent loop are excluded. Tool-bearing AI steps
  reject retries, cached/idempotent replay and failure recovery; ordinary inference steps
  support the core cache with prompt/model/credential-scoped SHA-256 fingerprints.
- Native primitive/array responses use an internal object envelope for OpenAI/Anthropic.
  Provider-specific schema/model incompatibilities fail rather than silently removing constraints.
- Old model names above are configuration examples, not availability guarantees. Model IDs
  are passed through to providers unchanged. Gemini uses Generate Content JSON Schema fields
  and preserves signed model parts across tool turns.
- Pricing is an estimated baseline snapshot, not provider billing. Unknown model prices
  remain undefined. Bump `cacheVersion` for changed validator/prompt closure semantics.
- Live API smoke tests require the deployment's own credentials and supported model IDs;
  they are not part of zero-network CI. Wire contracts are tested with injected transports.

See [`packages/ai/README.md`](../packages/ai/README.md) and [`docs/adapters/ai.md`](../docs/adapters/ai.md) for working configuration, tool,
cache, telemetry and replay examples, plus official provider references.
