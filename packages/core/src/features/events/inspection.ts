import { defaultStorageManager } from '../storage';
import { InspectionContent, sanitizeInspectionContent } from './capture';
import { AsyncLocalStorage } from 'node:async_hooks';
import { emitMonitoringEvent } from './emitter';

export type EcosystemInspection = {
    version: 1;
    outcome: 'success' | 'failure';
    durationMs?: number;
    truncated?: boolean;
    content?: InspectionContent;
} & (
    | { kind: 'http'; requestAttempt?: number; retryDelayMs?: number; retryAfterMs?: number; retryDelaySource?: 'retry-after' | 'backoff'; method?: string; url?: string; status?: number; retryAttempts?: number; traceId?: string; policy?: 'allowed' | 'denied' | 'unknown' }
    | { kind: 'crypto'; provider?: string; payloadBytes?: number; category?: 'verified' | 'rejected' | 'invalid-payload' | 'payload-too-large' | 'missing-secret' | 'unknown-provider' | 'missing-signature' | 'timestamp-rejected' | 'replay-detected' | 'invalid-signature'; timestampCheck?: 'passed' | 'failed' | 'unavailable'; replayCheck?: 'passed' | 'failed' | 'unavailable' }
    | { kind: 'notification'; channel?: string; notificationId?: string; approval?: boolean; approvalExpiresAt?: number; approvalState?: 'requested' | 'approved' | 'rejected' | 'forbidden' | 'cancelled' | 'expired' | 'conflict' | 'failed'; tokenStatus?: 'issued' | 'unavailable' }
    | { kind: 'ai'; inferenceAttempt?: number; phase?: 'attempt' | 'completion' | 'preflight'; provider?: string; model?: string; promptTokens?: number; completionTokens?: number; totalTokens?: number; estimatedCostUsd?: number; repairAttempts?: number; fallbackCount?: number }
);

// Merged workflow context outlives an individual step scope. Suppress its raw
// content after any ecosystem observation rather than leak earlier step results.
const ecosystemStacks = new WeakSet<object>();
export function hasEcosystemContent(stackId: string): boolean {
    const stack = defaultStorageManager.getStack(stackId);
    return !!stack && ecosystemStacks.has(stack);
}
function markEcosystemStack(stackId?: string): void {
    if (!stackId) return;
    const stack = defaultStorageManager.getStack(stackId);
    if (stack) ecosystemStacks.add(stack);
}

/** Runtime identity is independent of display names and follows nested async work. */
export const stepInspectionStorage = new AsyncLocalStorage<{
    stackId: string; stepId: string; stepName: string; attempt: number; namespace?: string; monitor?: any; ecosystemKind?: EcosystemInspection['kind'];
}>();

/** Strict metadata and bounded opt-in content allowlists. */
export function sanitizeInspection(value: any): EcosystemInspection | undefined {
    if (!value || value.version !== 1 || !['http', 'crypto', 'notification', 'ai'].includes(value.kind)
        || !['success', 'failure'].includes(value.outcome)) return undefined;
    const clean: any = { version: 1, kind: value.kind, outcome: value.outcome };
    const fields: Record<string, string[]> = {
        http: ['method', 'url', 'status', 'retryAttempts', 'requestAttempt', 'retryDelayMs', 'retryAfterMs', 'retryDelaySource', 'traceId', 'policy'],
        crypto: ['provider', 'payloadBytes', 'category', 'timestampCheck', 'replayCheck'],
        notification: ['channel', 'notificationId', 'approval', 'tokenStatus', 'approvalExpiresAt', 'approvalState'],
        ai: ['inferenceAttempt', 'phase', 'provider', 'model', 'promptTokens', 'completionTokens', 'totalTokens', 'estimatedCostUsd', 'repairAttempts', 'fallbackCount']
    };
    const numeric = new Set(['status', 'retryAttempts', 'payloadBytes', 'promptTokens', 'completionTokens', 'totalTokens', 'estimatedCostUsd', 'repairAttempts', 'fallbackCount', 'durationMs', 'inferenceAttempt', 'requestAttempt', 'retryDelayMs', 'retryAfterMs']);
    const enums: Record<string, string[]> = { method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        phase: ['attempt', 'completion', 'preflight'],
        retryDelaySource: ['retry-after', 'backoff'],
        policy: ['allowed', 'denied', 'unknown'], category: ['verified', 'rejected', 'invalid-payload', 'payload-too-large', 'missing-secret', 'unknown-provider', 'missing-signature', 'timestamp-rejected', 'replay-detected', 'invalid-signature'],
        timestampCheck: ['passed', 'failed', 'unavailable'], replayCheck: ['passed', 'failed', 'unavailable'],
        approvalState: ['requested', 'approved', 'rejected', 'forbidden', 'cancelled', 'expired', 'conflict', 'failed'],
        tokenStatus: ['issued', 'unavailable'], channel: ['email', 'slack', 'discord', 'sms', 'push'] };
    for (const key of [...fields[value.kind], 'durationMs']) {
        const val = value[key];
        if (key === 'url') {
            try { const u = new URL(val); if (['http:', 'https:'].includes(u.protocol)) clean.url = u.origin; } catch { /* unavailable */ }
        } else if (key === 'approvalExpiresAt') {
            if (typeof val === 'number' && Number.isSafeInteger(val) && val >= 0 && val <= 8640000000000000) clean[key] = val;
        } else if (numeric.has(key)) {
            if (typeof val === 'number' && Number.isFinite(val) && val >= 0) clean[key] = val;
        } else if (enums[key]) {
            if (enums[key].includes(val)) clean[key] = val;
        } else if (key === 'approval') {
            if (typeof val === 'boolean') clean[key] = val;
        }
        else if (typeof val === 'string') {
            const text = Buffer.from(val).subarray(0, 256).toString('utf8');
            clean[key] = text;
            if (text !== val) clean.truncated = true;
        }
    }
    const content = sanitizeInspectionContent(value.content, value.kind);
    if (content) {
        clean.content = content;
        if (Object.values(content).some(entry => entry?.truncated)) clean.truncated = true;
    }
    if (value.truncated === true) clean.truncated = true;
    return clean;
}

export function recordInspection(inspection: EcosystemInspection): void {
    try {
        const scope = stepInspectionStorage.getStore();
        if (scope) scope.ecosystemKind = inspection.kind;
        markEcosystemStack(scope?.stackId);
        const safe = sanitizeInspection(inspection);
        if (scope && safe) emitMonitoringEvent({ monitor: scope.monitor }, {
            type: 'step:inspection', stackId: scope.stackId, stepId: scope.stepId,
            stepName: scope.stepName, attempt: scope.attempt, namespace: scope.namespace,
            timestamp: Date.now(), inspection: safe
        });
    } catch { /* Diagnostics cannot affect execution. */ }
}

export async function observeEcosystem<T>(
    base: EcosystemInspection, action: () => T | Promise<T>, summary?: (result: T) => Partial<EcosystemInspection>
): Promise<T> {
    const scope = stepInspectionStorage.getStore();
    if (scope) scope.ecosystemKind = base.kind;
    markEcosystemStack(scope?.stackId);
    const start = Date.now();
    try {
        const result = await action();
        try { recordInspection({ ...base, ...summary?.(result), outcome: 'success', durationMs: Date.now() - start } as EcosystemInspection); } catch { /* best effort */ }
        return result;
    } catch (error) {
        recordInspection({ ...base, outcome: 'failure', durationMs: Date.now() - start });
        throw error;
    }
}
