import { defaultDurableManager } from './manager';
import { defaultStorageManager } from '../storage';
import { validateWorkflowVersion } from './versioning';
import { flow, Flow } from '../step';
import { toPOJO } from '../context';
import { ExecutionOptions } from '../step';
import { emitMonitoringEvent } from '../events';

export interface ResumeOptions extends ExecutionOptions {
    migrations?: any;
    targetVersion?: string | number;
}

export async function resumeWorkflow(
    flowInstance: Flow<any, any>,
    correlationKeyOrStackId: string,
    eventPayload: any = {},
    options?: ResumeOptions
): Promise<any> {
    let isByStack = defaultDurableManager.getWaitingByStack(correlationKeyOrStackId);
    let correlationKey = isByStack ? isByStack.correlationKey : correlationKeyOrStackId;

    if (!isByStack && !defaultDurableManager.getWaiting(correlationKey)) {
        // Fallback: check storage adapter or checkpoint
        const adapter = defaultStorageManager.getAdapter();
        let fallbackRecord: any;
        if (adapter && typeof (adapter as any).getWaitRecord === 'function') {
            try {
                fallbackRecord = await (adapter as any).getWaitRecord(correlationKeyOrStackId);
            /* c8 ignore next 3 */
            } catch {
                // ignore
            }
        }
        if (!fallbackRecord) {
            try {
                const cp = await defaultStorageManager.getCheckpoint(correlationKeyOrStackId);
                if (cp?.metadata?.waitRecord) {
                    fallbackRecord = cp.metadata.waitRecord;
                }
            /* c8 ignore next 3 */
            } catch {
                // ignore
            }
        }
        if (fallbackRecord) {
            defaultDurableManager.registerWait(fallbackRecord);
            isByStack = defaultDurableManager.getWaitingByStack(correlationKeyOrStackId);
            correlationKey = isByStack ? isByStack.correlationKey : fallbackRecord.correlationKey;
        }
    }

    const waitRecord = defaultDurableManager.resumeWait(correlationKey);
    const adapter = defaultStorageManager.getAdapter();
    if (adapter && typeof (adapter as any).saveWaitRecord === 'function') {
        try {
            const saveRes = (adapter as any).saveWaitRecord(waitRecord);
            if (saveRes && typeof saveRes.catch === 'function') {
                saveRes.catch(() => {});
            }
        /* c8 ignore next 3 */
        } catch {
            // ignore
        }
    }

    const effectiveMonitor = options?.monitor || (flowInstance as any)?.monitorEmitter || defaultStorageManager.getStack(waitRecord.stackId)?.monitor;
    const effectiveNamespace = options?.namespace || waitRecord.namespace;
    const targetVersion = options?.targetVersion ?? (flowInstance as any)?.workflowVersion ?? waitRecord.version;

    const effectiveOptions: ResumeOptions = {
        ...options,
        stackId: waitRecord.stackId,
        namespace: effectiveNamespace,
        monitor: effectiveMonitor,
        workflowVersion: targetVersion,
        isResume: true,
        durable: options?.durable ?? true
    };

    emitMonitoringEvent(effectiveOptions, {
        type: 'flow:resumed',
        stackId: waitRecord.stackId,
        stepId: waitRecord.stepId,
        correlationKey: waitRecord.correlationKey,
        eventName: waitRecord.eventName,
        timestamp: Date.now(),
        namespace: effectiveNamespace
    });

    const cp = await defaultStorageManager.getCheckpoint(waitRecord.stackId);
    const recordedVersion = waitRecord.version ?? (cp as any)?.workflowVersion;

    let restoredState: any = cp?.contexts ? Object.assign({}, ...Object.values(cp.contexts)) : {};

    if (targetVersion !== undefined && recordedVersion !== undefined && targetVersion !== recordedVersion) {
        restoredState = validateWorkflowVersion(targetVersion, recordedVersion, options?.migrations, restoredState);
    }

    const mergedInput = Object.assign({}, restoredState, eventPayload);
    const cleanInput = toPOJO(mergedInput);

    let remainingSteps: any[] = [];
    const steps = flowInstance.steps || [];

    if (waitRecord.continuationStepIndex < steps.length) {
        remainingSteps = steps.slice(waitRecord.continuationStepIndex);
    } else {
        const waitStepIdx = steps.findIndex((s: any) => {
            const node = s?.workflowNode;
            return node?.type === 'wait' || s?.name === waitRecord.stepId || s?.name === 'wait' || s?.name === 'waitForEvent';
        });
        if (waitStepIdx !== -1) {
            remainingSteps = steps.slice(waitStepIdx + 1);
        } else {
            remainingSteps = steps;
        }
    }

    if (remainingSteps.length === 0) {
        emitMonitoringEvent(effectiveOptions, {
            type: 'flow:complete',
            stackId: waitRecord.stackId,
            durationMs: Date.now() - (waitRecord.createdAt || Date.now()),
            status: 'COMPLETED',
            timestamp: Date.now(),
            namespace: effectiveNamespace
        });
        return cleanInput;
    }

    const resumedFlow = flow(...remainingSteps);
    if (effectiveMonitor) {
        resumedFlow.monitor(effectiveMonitor);
    }
    return resumedFlow.execute(cleanInput, effectiveOptions);
}
