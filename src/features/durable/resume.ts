import { defaultDurableManager } from './manager';
import { defaultStorageManager } from '../storage';
import { validateWorkflowVersion } from './versioning';
import { flow, Flow } from '../step';
import { toPOJO } from '../context';
import { ExecutionOptions } from '../step';

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
    const isByStack = defaultDurableManager.getWaitingByStack(correlationKeyOrStackId);
    const correlationKey = isByStack ? isByStack.correlationKey : correlationKeyOrStackId;

    const waitRecord = defaultDurableManager.resumeWait(correlationKey);
    const cp = await defaultStorageManager.getCheckpoint(waitRecord.stackId);

    const targetVersion = options?.targetVersion ?? (flowInstance as any)?.workflowVersion ?? waitRecord.version;
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
        return cleanInput;
    }

    const resumedFlow = flow(...remainingSteps);
    return resumedFlow.execute(cleanInput, options);
}
