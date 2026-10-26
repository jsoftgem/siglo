import { isObject } from '../../shared';
import { WorkflowNode, GraphValidationResult } from './types';
import { GraphValidationException } from '../executer/exceptions';

export function validateGraph(node: WorkflowNode): GraphValidationResult {
    const errors: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    function traverse(curr: WorkflowNode | undefined): void {
        if (!curr || typeof curr !== 'object') {
            errors.push('Node is undefined or not an object');
            return;
        }

        if (!curr.id || typeof curr.id !== 'string') {
            errors.push(`Node of type '${(curr as any).type}' has missing or non-string id`);
        }

        if (!curr.type || !['step', 'sequence', 'parallel', 'branch', 'wait', 'map'].includes(curr.type)) {
            errors.push(`Node '${curr.id || 'unknown'}' has invalid type '${(curr as any).type}'`);
            return;
        }

        if (visiting.has(curr.id)) {
            errors.push(`Cycle detected involving node '${curr.id}' ('${curr.name}')`);
            return;
        }

        if (visited.has(curr.id)) {
            return;
        }

        visiting.add(curr.id);

        switch (curr.type) {
            case 'step':
                break;

            case 'sequence':
                if (!Array.isArray(curr.children) || curr.children.length === 0) {
                    errors.push(`Sequence node '${curr.id}' must have at least one child node`);
                } else {
                    for (const child of curr.children) {
                        traverse(child);
                    }
                }
                break;

            case 'parallel':
                if (!Array.isArray(curr.branches) || curr.branches.length === 0) {
                    errors.push(`Parallel node '${curr.id}' must have at least one branch`);
                } else {
                    for (const branch of curr.branches) {
                        traverse(branch);
                    }
                }
                break;

            case 'branch':
                if (!curr.branches || typeof curr.branches !== 'object' || Object.keys(curr.branches).length === 0) {
                    errors.push(`Branch node '${curr.id}' must have at least one branch target`);
                } else {
                    for (const key of Object.keys(curr.branches)) {
                        traverse(curr.branches[key]);
                    }
                }
                if (isObject(curr.defaultBranch)) {
                    traverse(curr.defaultBranch);
                }
                break;

            case 'wait':
                if (!curr.durationMs && !curr.timeoutMs && (!curr.eventName || !curr.correlationKey)) {
                    errors.push(`Wait node '${curr.id}' must specify either durationMs/timeoutMs or eventName and correlationKey`);
                }
                break;

            case 'map':
                if (!curr.itemNode) {
                    errors.push(`Map node '${curr.id}' must specify itemNode`);
                } else {
                    traverse(curr.itemNode);
                }
                if (curr.concurrency !== undefined && curr.concurrency <= 0) {
                    errors.push(`Map node '${curr.id}' concurrency must be greater than 0, got ${curr.concurrency}`);
                }
                break;
        }

        visiting.delete(curr.id);
        visited.add(curr.id);
    }

    traverse(node);

    return {
        valid: errors.length === 0,
        errors
    };
}

export function assertValidGraph(node: WorkflowNode): void {
    const result = validateGraph(node);
    if (!result.valid) {
        throw new GraphValidationException(result.errors);
    }
}
