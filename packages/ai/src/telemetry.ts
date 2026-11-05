import { trace } from '@opentelemetry/api';
import { emitMonitoringEvent, defaultStorageManager, stepInspectionStorage, sanitizeInspection, InspectionContent } from '@siglo/core';
import type { AiMetrics } from './types';

export function recordAiCompletion(name: string, metrics: AiMetrics, ctx: any, content?: InspectionContent): void {
  try {
    const span = ctx?.$span ?? ctx?.span ?? trace.getActiveSpan();
    if (span) {
      for (const [key, value] of Object.entries({
        'gen_ai.system': metrics.providerUsed,
        'gen_ai.provider.name': metrics.providerUsed === 'gemini' ? 'gcp.gemini' : metrics.providerUsed,
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': metrics.modelUsed,
        'gen_ai.response.model': metrics.modelUsed,
        'gen_ai.usage.input_tokens': metrics.promptTokens,
        'gen_ai.usage.output_tokens': metrics.completionTokens
      })) span.setAttribute(key, value);
    }
  } catch { /* Observability must not change inference outcomes. */ }
  try {
    const scope = stepInspectionStorage.getStore();
    if (scope) scope.ecosystemKind = 'ai';
    const stackId = scope?.stackId ?? (typeof ctx?.$stackId === 'function' ? ctx.$stackId() : ctx?.$stackId);
    if (stackId) {
      const namespace = scope?.namespace ?? (typeof ctx?.$namespace === 'function' ? ctx.$namespace() : ctx?.$namespace);
      emitMonitoringEvent({ monitor: scope?.monitor ?? defaultStorageManager.getStack(stackId)?.monitor }, {
        type: 'ai:complete', stackId, stepId: scope?.stepId ?? name, stepName: name,
        attempt: scope?.attempt, timestamp: Date.now(), namespace, aiMetrics: { ...metrics },
        inspection: sanitizeInspection({ version: 1, kind: 'ai', outcome: 'success',
          phase: 'completion', content, provider: metrics.providerUsed, model: metrics.modelUsed, ...metrics, durationMs: metrics.latencyMs })
      });
    }
  } catch { /* Observability cannot change inference outcomes. */ }
}
