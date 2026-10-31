import { WorkflowExecutionEvent } from './types';

export interface RedactionOptions {
    redactKeys?: string[];
    redactHook?: (key: string, value: any) => any;
}

const DEFAULT_REDACT_KEYS = [
    'password',
    'token',
    'secret',
    'apikey',
    'authorization',
    'cookie',
    'creditcard',
    'ssn',
    'privkey',
    'privatekey'
];

export function redactValue(val: any, options: RedactionOptions = {}): any {
    if (val === null || val === undefined || typeof val !== 'object') {
        return val;
    }
    const redactKeys = (options.redactKeys || DEFAULT_REDACT_KEYS).map(k => k.toLowerCase());
    if (Array.isArray(val)) {
        return val.map(item => redactValue(item, options));
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
            clean[key] = redactValue(val[key], options);
        } else {
            clean[key] = val[key];
        }
    }
    return clean;
}

export function redactEvent(event: WorkflowExecutionEvent, options: RedactionOptions = {}): WorkflowExecutionEvent {
    if (!event) return event;
    const copy: any = { ...event };
    if (copy.type === 'context:change') {
        const redactKeys = (options.redactKeys || DEFAULT_REDACT_KEYS).map(k => k.toLowerCase());
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
    return copy;
}
