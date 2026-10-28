import {Step} from 'rivulet';

/**
 * Convenience helper to create a modern Step instance for exploratory testing.
 */
export function step<TInput = any, TOutput = any, TName extends string = string>(
    name: TName,
    action?: (param: TInput) => Promise<TOutput> | TOutput
): Step<TInput, TOutput, TName> {
    return Step.create(name, action as any);
}
