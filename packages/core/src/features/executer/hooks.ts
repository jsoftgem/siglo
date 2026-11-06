import { AsyncLocalStorage } from 'node:async_hooks';

export interface StepExecutionContext {
    step: any;
    stepName: string;
    stepId: string;
    stackId: string;
    attempt: number;
    namespace?: string;
    param?: any;
    options?: any;
    index?: number;
}

export type StepExecutionHook = (
    context: StepExecutionContext,
    next: () => Promise<any> | any
) => Promise<any> | any;

export const stepExecutionHookStorage = new AsyncLocalStorage<StepExecutionHook>();

export function withStepExecutionHook<T>(hook: StepExecutionHook, fn: () => T): T {
    return stepExecutionHookStorage.run(hook, fn);
}

export function getStepExecutionHook(): StepExecutionHook | undefined {
    return stepExecutionHookStorage.getStore();
}
