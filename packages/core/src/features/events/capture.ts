import { redactValue } from './redaction';

export type InspectionContentField = 'requestHeaders' | 'requestBody' | 'responseHeaders' | 'responseBody' | 'prompt' | 'output' | 'parsedOutput' | 'preview';
export interface InspectionCapturePolicy {
    fields: InspectionContentField[];
    /** Per-field UTF-8 limit, capped at 4096 bytes. */
    maxBytes?: number;
    /** Required application redactor. Return undefined to omit a field. */
    redact: (field: InspectionContentField, value: unknown) => unknown;
}
export interface CapturedInspectionValue { text: string; truncated: boolean }
export type InspectionContent = Partial<Record<InspectionContentField, CapturedInspectionValue>>;
const fields: InspectionContentField[] = ['requestHeaders', 'requestBody', 'responseHeaders', 'responseBody', 'prompt', 'output', 'parsedOutput', 'preview'];

function bounded(text: string, max: number): CapturedInspectionValue {
    // Decode only complete code points so the byte cap also holds for Unicode.
    let result = '', bytes = 0;
    for (const character of text) {
        const size = Buffer.byteLength(character);
        if (bytes + size > max) break;
        bytes += size; result += character;
    }
    return { text: result, truncated: result !== text };
}
function cleanText(value: unknown): string | undefined {
    if (value === undefined || (typeof value === 'object' && value !== null &&
        !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) return undefined;
    let safe = value;
    if (typeof safe === 'string') {
        try { safe = JSON.parse(safe); } catch { /* Plain text/HTML. */ }
    }
    const redacted = redactValue(safe);
    const text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
    // URLs can contain credentials in paths, queries and callback tokens. Omit all.
    return text?.replace(/https?:\/\/[^\s<>"']+/gi, '[URL omitted]')
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, '[Credential omitted]');
}
function safeHeaders(value: unknown): Record<string, string> {
    const allowed = new Set(['accept', 'content-type', 'content-length', 'cache-control', 'retry-after']);
    const clean: Record<string, string> = {};
    if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
        if (allowed.has(key.toLowerCase()) && typeof entry === 'string') clean[key.toLowerCase()] = entry;
    }
    return clean;
}
/** Capture is opt-in and fails closed, including redactor/serialization errors. */
export function captureInspection(policy: InspectionCapturePolicy | undefined, field: InspectionContentField, value: unknown): InspectionContent {
    try {
        if (!policy?.fields.includes(field) || typeof policy.redact !== 'function') return {};
        const max = policy.maxBytes ?? 4096;
        if (!Number.isSafeInteger(max) || max < 1) return {};
        const input = field.endsWith('Headers') ? safeHeaders(value) : structuredClone(value);
        const text = cleanText(policy.redact(field, input));
        return text === undefined ? {} : { [field]: bounded(text, Math.min(max, 4096)) };
    } catch { return {}; }
}
/** Revalidate untrusted transport data; never retain extra fields or unbounded text. */
export function sanitizeInspectionContent(value: any, kind: string): InspectionContent | undefined {
    const allowed = kind === 'http' ? fields.slice(0, 4) : kind === 'ai' ? fields.slice(4, 7) : kind === 'notification' ? ['preview'] : [];
    const result: InspectionContent = {};
    for (const field of allowed as InspectionContentField[]) {
        const entry = value?.[field];
        if (!entry || typeof entry.text !== 'string' || typeof entry.truncated !== 'boolean') continue;
        let decoded: unknown = entry.text;
        if (field.endsWith('Headers')) {
            try { decoded = safeHeaders(JSON.parse(entry.text)); } catch { continue; }
        }
        const text = cleanText(decoded);
        if (text === undefined) continue;
        const safe = bounded(text, 4096);
        result[field] = { text: safe.text, truncated: safe.truncated || entry.truncated };
    }
    return Object.keys(result).length ? result : undefined;
}
