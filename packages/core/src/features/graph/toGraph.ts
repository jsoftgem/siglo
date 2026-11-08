import { WorkflowNode, StepNode } from './types';
import { generateUUID, isFunction, isObject, WorkflowNodeType } from '../../shared';

export function isWorkflowNode(item: any): item is WorkflowNode {
    return (
        isObject(item) &&
        typeof item.id === 'string' &&
        typeof item.type === 'string' &&
        (Object.values(WorkflowNodeType) as string[]).includes(item.type)
    );
}

export function toGraph(item: any): WorkflowNode {
    if (!item) {
        return {
            id: generateUUID(),
            name: 'empty',
            type: WorkflowNodeType.STEP,
        };
    }

    if (isWorkflowNode(item)) {
        return item;
    }

    if (item.workflowNode && isWorkflowNode(item.workflowNode)) {
        return {
            ...item.workflowNode,
            metadata: { ...item.workflowNode.metadata, runtimeStepId: item.$stepId },
        };
    }

    if (Array.isArray(item)) {
        if (item.length === 1) {
            return toGraph(item[0]);
        }
        return {
            id: generateUUID(),
            name: 'sequence',
            type: WorkflowNodeType.SEQUENCE,
            children: item.map(toGraph),
        };
    }

    if (item.isFlow || (Array.isArray(item.steps) && (item.run || item.execute || item.start))) {
        const steps = item.steps || [];
        if (steps.length === 1) {
            return toGraph(steps[0]);
        }
        const flowPolicy =
            item.networkPolicyConfig ||
            (typeof item.networkPolicy === 'function' ? item.networkPolicy() : item.networkPolicy);
        return {
            id: item.workflowId || generateUUID(),
            name: item.name || 'flow',
            type: WorkflowNodeType.SEQUENCE,
            children: steps.map(toGraph),
            metadata: flowPolicy ? { networkPolicy: flowPolicy } : undefined,
        };
    }

    // Step instance
    if (item && typeof item === 'object' && (item.action || item.func || item.$stepId)) {
        if (Array.isArray(item.sequence) && item.sequence.length > 1) {
            return {
                id: item.$stepId || generateUUID(),
                name: item.name || item.func || 'sequence',
                type: WorkflowNodeType.SEQUENCE,
                children: item.sequence.map(toGraph),
            };
        }
        const stepId = item.$stepId || generateUUID();
        const stepName = item.name || item.func || 'step';
        const stepPolicy =
            item.networkPolicyConfig ||
            (typeof item.networkPolicy === 'function' ? item.networkPolicy() : item.networkPolicy);
        const node: StepNode = {
            id: stepId,
            name: stepName,
            type: WorkflowNodeType.STEP,
            metadata: {
                reducer: item.reducer,
                isStrict: item.isStrict,
                cachedLast: item.cachedLast,
                timeoutMs: item.timeoutMs,
                cacheOptions: item.cacheOptions,
                hasCompensation: Boolean(item.compensationHandler),
                retryConfig: item.onfail && typeof item.onfail === 'object' ? item.onfail : undefined,
                networkPolicy: stepPolicy,
            },
        };
        return node;
    }

    if (isFunction(item)) {
        return {
            id: generateUUID(),
            name: item.name || 'anonymous_step',
            type: WorkflowNodeType.STEP,
        };
    }

    return {
        id: generateUUID(),
        name: String(item),
        type: WorkflowNodeType.STEP,
    };
}
