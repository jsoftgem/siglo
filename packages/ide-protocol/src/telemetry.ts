/**
 * Milestone 4: Ecosystem Deep-Dive Telemetry Models & Fail-Closed Sanitization
 *
 * Implements strict, zero-execution, fail-closed validation and sanitization
 * for imported ecosystem telemetry recordings.
 */

export interface HttpTelemetryRecord {
    kind: 'http';
    method?: string;
    url?: string; // Origin-only sanitized URL (e.g. https://api.stripe.com)
    status?: number;
    retryAttempts?: number;
    requestAttempt?: number;
    retryDelayMs?: number;
    retryAfterMs?: number;
    retryDelaySource?: 'retry-after' | 'backoff';
    traceId?: string;
    policy?: 'allowed' | 'denied' | 'unknown';
}

export interface CryptoTelemetryRecord {
    kind: 'crypto';
    provider?: string;
    payloadBytes?: number;
    category?:
        | 'verified'
        | 'rejected'
        | 'invalid-payload'
        | 'payload-too-large'
        | 'missing-secret'
        | 'unknown-provider'
        | 'missing-signature'
        | 'timestamp-rejected'
        | 'replay-detected'
        | 'invalid-signature';
    timestampCheck?: 'passed' | 'failed' | 'unavailable';
    replayCheck?: 'passed' | 'failed' | 'unavailable';
}

export interface NotificationTelemetryRecord {
    kind: 'notification';
    channel?: string;
    notificationId?: string;
    approval?: boolean;
    approvalExpiresAt?: number;
    approvalState?:
        'requested' | 'approved' | 'rejected' | 'forbidden' | 'cancelled' | 'expired' | 'conflict' | 'failed';
    tokenStatus?: 'issued' | 'unavailable';
    contentPreview?: {
        subject?: string;
        bodySnippet?: string;
        recipientMasked?: string;
    };
}

export interface AiTelemetryRecord {
    kind: 'ai';
    inferenceAttempt?: number;
    phase?: 'attempt' | 'completion' | 'preflight';
    provider?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    repairAttempts?: number;
    fallbackCount?: number;
}

export type EcosystemInspectionData = {
    version: 1;
    outcome: 'success' | 'failure';
    durationMs?: number;
    truncated?: boolean;
} & (HttpTelemetryRecord | CryptoTelemetryRecord | NotificationTelemetryRecord | AiTelemetryRecord);

export interface EcosystemTelemetryEnvelope {
    version: 1;
    workflowName: string;
    workflowVersion?: number | string;
    stepIdentity: string; // matches node.id or node.name
    attempt?: number;
    timestamp?: number | string;
    inspection: EcosystemInspectionData;
}

export interface TelemetryRecordingDocument {
    version: 1;
    fileName?: string;
    importedAt: string;
    records: EcosystemTelemetryEnvelope[];
}

const ALLOWED_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ALLOWED_HTTP_POLICIES = new Set(['allowed', 'denied', 'unknown']);
const ALLOWED_RETRY_SOURCES = new Set(['retry-after', 'backoff']);

const ALLOWED_CRYPTO_CATEGORIES = new Set([
    'verified',
    'rejected',
    'invalid-payload',
    'payload-too-large',
    'missing-secret',
    'unknown-provider',
    'missing-signature',
    'timestamp-rejected',
    'replay-detected',
    'invalid-signature',
]);

const ALLOWED_CHECKS = new Set(['passed', 'failed', 'unavailable']);

const ALLOWED_NOTIFICATION_CHANNELS = new Set(['email', 'slack', 'discord', 'sms', 'push']);
const ALLOWED_APPROVAL_STATES = new Set([
    'requested',
    'approved',
    'rejected',
    'forbidden',
    'cancelled',
    'expired',
    'conflict',
    'failed',
]);

const ALLOWED_TOKEN_STATUSES = new Set(['issued', 'unavailable']);
const ALLOWED_AI_PHASES = new Set(['attempt', 'completion', 'preflight']);

/**
 * Sanitizes URLs down to scheme + host origin only.
 * Completely strips path, query parameters, credentials, fragments, and port if default.
 * Returns undefined if url is not a valid http/https URL.
 */
export function sanitizeOriginUrl(rawUrl?: string): string | undefined {
    if (!rawUrl || typeof rawUrl !== 'string') return undefined;
    try {
        const u = new URL(rawUrl);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
            return u.origin;
        }
    } catch {
        // Fallback for partial origins or schemes
        const match = rawUrl.match(/^(https?:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?)/i);
        if (match) return match[1];
    }
    return undefined;
}

/**
 * Formats a clean, origin-only cURL command for clipboard copy without exposing sensitive payloads or headers.
 */
export function formatOriginCurl(method?: string, url?: string): string {
    const origin = sanitizeOriginUrl(url) || 'https://unknown-host';
    const cleanMethod = method && ALLOWED_HTTP_METHODS.has(method.toUpperCase()) ? method.toUpperCase() : 'GET';
    return `curl -X ${cleanMethod} ${origin}`;
}

/**
 * Sanitizes raw telemetry inspection objects with fail-closed validation.
 * Never allows raw secrets, signatures, headers, or unallowlisted fields.
 */
export function sanitizeTelemetryInspection(val: any): EcosystemInspectionData | undefined {
    if (!val || typeof val !== 'object' || val.version !== 1) return undefined;
    if (val.outcome !== 'success' && val.outcome !== 'failure') return undefined;

    const kind = val.kind;
    if (!['http', 'crypto', 'notification', 'ai'].includes(kind)) return undefined;

    const clean: any = {
        version: 1,
        kind,
        outcome: val.outcome,
    };

    if (typeof val.durationMs === 'number' && Number.isFinite(val.durationMs) && val.durationMs >= 0) {
        clean.durationMs = val.durationMs;
    }
    if (val.truncated === true) {
        clean.truncated = true;
    }

    if (kind === 'http') {
        if (typeof val.method === 'string' && ALLOWED_HTTP_METHODS.has(val.method.toUpperCase())) {
            clean.method = val.method.toUpperCase();
        }
        const origin = sanitizeOriginUrl(val.url);
        if (origin) {
            clean.url = origin;
        }
        if (typeof val.status === 'number' && Number.isInteger(val.status) && val.status >= 100 && val.status <= 599) {
            clean.status = val.status;
        }
        if (typeof val.retryAttempts === 'number' && Number.isInteger(val.retryAttempts) && val.retryAttempts >= 0) {
            clean.retryAttempts = val.retryAttempts;
        }
        if (typeof val.requestAttempt === 'number' && Number.isInteger(val.requestAttempt) && val.requestAttempt >= 0) {
            clean.requestAttempt = val.requestAttempt;
        }
        if (typeof val.retryDelayMs === 'number' && Number.isFinite(val.retryDelayMs) && val.retryDelayMs >= 0) {
            clean.retryDelayMs = val.retryDelayMs;
        }
        if (typeof val.retryAfterMs === 'number' && Number.isFinite(val.retryAfterMs) && val.retryAfterMs >= 0) {
            clean.retryAfterMs = val.retryAfterMs;
        }
        if (typeof val.retryDelaySource === 'string' && ALLOWED_RETRY_SOURCES.has(val.retryDelaySource)) {
            clean.retryDelaySource = val.retryDelaySource;
        }
        if (typeof val.traceId === 'string') {
            clean.traceId = val.traceId.slice(0, 128);
        }
        if (typeof val.policy === 'string' && ALLOWED_HTTP_POLICIES.has(val.policy)) {
            clean.policy = val.policy;
        }
    } else if (kind === 'crypto') {
        if (typeof val.provider === 'string') {
            clean.provider = val.provider.slice(0, 64);
        }
        if (typeof val.payloadBytes === 'number' && Number.isInteger(val.payloadBytes) && val.payloadBytes >= 0) {
            clean.payloadBytes = val.payloadBytes;
        }
        if (typeof val.category === 'string' && ALLOWED_CRYPTO_CATEGORIES.has(val.category)) {
            clean.category = val.category;
        }
        if (typeof val.timestampCheck === 'string' && ALLOWED_CHECKS.has(val.timestampCheck)) {
            clean.timestampCheck = val.timestampCheck;
        }
        if (typeof val.replayCheck === 'string' && ALLOWED_CHECKS.has(val.replayCheck)) {
            clean.replayCheck = val.replayCheck;
        }
        // Exclude ANY raw signatures, keys, tokens, or secret fields
    } else if (kind === 'notification') {
        if (typeof val.channel === 'string' && ALLOWED_NOTIFICATION_CHANNELS.has(val.channel)) {
            clean.channel = val.channel;
        }
        if (typeof val.notificationId === 'string') {
            clean.notificationId = val.notificationId.slice(0, 128);
        }
        if (typeof val.approval === 'boolean') {
            clean.approval = val.approval;
        }
        if (typeof val.approvalExpiresAt === 'number' && Number.isFinite(val.approvalExpiresAt)) {
            clean.approvalExpiresAt = val.approvalExpiresAt;
        }
        if (typeof val.approvalState === 'string' && ALLOWED_APPROVAL_STATES.has(val.approvalState)) {
            clean.approvalState = val.approvalState;
        }
        if (typeof val.tokenStatus === 'string' && ALLOWED_TOKEN_STATUSES.has(val.tokenStatus)) {
            clean.tokenStatus = val.tokenStatus;
        }
        if (val.contentPreview && typeof val.contentPreview === 'object') {
            clean.contentPreview = {
                ...(typeof val.contentPreview.subject === 'string'
                    ? { subject: val.contentPreview.subject.slice(0, 128) }
                    : {}),
                ...(typeof val.contentPreview.bodySnippet === 'string'
                    ? { bodySnippet: val.contentPreview.bodySnippet.slice(0, 256) }
                    : {}),
                ...(typeof val.contentPreview.recipientMasked === 'string'
                    ? { recipientMasked: val.contentPreview.recipientMasked.slice(0, 64) }
                    : {}),
            };
        }
    } else if (kind === 'ai') {
        if (typeof val.provider === 'string') {
            clean.provider = val.provider.slice(0, 64);
        }
        if (typeof val.model === 'string') {
            clean.model = val.model.slice(0, 128);
        }
        if (typeof val.inferenceAttempt === 'number' && Number.isInteger(val.inferenceAttempt)) {
            clean.inferenceAttempt = val.inferenceAttempt;
        }
        if (typeof val.phase === 'string' && ALLOWED_AI_PHASES.has(val.phase)) {
            clean.phase = val.phase;
        }
        if (typeof val.promptTokens === 'number' && Number.isInteger(val.promptTokens) && val.promptTokens >= 0) {
            clean.promptTokens = val.promptTokens;
        }
        if (
            typeof val.completionTokens === 'number' &&
            Number.isInteger(val.completionTokens) &&
            val.completionTokens >= 0
        ) {
            clean.completionTokens = val.completionTokens;
        }
        if (typeof val.totalTokens === 'number' && Number.isInteger(val.totalTokens) && val.totalTokens >= 0) {
            clean.totalTokens = val.totalTokens;
        }
        if (
            typeof val.estimatedCostUsd === 'number' &&
            Number.isFinite(val.estimatedCostUsd) &&
            val.estimatedCostUsd >= 0
        ) {
            clean.estimatedCostUsd = val.estimatedCostUsd;
        }
        if (typeof val.repairAttempts === 'number' && Number.isInteger(val.repairAttempts) && val.repairAttempts >= 0) {
            clean.repairAttempts = val.repairAttempts;
        }
        if (typeof val.fallbackCount === 'number' && Number.isInteger(val.fallbackCount) && val.fallbackCount >= 0) {
            clean.fallbackCount = val.fallbackCount;
        }
    }

    return clean;
}

/**
 * Validates and sanitizes a single telemetry recording envelope.
 * Returns undefined if required envelope fields are invalid.
 */
export function sanitizeTelemetryEnvelope(val: any): EcosystemTelemetryEnvelope | undefined {
    if (!val || typeof val !== 'object' || val.version !== 1) return undefined;
    if (typeof val.workflowName !== 'string' || !val.workflowName.trim()) return undefined;
    if (typeof val.stepIdentity !== 'string' || !val.stepIdentity.trim()) return undefined;

    const cleanInspection = sanitizeTelemetryInspection(val.inspection);
    if (!cleanInspection) return undefined;

    return {
        version: 1,
        workflowName: val.workflowName.trim(),
        ...(val.workflowVersion !== undefined ? { workflowVersion: val.workflowVersion } : {}),
        stepIdentity: val.stepIdentity.trim(),
        ...(typeof val.attempt === 'number' && val.attempt >= 0 ? { attempt: val.attempt } : {}),
        ...(val.timestamp !== undefined ? { timestamp: val.timestamp } : {}),
        inspection: cleanInspection,
    };
}

/**
 * Parses, validates, and sanitizes an entire telemetry recording JSON document.
 * Accepts either:
 * - A document object with `{ version: 1, records: [...] }`
 * - A raw array of telemetry envelopes `[...]`
 * Rejects unsupported versions and invalid records fail-closed.
 */
export function sanitizeTelemetryDocument(raw: unknown, fileName?: string): TelemetryRecordingDocument | undefined {
    if (!raw) return undefined;

    let recordsRaw: unknown[] | undefined;
    if (Array.isArray(raw)) {
        recordsRaw = raw;
    } else if (typeof raw === 'object' && raw !== null) {
        const obj = raw as Record<string, unknown>;
        if (obj.version !== undefined && obj.version !== 1) {
            // Version mismatch rejection
            return undefined;
        }
        if (Array.isArray(obj.records)) {
            recordsRaw = obj.records;
        } else if (obj.workflowName && obj.stepIdentity && obj.inspection) {
            // Single envelope passed as document
            recordsRaw = [obj];
        }
    }

    if (!recordsRaw || !recordsRaw.length) return undefined;

    const validRecords: EcosystemTelemetryEnvelope[] = [];
    for (const item of recordsRaw) {
        const clean = sanitizeTelemetryEnvelope(item);
        if (clean) {
            validRecords.push(clean);
        }
    }

    if (!validRecords.length) return undefined;

    return {
        version: 1,
        fileName,
        importedAt: new Date().toISOString(),
        records: validRecords,
    };
}

/**
 * Matches an imported telemetry envelope against a graph node.
 * Requires unambiguous matching on workflow name, version (if defined in both),
 * and step identity (matches either node.id or node.name).
 */
export function matchTelemetryRecord(
    record: EcosystemTelemetryEnvelope,
    workflowName: string,
    workflowVersion?: number | string,
    nodeOrId?: { id: string; name: string } | string | null,
    nodeName?: string,
): boolean {
    const id = typeof nodeOrId === 'string' ? nodeOrId : nodeOrId?.id;
    const name = typeof nodeOrId === 'string' ? nodeName : nodeOrId?.name || nodeName;
    if (record.workflowName !== workflowName) return false;

    if (
        record.workflowVersion !== undefined &&
        workflowVersion !== undefined &&
        String(record.workflowVersion) !== String(workflowVersion)
    ) {
        return false;
    }

    if (id && record.stepIdentity === id) return true;
    if (name && record.stepIdentity === name) return true;

    return false;
}
