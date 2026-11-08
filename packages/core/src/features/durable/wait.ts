import { Step } from '../step';
import { generateUUID, isFunction, WorkflowNodeType } from '../../shared';
import { WaitNode } from '../graph';
import { WaitForEventOptions } from './types';
import { WorkflowSuspendedException } from '../executer';

export function parseDuration(duration: number | string | undefined): number | undefined {
    if (duration === undefined) return undefined;
    if (typeof duration === 'number') return duration;
    const str = String(duration).trim().toLowerCase();
    const match = str.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
    if (!match) return Number(str) || 0;
    const val = parseFloat(match[1]);
    const unit = match[2] || 'ms';
    switch (unit) {
        case 'd':
            return val * 24 * 60 * 60 * 1000;
        case 'h':
            return val * 60 * 60 * 1000;
        case 'm':
            return val * 60 * 1000;
        case 's':
            return val * 1000;
        case 'ms':
        default:
            return val;
    }
}

export function waitForEvent(eventName: string, options: WaitForEventOptions): Step<any, any> {
    const timeoutMs = options.timeoutMs ?? parseDuration(options.timeout);
    const stepName = `waitForEvent:${eventName}`;

    const waitNode: WaitNode = {
        id: generateUUID(),
        name: stepName,
        type: WorkflowNodeType.WAIT,
        eventName,
        correlationKey: options.correlationKey,
        timeoutMs,
    };

    const step = Step.create(stepName, async (param: any) => {
        const correlationKey = isFunction(options.correlationKey)
            ? options.correlationKey(param)
            : options.correlationKey;

        const isDurable = param?.$isDurable === true;

        if (isDurable) {
            const expiresAt = timeoutMs ? Date.now() + timeoutMs : undefined;
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

    (step as any).workflowNode = waitNode;
    (step as any).waitConfig = {
        eventName,
        correlationKey: options.correlationKey,
        timeoutMs,
    };
    return step;
}

export function wait(durationOrMs: number | string): Step<any, any> {
    const durationMs = parseDuration(durationOrMs) || 0;
    const stepName = `wait:${durationMs}ms`;

    const waitNode: WaitNode = {
        id: generateUUID(),
        name: stepName,
        type: 'wait',
        durationMs,
    };

    const step = Step.create(stepName, async (param: any) => {
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

    (step as any).workflowNode = waitNode;
    return step;
}
