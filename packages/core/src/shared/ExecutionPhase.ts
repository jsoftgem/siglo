import { isObject } from './TypeGuards';

export const ExecutionPhase = {
    VALIDATION: 'validation',
    BEFORE: 'before',
    ACTION: 'action',
    AFTER: 'after',
    FAIL: 'fail',
    COMPENSATION: 'compensation',
} as const;

export type ExecutionPhase = (typeof ExecutionPhase)[keyof typeof ExecutionPhase];

export function tagErrorPhase(err: unknown, phase: ExecutionPhase | string, stepName?: string): void {
    if (isObject(err)) {
        (err as Record<string, unknown>).phase = phase;
        if (stepName !== undefined) {
            (err as Record<string, unknown>).stepName = stepName;
        }
    }
}
