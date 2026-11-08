import { isObject } from '../../shared';
import { WorkflowNode, GraphInspectionResult, GraphInspectionEdge } from './types';
import { toGraph } from './toGraph';

export function inspectGraph(workflowOrNode: any): GraphInspectionResult {
    const root = toGraph(workflowOrNode);
    const nodesMap = new Map<string, { id: string; name: string; type: any; metadata?: any }>();
    const edges: GraphInspectionEdge[] = [];
    const visited = new Set<string>();

    function getExitNodeIds(node: WorkflowNode): string[] {
        switch (node.type) {
            case 'step':
            case 'wait':
                return [node.id];
            case 'sequence': {
                if (!node.children || node.children.length === 0) return [node.id];
                const lastChild = node.children[node.children.length - 1];
                return getExitNodeIds(lastChild);
            }
            case 'parallel': {
                if (!node.branches || node.branches.length === 0) return [node.id];
                const exits: string[] = [];
                for (const b of node.branches) {
                    exits.push(...getExitNodeIds(b));
                }
                return exits;
            }
            case 'branch': {
                const exits: string[] = [];
                if (node.branches) {
                    for (const k of Object.keys(node.branches)) {
                        exits.push(...getExitNodeIds(node.branches[k]));
                    }
                }
                if (isObject(node.defaultBranch)) {
                    exits.push(...getExitNodeIds(node.defaultBranch));
                }
                return exits.length > 0 ? exits : [node.id];
            }
            case 'map':
                return node.itemNode ? getExitNodeIds(node.itemNode) : [node.id];
        }
    }

    function traverse(node: WorkflowNode): void {
        if (!node || visited.has(node.id)) return;
        visited.add(node.id);

        nodesMap.set(node.id, {
            id: node.id,
            name: node.name,
            type: node.type,
            metadata: node.metadata,
        });

        switch (node.type) {
            case 'sequence':
                if (node.children) {
                    for (let i = 0; i < node.children.length; i++) {
                        const child = node.children[i];
                        traverse(child);
                        if (i === 0) {
                            edges.push({ from: node.id, to: child.id, label: 'first-step' });
                        }
                        if (i > 0) {
                            const prevExits = getExitNodeIds(node.children[i - 1]);
                            for (const exitId of prevExits) {
                                edges.push({ from: exitId, to: child.id, label: 'next' });
                            }
                        }
                    }
                }
                break;

            case 'parallel':
                if (node.branches) {
                    for (let i = 0; i < node.branches.length; i++) {
                        const branch = node.branches[i];
                        traverse(branch);
                        edges.push({ from: node.id, to: branch.id, label: `branch-${i}` });
                    }
                }
                break;

            case 'branch':
                if (node.branches) {
                    for (const key of Object.keys(node.branches)) {
                        const target = node.branches[key];
                        traverse(target);
                        edges.push({ from: node.id, to: target.id, label: `when:${key}` });
                    }
                }
                if (isObject(node.defaultBranch)) {
                    traverse(node.defaultBranch);
                    edges.push({ from: node.id, to: node.defaultBranch.id, label: 'default' });
                }
                break;

            case 'map':
                if (node.itemNode) {
                    traverse(node.itemNode);
                    edges.push({ from: node.id, to: node.itemNode.id, label: 'item-process' });
                }
                break;

            case 'step':
            case 'wait':
                break;
        }
    }

    traverse(root);

    return {
        nodes: Array.from(nodesMap.values()),
        edges,
        entryNodeId: root.id,
        exitNodeIds: getExitNodeIds(root),
        totalNodes: nodesMap.size,
    };
}
