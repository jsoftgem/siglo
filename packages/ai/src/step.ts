import { createHash } from 'node:crypto';
import { Step, SigloError, defaultStorageManager, recordInspection, captureInspection } from 'siglo';
import type { CacheOptions } from 'siglo';
import { validatePayload } from '@siglo/http';
import type { StandardSchemaV1 } from '@siglo/http';
import { createAiResult, getExecutionSignal, shouldFallback, withAiRequest } from './execution';
import { resolveModel, modelBaseUrl } from './models';
import { resolveJsonSchema } from './schema';
import { createAiProvider, STRUCTURED_OUTPUT_TOOL } from './providers';
import { describeAiTools, executeAiTool } from './tools';
import { estimateTokenCost } from './pricing';
import { recordAiCompletion } from './telemetry';
import type { AiStepOptions, AiStepResult, AiMetrics, ChatMessage, AiProviderResponse } from './types';

export class AiOutputValidationError extends SigloError {
  constructor(name: string, readonly diagnostics: unknown) {
    super('AI response failed output validation after bounded repair attempts', {
      stepName: name, phase: 'action', retryable: false
    });
    this.name = 'AiOutputValidationError';
    Object.setPrototypeOf(this, AiOutputValidationError.prototype);
  }
}
function integer(value: number | undefined, fallback: number, name: string, minimum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum) throw new TypeError(`${name} must be an integer >= ${minimum}`);
  return result;
}
function messages(prompt: string | ChatMessage[]): ChatMessage[] {
  if (typeof prompt === 'string') return [{ role: 'user', content: prompt }];
  if (!Array.isArray(prompt) || !prompt.length || prompt.some(m => !['system', 'user', 'assistant', 'tool'].includes(m.role) || typeof m.content !== 'string')) {
    throw new TypeError('AI prompt must be a string or non-empty ChatMessage array');
  }
  return structuredClone(prompt);
}

export class AiStep<TInput = any, TOutput = string, TName extends string = string>
  extends Step<TInput, AiStepResult<TOutput>, TName> {
  constructor(name: TName, private readonly aiOptions: AiStepOptions<TInput, any>) {
    super(name, async ctx => {
      try { return await this.infer(ctx); }
      catch (error) {
        recordInspection({ version: 1, kind: 'ai', outcome: 'failure', provider: aiOptions.model.provider, model: aiOptions.model.model });
        throw error;
      }
    });
    this.allowNetwork([
      ...[aiOptions.model, ...(aiOptions.fallbackModels ?? [])].map(m => new URL(modelBaseUrl(m)).host),
      ...(aiOptions.tools ?? []).flatMap(t => t.step.networkPolicyConfig?.allowedHosts ?? [])
    ]);
    // Preflight runs before the core cache lookup; ACTION repeats it for direct invocation.
    super.onBefore(async ctx => { await this.inspectedPreflight(ctx); return true; });
  }

  override onBefore(hook: (ctx: TInput) => boolean | Promise<boolean>): this {
    super.onBefore(async ctx => { await this.inspectedPreflight(ctx); return hook(ctx); });
    return this;
  }

  override onFail(...args: Parameters<Step<TInput, AiStepResult<TOutput>, TName>['onFail']>): this {
    if (this.aiOptions.tools?.length) throw new TypeError('AI steps with tools cannot use failure recovery or retries');
    super.onFail(...args);
    return this;
  }

  override idempotent(...args: Parameters<Step<TInput, AiStepResult<TOutput>, TName>['idempotent']>): this {
    if (this.aiOptions.tools?.length) throw new TypeError('AI steps with tools cannot use idempotent replay');
    super.idempotent(...args);
    return this;
  }

  override cache(options?: number | CacheOptions): this {
    if (this.aiOptions.tools?.length) throw new TypeError('AI steps with tools cannot be cached');
    const config = typeof options === 'object' ? options : { ttl: options };
    const customKey = config.keySerializer;
    super.cache({ stampedeProtection: false, ...config, keySerializer: (stepId, ctx, namespace) => {
      const o = this.aiOptions;
      const configs = [o.model, ...(o.fallbackModels ?? [])].map(m => resolveModel(m, ctx, this.name));
      const prompt = typeof o.prompt === 'function' ? o.prompt(ctx) : o.prompt;
      return createHash('sha256').update(JSON.stringify({ version: o.cacheVersion ?? '1', prompt,
        configs: configs.map(({ adapter: _adapter, ...config }) => config),
        schema: o.jsonSchema, validator: o.schema?.['~standard'].validate.toString(), temperature: o.temperature, maxTokens: o.maxTokens,
        input: customKey ? customKey(stepId, ctx, namespace) : ctx })).digest('hex');
    } });
    return this;
  }

  private async inspectedPreflight(ctx: TInput) {
    try { return await this.preflight(ctx); }
    catch (error) {
      recordInspection({ version: 1, kind: 'ai', outcome: 'failure', phase: 'preflight',
        provider: this.aiOptions.model.provider, model: this.aiOptions.model.model });
      throw error;
    }
  }

  private async preflight(ctx: TInput) {
    const o = this.aiOptions;
    integer(o.maxRepairAttempts, 2, 'maxRepairAttempts', 0);
    integer(o.maxToolTurns, 5, 'maxToolTurns', 0);
    if (o.maxTokens !== undefined) integer(o.maxTokens, 1, 'maxTokens', 1);
    if (o.temperature !== undefined && (!Number.isFinite(o.temperature) || o.temperature < 0 || o.temperature > 2)) {
      throw new TypeError('temperature must be between 0 and 2');
    }
    if (o.tools?.length && (this.cachedLast || this.onfail || this.idempotencyKey)) {
      throw new TypeError('AI steps with tools cannot use caching, retries, failure recovery or idempotent replay');
    }
    if (o.tools?.some(t => t.name === STRUCTURED_OUTPUT_TOOL)) throw new TypeError('Reserved structured output tool name');
    const tools = describeAiTools(o.tools ?? []);
    const jsonSchema = o.schema && o.enforceNativeStructuredOutputs !== false ? resolveJsonSchema(o.schema, o.jsonSchema) : undefined;
    const models = [o.model, ...(o.fallbackModels ?? [])].map(m => resolveModel(m, ctx, this.name));
    for (const model of models) {
      // Validate overrides before a request can incur expense.
      estimateTokenCost(model.provider, model.model, 0, 0, model.pricing);
    }
    const input = o.inputSchema ? await validatePayload<TInput>(o.inputSchema, ctx, 'validation', this.name) : ctx;
    return { models, tools, jsonSchema, input };
  }

  private async infer(ctx: TInput): Promise<AiStepResult<TOutput>> {
    const started = Date.now();
    const o = this.aiOptions;
    const prepared = await this.preflight(ctx);
    const prompt = typeof o.prompt === 'function' ? o.prompt(prepared.input) : o.prompt;
    const history = messages(prompt);
    const signal = getExecutionSignal(ctx as any);
    const maxRepairs = o.maxRepairAttempts ?? 2;
    const maxTools = o.maxToolTurns ?? 5;
    let selected = 0, repairs = 0, turns = 0, inputTokens = 0, outputTokens = 0, cost = 0;
    let knownCost = true;
    let inferenceAttempt = 0;
    const callIds = new Set<string>();
    for (;;) {
      signal?.throwIfAborted();
      const model = resolveModel(prepared.models[selected], prepared.input, this.name);
      const adapter = model.adapter ?? createAiProvider(model, { stepName: this.name, span: (ctx as any)?.$span ?? (ctx as any)?.span });
      let response: AiProviderResponse;
      const attemptStarted = Date.now();
      const attempt = ++inferenceAttempt;
      const content = captureInspection(o.capture, 'prompt', history);
      const inspect = (outcome: 'success' | 'failure') => recordInspection({ version: 1, kind: 'ai', outcome,
        phase: 'attempt', inferenceAttempt: attempt, provider: model.provider, model: model.model,
        durationMs: Date.now() - attemptStarted, content });
      try {
        response = await withAiRequest(requestSignal => adapter.generate({
          model: model.model, messages: structuredClone(history), signal: requestSignal,
          jsonSchema: prepared.jsonSchema, tools: prepared.tools,
          temperature: o.temperature, maxTokens: o.maxTokens
        }), signal, model.requestTimeoutMs);
      } catch (error) {
        inspect('failure');
        if (shouldFallback(error, signal) && selected + 1 < prepared.models.length) { selected++; continue; }
        throw error;
      }
      Object.assign(content, captureInspection(o.capture, 'output', response.text));
      inspect('success');
      signal?.throwIfAborted();
      if (typeof response.text !== 'string' || !Number.isSafeInteger(response.promptTokens) || response.promptTokens < 0 ||
          !Number.isSafeInteger(response.completionTokens) || response.completionTokens < 0) throw new Error('Invalid AI adapter response');
      inputTokens += response.promptTokens;
      outputTokens += response.completionTokens;
      const attemptCost = estimateTokenCost(model.provider, model.model, response.promptTokens, response.completionTokens, model.pricing);
      if (attemptCost === undefined) knownCost = false;
      else cost += attemptCost;
      const calls = response.toolCalls ?? [];
      if (calls.length) {
        if (turns >= maxTools) throw new SigloError('AI tool turn limit exceeded', { stepName: this.name, retryable: false });
        // Validate the entire batch before the first side effect.
        const pending = [];
        for (const call of calls) {
          const tool = o.tools?.find(t => t.name === call.name);
          if (!tool || typeof call.id !== 'string' || !call.id || callIds.has(call.id)) {
            throw new SigloError('Unknown AI tool or duplicate/invalid tool call ID', { stepName: this.name, retryable: false });
          }
          callIds.add(call.id);
          await validatePayload(tool.inputSchema, call.arguments, 'validation', tool.name);
          pending.push({ call, tool });
        }
        turns++;
        history.push({ role: 'assistant', content: response.text, toolCalls: calls, providerState: response.providerState });
        const runtime: any = ctx;
        const stackId = typeof runtime?.$stackId === 'function' ? runtime.$stackId() : runtime?.$stackId;
        const namespace = typeof runtime?.$namespace === 'function' ? runtime.$namespace() : runtime?.$namespace;
        const services = typeof runtime?.$services === 'function' ? runtime.$services() : runtime?.$services;
        for (const { call, tool } of pending) {
          const result = await executeAiTool(tool, call.arguments, prepared.input, { stackId, signal, namespace, services,
            monitor: stackId ? defaultStorageManager.getStack(stackId)?.monitor : undefined });
          signal?.throwIfAborted();
          history.push({ role: 'tool', name: call.name, toolCallId: call.id, content: JSON.stringify(result ?? null) });
        }
        continue;
      }
      let data: TOutput;
      try {
        data = o.schema ? await validatePayload<TOutput>(o.schema, JSON.parse(response.text), 'action', this.name) : response.text as TOutput;
      } catch (error: any) {
        const diagnostics = error?.errors ?? [{ message: error?.message ?? 'Invalid JSON' }];
        if (repairs >= maxRepairs) throw new AiOutputValidationError(this.name, diagnostics);
        repairs++;
        history.push({ role: 'assistant', content: response.text });
        history.push({ role: 'user', content: `Your previous output failed validation. Return ONLY corrected JSON. Validation diagnostics: ${JSON.stringify(diagnostics)}` });
        continue;
      }
      signal?.throwIfAborted();
      const metrics: AiMetrics = { promptTokens: inputTokens, completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens, latencyMs: Date.now() - started,
        modelUsed: model.model, providerUsed: model.provider, repairAttempts: repairs,
        fallbackCount: selected, estimatedCostUsd: knownCost ? cost : undefined };
      recordAiCompletion(this.name, metrics, ctx, captureInspection(o.capture, 'parsedOutput', data));
      return createAiResult(data, metrics);
    }
  }
}

export function aiStep<const N extends string, I = any, S extends StandardSchemaV1 = StandardSchemaV1>(
  name: N, options: AiStepOptions<I, S> & { schema: S }
): AiStep<I, StandardSchemaV1.InferOutput<S>, N>;
export function aiStep<const N extends string, I = any>(
  name: N, options: AiStepOptions<I> & { schema?: undefined }
): AiStep<I, string, N>;
export function aiStep<const N extends string, I = any, S extends StandardSchemaV1 = StandardSchemaV1>(
  name: N, options: AiStepOptions<I, S>
): AiStep<I, string | StandardSchemaV1.InferOutput<S>, N>;
export function aiStep(name: string, options: AiStepOptions<any, any>): AiStep<any, any, any> {
  return new AiStep(name, options);
}
