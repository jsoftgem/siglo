import type { GraphNode, GraphEdge } from './types';

export interface ExecutionTarget {
    exportName: string;
    stepIndex: number;
}

export interface RunRequest {
    type: 'runSteps';
    runId: string;
    uri: string;
    documentVersion: number;
    workflowName: string;
    nodeIds: string[];
    input: unknown;
}

export interface RunEvent {
    type: 'runEvent';
    runId: string;
    status: 'started' | 'step' | 'completed' | 'failed' | 'cancelled' | 'log';
    nodeId?: string;
    output?: unknown;
    error?: string;
    log?: string;
    elapsedMs?: number;
}

/** Only sequential graph links contribute to a range; recovery edges are not mainline steps. */
export function executionRange(nodes: GraphNode[], edges: GraphEdge[], selected: string[]): GraphNode[] {
    const ids = [...new Set(selected)];
    if (!ids.length) throw new Error('Select one or more steps.');
    const picked = ids.map(id => nodes.find(n => n.id === id));
    for (const n of picked) {
        if (!n) continue;
        if (/_(fork|join)_/.test(n.id) || / (fork|join)$/.test(n.name)) {
            throw new Error('Synthetic fork/join nodes cannot run independently.');
        }
        if (['parallel', 'all', 'race', 'allSettled', 'branch', 'when', 'map', 'inline action'].includes(n.name)) {
            throw new Error('Composite boundaries cannot be crossed. Select individual steps within a branch.');
        }
    }
    if (picked.some(n => !n?.executionTarget)) {
        throw new Error('Selection is not independently executable. Export the workflow and reload.');
    }
    if (ids.length === 1) return picked as GraphNode[];
    for (const start of picked as GraphNode[]) {
        const path: GraphNode[] = [start];
        const visited = new Set([start.id]);
        while (!ids.every(id => visited.has(id))) {
            const outgoing = edges.filter(
                e => e.from === path[path.length - 1].id && !['fallback', 'compensation'].includes(e.type),
            );
            if (outgoing.length !== 1 || outgoing[0].type !== 'sequential') break;
            const next = nodes.find(n => n.id === outgoing[0].to);
            if (!next?.executionTarget || visited.has(next.id)) break;
            const incoming = edges.filter(e => e.to === next.id && !['fallback', 'compensation'].includes(e.type));
            if (incoming.length !== 1 || incoming[0].type !== 'sequential') break;
            path.push(next);
            visited.add(next.id);
        }
        if (ids.every(id => visited.has(id))) return path;
    }
    throw new Error('Select a contiguous sequential range within one branch. Composite boundaries cannot be crossed.');
}
