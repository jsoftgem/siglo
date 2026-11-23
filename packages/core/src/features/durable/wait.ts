import { Step } from '../step';
import {
    DynamicDuration,
    generateUUID,
    isFunction,
    parseDuration,
    resolveDynamic,
    WorkflowNodeType,
} from '../../shared';
import { WaitNode } from '../graph';
import { WaitForEventOptions, WaitForEventResult, WaitTimerResult } from './types';
import { WorkflowSuspendedException } from '../executer';

export { parseDuration };

export function waitForEvent<TContext = any>(
    eventName: string,
    options: WaitForEventOptions<NoInfer<TContext>>,
): Step<TContext, WaitForEventResult> {
    const hasDynamicTimeout = options.timeoutMs === undefined && isFunction(options.timeout);
    const staticTimeoutMs =
        options.timeoutMs ?? (isFunction(options.timeout) ? undefined : parseDuration(options.timeout));
    const stepName = `waitForEvent:${eventName}`;

    const waitNode: WaitNode = {
        id: generateUUID(),
        name: stepName,
        type: WorkflowNodeType.WAIT,
        eventName,
        correlationKey: options.correlationKey,
        timeoutMs: staticTimeoutMs,
        ...(hasDynamicTimeout ? { timeout: options.timeout as DynamicDuration } : {}),
    };

    const step = Step.create<string, TContext, WaitForEventResult>(stepName, async (param: any) => {
        const correlationKey = resolveDynamic(options.correlationKey, param);

        const isDurable = param?.$isDurable === true;

        if (isDurable) {
            const timeoutMs =
                options.timeoutMs ??
                (options.timeout !== undefined ? parseDuration(resolveDynamic(options.timeout, param)) : undefined);
            const expiresAt = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
            throw new WorkflowSuspendedException(
                `Workflow suspended waiting for event '${eventName}' with correlationKey '${correlationKey}'.`,
                {
                    correlationKey,
                    eventName,
                    expiresAt,
                    continuationNodeId: waitNode.id,
                },
            );
        }

        // Non-durable in-memory fallback
        return {
            eventName,
            correlationKey,
            waited: true,
        };
    });

    step.workflowNode = waitNode;
    (step as any).waitConfig = {
        eventName,
        correlationKey: options.correlationKey,
        timeoutMs: staticTimeoutMs,
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    };
    return step;
}

export function wait<TContext = any>(
    durationOrMs: DynamicDuration<NoInfer<TContext>>,
): Step<TContext, WaitTimerResult> {
    const isDynamic = isFunction(durationOrMs);
    const staticDurationMs = isDynamic ? undefined : (parseDuration(durationOrMs) ?? 0);
    const stepName = isDynamic ? 'wait:dynamic' : `wait:${staticDurationMs}ms`;

    const waitNode: WaitNode = {
        id: generateUUID(),
        name: stepName,
        type: WorkflowNodeType.WAIT,
        ...(isDynamic ? { duration: durationOrMs as DynamicDuration } : { durationMs: staticDurationMs }),
    };

    const step = Step.create<string, TContext, WaitTimerResult>(stepName, async (param: any) => {
        const durationMs = (isDynamic ? parseDuration(resolveDynamic(durationOrMs, param)) : staticDurationMs) ?? 0;
        const isDurable = param?.$isDurable === true;
        if (isDurable) {
            const correlationKey = `timer:${generateUUID()}`;
            const expiresAt = Date.now() + durationMs;
            throw new WorkflowSuspendedException(`Workflow suspended waiting for timer (${durationMs}ms).`, {
                correlationKey,
                eventName: 'timer',
                expiresAt,
                continuationNodeId: waitNode.id,
            });
        }

        if (durationMs > 0) {
            await new Promise(r => setTimeout(r, durationMs));
        }
        return { waitedMs: durationMs };
    });

    step.workflowNode = waitNode;
    return step;
}
