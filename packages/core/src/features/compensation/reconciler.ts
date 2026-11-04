import { Status } from '../../shared';
import { defaultCompensationManager } from './manager';
import { CompensationDeadLetterQueue } from './types';
import { defaultStorageManager, getCheckpoint } from '../storage';
import { getCompensationHandler } from './registry';
import { UnresolvableCompensationException } from '../executer/exceptions';

export interface ReconcilerOptions {
    staleThresholdMs?: number;
    action?: 'compensate' | 'fail' | 'inspect';
    namespace?: string;
    flowLookup?: (workflowId?: string, type?: string) => any;
    deadLetterQueue?: CompensationDeadLetterQueue;
    mode?: 'strict' | 'best-effort';
    stacks?: any[];
}

export interface ReconcileReport {
    inspected: number;
    reconciled: string[];
    failed: Array<{ stackId: string; error: any }>;
    staleStacks: Array<{
        stackId: string;
        workflowId?: string;
        staleForMs: number;
        status: string;
    }>;
}

export async function reconcileAbandonedStacks(
    options: ReconcilerOptions = {}
): Promise<ReconcileReport> {
    const staleThresholdMs = options.staleThresholdMs ?? 10 * 60 * 1000;
    const action = options.action ?? 'compensate';
    const mode = options.mode ?? 'best-effort';
    const now = Date.now();

    const candidateStacks: any[] = options.stacks || defaultStorageManager.getAllStacks();

    const staleStacks: ReconcileReport['staleStacks'] = [];
    const reconciled: string[] = [];
    const failed: Array<{ stackId: string; error: any }> = [];

    for (const stack of candidateStacks) {
        if (!stack || !stack.stackId) continue;
        if (options.namespace && stack.namespace !== options.namespace) continue;

        const isRunning = stack.status === Status.RUNNING || !stack.status;
        const stackTime = stack.timestamp || stack.updatedAt || 0;
        const staleForMs = now - stackTime;

        if (isRunning && staleForMs >= staleThresholdMs) {
            staleStacks.push({
                stackId: stack.stackId,
                workflowId: stack.workflowId,
                staleForMs,
                status: stack.status || Status.RUNNING
            });

            if (action === 'inspect') {
                continue;
            }

            try {
                if (action === 'fail') {
                    if (defaultStorageManager.getStack(stack.stackId)) {
                        defaultStorageManager.checkpoint(stack.stackId, { status: Status.FAILED });
                    }
                    reconciled.push(stack.stackId);
                } else if (action === 'compensate') {
                    const flow = options.flowLookup?.(stack.workflowId, stack.type);
                    if (flow && typeof flow.compensate === 'function') {
                        await flow.compensate(stack.stackId, {
                            mode,
                            deadLetterQueue: options.deadLetterQueue
                        });
                    } else {
                        // Direct compensation via checkpoint hydration
                        const existing = defaultCompensationManager.getCompensations(stack.stackId);
                        if (!existing || existing.length === 0) {
                            const cp = await getCheckpoint(stack.stackId);
                            const serializedCompensations = cp?.metadata?.compensations;
                            if (Array.isArray(serializedCompensations) && serializedCompensations.length > 0) {
                                for (const record of serializedCompensations) {
                                    let handler = record.handler;
                                    if (!handler && record.handlerName) {
                                        handler = getCompensationHandler(record.handlerName);
                                    }
                                    if (!handler) {
                                        throw new UnresolvableCompensationException(
                                            record.stepName,
                                            record.handlerName,
                                            { stackId: stack.stackId }
                                        );
                                    }
                                    defaultCompensationManager.registerCompensation(stack.stackId, {
                                        stepId: record.stepId,
                                        stepName: record.stepName,
                                        output: record.output,
                                        input: record.input,
                                        handler,
                                        handlerName: record.handlerName,
                                        payload: record.payload,
                                        options: record.options,
                                        status: record.status,
                                        completedAt: record.completedAt
                                    });
                                }
                            }
                        }

                        await defaultCompensationManager.runCompensations(
                            stack.stackId,
                            new Error(`Abandoned workflow stack exceeded stale threshold of ${staleThresholdMs}ms`),
                            {
                                mode,
                                deadLetterQueue: options.deadLetterQueue
                            }
                        );
                    }
                    if (defaultStorageManager.getStack(stack.stackId)) {
                        defaultStorageManager.checkpoint(stack.stackId, { status: Status.FAILED });
                    }
                    reconciled.push(stack.stackId);
                }
            } catch (err: any) {
                failed.push({ stackId: stack.stackId, error: err });
            }
        }
    }

    return {
        inspected: candidateStacks.length,
        staleStacks,
        reconciled,
        failed
    };
}
