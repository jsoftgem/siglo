import type { Step } from 'siglo';
import type { StandardSchemaV1 } from '@siglo/http';

export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'custom';
export interface AiModelConfig<TInput = any> {
  provider: AiProvider;
  model: string;
  baseUrl?: string;
  /** Resolved independently for each provider. No implicit credential sharing. */
  apiKey?: string | ((ctx: TInput) => string);
  /** Per-request deadline; independent of the enclosing step deadline. */
  requestTimeoutMs?: number;
  /** Injectable provider boundary, including deterministic offline mocks. */
  adapter?: AiProviderAdapter;
  /** Override baseline USD prices per million tokens. */
  pricing?: TokenPricing;
}
export interface TokenPricing { inputPerMillion: number; outputPerMillion: number }
export interface ProviderState { provider: AiProvider; content: unknown }
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: AiToolCall[];
  providerState?: ProviderState;
}
export interface AiToolCall { id: string; name: string; arguments: unknown }
export interface AiMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  latencyMs: number;
  modelUsed: string;
  providerUsed: AiProvider;
  repairAttempts: number;
  fallbackCount: number;
}
/** Always wrapped, including object, array, primitive and schema-free text outputs. */
export interface AiStepResult<TOutput> {
  data: TOutput;
  $aiMetrics: AiMetrics;
  aiMetrics: AiMetrics;
}
export interface AiTool<TContext = any, TArgs = any, TInput = any, TOutput = any> {
  name: string;
  description: string;
  inputSchema: StandardSchemaV1<unknown, TArgs>;
  /** Native tool parameters describe pre-validation model input. */
  jsonSchema?: Record<string, unknown>;
  step: Step<TInput, TOutput>;
  /** Explicit mapping: model arguments never merge into workflow context automatically. */
  mapInput: (args: TArgs, ctx: TContext) => TInput;
}
export interface AiStepOptions<TInput = any, TSchema extends StandardSchemaV1 = StandardSchemaV1> {
  model: AiModelConfig<TInput>;
  fallbackModels?: AiModelConfig<TInput>[];
  prompt: string | ChatMessage[] | ((ctx: TInput) => string | ChatMessage[]);
  schema?: TSchema;
  /** Required for native output enforcement unless schema supports Standard JSON Schema. */
  jsonSchema?: Record<string, unknown>;
  inputSchema?: StandardSchemaV1;
  temperature?: number;
  maxTokens?: number;
  maxRepairAttempts?: number;
  /** Bump when validator or prompt closure semantics change across deployments. */
  cacheVersion?: string;
  tools?: AiTool<TInput>[];
  maxToolTurns?: number;
  enforceNativeStructuredOutputs?: boolean;
}
export type AiOutput<TSchema extends StandardSchemaV1 | undefined> =
  TSchema extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<TSchema> : string;

/** Adapter boundary for inference and deterministic offline providers. */
export interface AiProviderRequest {
  model: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  jsonSchema?: Record<string, unknown>;
  tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
  temperature?: number;
  maxTokens?: number;
}
export interface AiProviderResponse {
  text: string;
  toolCalls?: AiToolCall[];
  providerState?: ProviderState;
  promptTokens: number;
  completionTokens: number;
}
export interface AiProviderAdapter {
  generate(request: AiProviderRequest): Promise<AiProviderResponse>;
}
