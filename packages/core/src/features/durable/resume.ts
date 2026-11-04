import { withLocalWorkflowLock } from './lock';
import { WorkflowAlreadyResumedException, ExpiredWaitException } from '../executer/exceptions';
import { defaultDurableManager } from './manager';
import { defaultStorageManager } from '../storage';
import { validateWorkflowVersion } from './versioning';
import { flow, Flow } from '../step';
import { toPOJO } from '../context';
import { ExecutionOptions } from '../step';
import { emitMonitoringEvent } from '../events';
import { STEPS, HISTORY, safeClone } from '../../shared';

export interface ResumeOptions extends ExecutionOptions {
    migrations?: any;
    targetVersion?: string | number;
    allowExpired?: boolean;
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

    const isTimerExpired = eventPayload?.event?.type === 'timer:expired' || options?.allowExpired === true;
    const adapter = defaultStorageManager.getAdapter();
    const storedRecord = adapter?.getWaitRecord ? await adapter.getWaitRecord(correlationKey) : defaultDurableManager.getWaiting(correlationKey);
    const execute = async () => {
        let waitRecord: any;
        const claimantId = options?.stackId || `resume-${Date.now()}-${Math.random()}`;
        const checkpoint = storedRecord ? (adapter?.getCheckpoint ? await adapter.getCheckpoint(storedRecord.stackId) : await defaultStorageManager.getCheckpoint(storedRecord.stackId)) : undefined;
        if (checkpoint?.status === 'cancelled') throw new WorkflowAlreadyResumedException(correlationKey);


        if (adapter && typeof (adapter as any).claimWaitRecord === 'function') {
            waitRecord = await (adapter as any).claimWaitRecord(correlationKey, claimantId, { allowExpired: isTimerExpired, eventPayload });
            if (!waitRecord) throw new WorkflowAlreadyResumedException(correlationKey);
            // Storage owns expiry validation and claim state. Never suppress validation errors.
            if (!isTimerExpired && !waitRecord.resumePayload && waitRecord.expiresAt !== undefined && waitRecord.expiresAt <= Date.now()) {
                throw new ExpiredWaitException(correlationKey, waitRecord.expiresAt, waitRecord.eventName);
            }
        } else {
            waitRecord = defaultDurableManager.resumeWait(correlationKey, isTimerExpired);
        }
        if (!adapter?.completeWaitRecord && adapter && typeof (adapter as any).saveWaitRecord === 'function') {
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
            resumeReason: (waitRecord.resumePayload ?? eventPayload)?.event?.type === 'timer:expired' ? 'timer-expired' : 'event',
            stackId: waitRecord.stackId,
            stepId: waitRecord.stepId,
            correlationKey: waitRecord.correlationKey,
            eventName: waitRecord.eventName,
            timestamp: Date.now(),
            namespace: effectiveNamespace
        });

        const cp = checkpoint ?? await defaultStorageManager.getCheckpoint(waitRecord.stackId);
        const recordedVersion = waitRecord.version ?? (cp as any)?.workflowVersion;

        let restoredState: any = cp?.metadata?.accumulatedContext
            ? safeClone(cp.metadata.accumulatedContext)
            : (cp?.contexts ? Object.assign({}, ...Object.values(cp.contexts)) : {});

        const stepsData = cp?.metadata?.steps;
        let stepsAccessor: any;
        if (stepsData && typeof stepsData === 'object') {
            stepsAccessor = (subField?: string) => {
                if (subField !== undefined) {
                    return stepsData[subField];
                }
                return stepsData;
            };
            Object.assign(stepsAccessor, stepsData);
            restoredState[STEPS] = stepsAccessor;
            restoredState[HISTORY] = stepsAccessor;
            restoredState.$steps = stepsAccessor;
            restoredState.$history = stepsAccessor;
        }

        if (targetVersion !== undefined && recordedVersion !== undefined && targetVersion !== recordedVersion) {
            restoredState = validateWorkflowVersion(targetVersion, recordedVersion, options?.migrations, restoredState);
        }

        const mergedInput = Object.assign({}, restoredState, waitRecord.resumePayload ?? eventPayload);
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
            await adapter?.completeWaitRecord?.(correlationKey, claimantId);
            return cleanInput;
        }

        const resumedFlow = flow(...remainingSteps);
        if (effectiveMonitor) {
            resumedFlow.monitor(effectiveMonitor);
        }
        // Durable suspension is returned as a descriptor by the runner. Both completion
        // and suspension are handoffs; failures leave the accepted event recoverable.
        const result = await resumedFlow.execute(cleanInput, effectiveOptions);
        await adapter?.completeWaitRecord?.(correlationKey, claimantId);
        return result;
    };
    return adapter?.withWorkflowLock && storedRecord
        ? adapter.withWorkflowLock(storedRecord.stackId, execute)
        : storedRecord ? withLocalWorkflowLock(storedRecord.stackId, execute) : execute();
}
