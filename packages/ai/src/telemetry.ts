import { trace } from '@opentelemetry/api';
import {
    emitMonitoringEvent,
    defaultStorageManager,
    stepInspectionStorage,
    sanitizeInspection,
    InspectionContent,
    isPlainObject,
} from '@siglo/core';
import type { SpanLike } from '@siglo/http';
import type { AiMetrics } from './types';

export function recordAiCompletion(name: string, metrics: AiMetrics, ctx: unknown, content?: InspectionContent): void {
    const ctxRecord = isPlainObject(ctx) ? ctx : undefined;
    try {
        const rawSpan = (ctxRecord?.$span ?? ctxRecord?.span ?? trace.getActiveSpan()) as SpanLike | undefined;
        if (rawSpan && typeof rawSpan.setAttribute === 'function') {
            for (const [key, value] of Object.entries({
                'gen_ai.system': metrics.providerUsed,
                'gen_ai.provider.name': metrics.providerUsed === 'gemini' ? 'gcp.gemini' : metrics.providerUsed,
                'gen_ai.operation.name': 'chat',
                'gen_ai.request.model': metrics.modelUsed,
                'gen_ai.response.model': metrics.modelUsed,
                'gen_ai.usage.input_tokens': metrics.promptTokens,
                'gen_ai.usage.output_tokens': metrics.completionTokens,
            }))
                rawSpan.setAttribute(key, value);
        }
    } catch {
        /* Observability must not change inference outcomes. */
    }
    try {
        const scope = stepInspectionStorage.getStore();
        if (scope) scope.ecosystemKind = 'ai';
        const rawStackId =
            typeof ctxRecord?.$stackId === 'function' ? (ctxRecord.$stackId as () => unknown)() : ctxRecord?.$stackId;
        const stackId = scope?.stackId ?? (typeof rawStackId === 'string' ? rawStackId : undefined);
        if (stackId) {
            const rawNs =
                typeof ctxRecord?.$namespace === 'function'
                    ? (ctxRecord.$namespace as () => unknown)()
                    : ctxRecord?.$namespace;
            const namespace = scope?.namespace ?? (typeof rawNs === 'string' ? rawNs : undefined);
            emitMonitoringEvent(
                { monitor: scope?.monitor ?? defaultStorageManager.getStack(stackId)?.monitor },
                {
                    type: 'ai:complete',
                    stackId,
                    stepId: scope?.stepId ?? name,
                    stepName: name,
                    attempt: scope?.attempt,
                    timestamp: Date.now(),
                    namespace,
                    aiMetrics: { ...metrics },
                    inspection: sanitizeInspection({
                        version: 1,
                        kind: 'ai',
                        outcome: 'success',
                        phase: 'completion',
                        content,
                        provider: metrics.providerUsed,
                        model: metrics.modelUsed,
                        ...metrics,
                        durationMs: metrics.latencyMs,
                    }),
                },
            );
        }
    } catch {
        /* Observability cannot change inference outcomes. */
    }
}
