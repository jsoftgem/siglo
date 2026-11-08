import { sanitizeInspection, stepInspectionStorage, hasEcosystemContent } from './inspection';
import { WorkflowExecutionEvent } from './types';

export interface RedactionOptions {
    redactKeys?: string[];
    redactHook?: (key: string, value: any) => any;
}

const DEFAULT_REDACT_KEYS = [
    'rawBody',
    'rawPayload',
    'signature',
    'signatureHeader',
    'headers',
    'cUrl',
    'callbackBaseUrl',
    'password',
    'token',
    'secret',
    'apikey',
    'authorization',
    'cookie',
    'creditcard',
    'ssn',
    'privkey',
    'privatekey',
    'recipient',
    'email',
    'phone',
    'slackUserId',
    'slackChannelId',
    'discordWebhookUrl',
    'approvalTokens',
    'approveUrl',
    'rejectUrl',
    'signingSecret',
];

export function redactValue(val: any, options: RedactionOptions = {}, visited = new WeakSet<object>()): any {
    if (val === null || val === undefined || typeof val !== 'object') {
        return val;
    }
    if (visited.has(val)) return '[Circular]';
    visited.add(val);
    const redactKeys = [...DEFAULT_REDACT_KEYS, ...(options.redactKeys || [])].map(k => k.toLowerCase());
    if (Array.isArray(val)) {
        const clean = val.map(item => redactValue(item, options, visited));
        visited.delete(val);
        return clean;
    }
    const clean: Record<string, any> = {};
    for (const key of Object.keys(val)) {
        if (options.redactHook) {
            const hooked = options.redactHook(key, val[key]);
            if (hooked !== undefined) {
                clean[key] = hooked;
                continue;
            }
        }
        if (redactKeys.includes(key.toLowerCase())) {
            clean[key] = '[REDACTED]';
        } else if (typeof val[key] === 'object' && val[key] !== null) {
            clean[key] = redactValue(val[key], options, visited);
        } else {
            clean[key] = val[key];
        }
    }
    visited.delete(val);
    return clean;
}

export function redactEvent(event: WorkflowExecutionEvent, options: RedactionOptions = {}): WorkflowExecutionEvent {
    if (!event) return event;
    const copy: any = { ...event };
    const scope = stepInspectionStorage.getStore();
    if (
        (scope?.ecosystemKind && copy.stackId === scope.stackId && copy.stepId === scope.stepId) ||
        hasEcosystemContent(copy.stackId)
    ) {
        if (copy.type === 'step:complete') copy.outputSummary = '[Content not captured]';
        if (copy.type === 'context:change') copy.value = '[Content not captured]';
        if (copy.error) copy.error = { message: 'Ecosystem step failed; see safe diagnostics' };
    }

    if ('inspection' in copy) copy.inspection = sanitizeInspection(copy.inspection);
    if (copy.type === 'step:inspection') {
        const allowed = new Set([
            'type',
            'stackId',
            'stepId',
            'stepName',
            'attempt',
            'timestamp',
            'namespace',
            'inspection',
        ]);
        for (const key of Object.keys(copy)) if (!allowed.has(key)) delete copy[key];
    }

    if (copy.type === 'context:change') {
        const redactKeys = [...DEFAULT_REDACT_KEYS, ...(options.redactKeys || [])].map(k => k.toLowerCase());
        if (options.redactHook) {
            const hooked = options.redactHook(copy.field, copy.value);
            if (hooked !== undefined) {
                copy.value = hooked;
            } else if (redactKeys.includes(copy.field.toLowerCase())) {
                copy.value = '[REDACTED]';
            } else {
                copy.value = redactValue(copy.value, options);
            }
        } else if (redactKeys.includes(copy.field.toLowerCase())) {
            copy.value = '[REDACTED]';
        } else {
            copy.value = redactValue(copy.value, options);
        }
    } else if (copy.type === 'step:complete' && copy.outputSummary !== undefined) {
        copy.outputSummary = redactValue(copy.outputSummary, options);
    }
    const { value, outputSummary, ...rest } = copy;
    const sanitized = redactValue(rest, options);
    if ('value' in copy) sanitized.value = copy.type === 'context:change' ? value : redactValue(value, options);
    if ('outputSummary' in copy) sanitized.outputSummary = outputSummary;
    return sanitized;
}
