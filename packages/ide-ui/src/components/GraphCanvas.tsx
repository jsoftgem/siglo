import React from 'react';
import type { GraphNode, GraphEdge, UnresolvedNode } from '@siglo/ide-protocol';
import { Globe, KeyRound, Bell, Sparkles, Cog, AlertTriangle, Clock, GitFork, List } from 'lucide-react';

interface GraphCanvasProps {
    nodes: GraphNode[];
    edges: GraphEdge[];
    unresolved: UnresolvedNode[];
    workflowName?: string;
    workflowProperties?: Record<string, string>;
    onSelectWorkflow?: () => void;
    embedded?: boolean;
    selectedNodeId: string | null;
    onSelectNode: (node: GraphNode) => void;
}

export const GraphCanvas: React.FC<GraphCanvasProps> = ({
    nodes,
    edges,
    unresolved,
    selectedNodeId,
    onSelectNode,
    workflowName,
    workflowProperties,
    onSelectWorkflow,
    embedded = false,
}) => {
    const markerId = `graph-arrow-${React.useId().replace(/:/g, '')}`;
    const headerSpace = workflowName
        ? workflowProperties?.timeoutMs !== undefined || workflowProperties?.workflowVersion !== undefined
            ? 72
            : 44
        : 0;
    const W = 220,
        H = 72,
        GX = 76,
        GY = 52,
        PAD = 40;
    const ids = new Set([...nodes.map(n => n.id), ...unresolved.map(n => n.id)]);
    const incoming = new Map<string, GraphEdge[]>(),
        outgoing = new Map<string, GraphEdge[]>();
    edges
        .filter(e => ids.has(e.from) && ids.has(e.to))
        .forEach(e => {
            incoming.set(e.to, [...(incoming.get(e.to) || []), e]);
            outgoing.set(e.from, [...(outgoing.get(e.from) || []), e]);
        });
    // Longest-path layers keep forks side-by-side and rejoin nodes below their inputs.
    const layer = new Map<string, number>();
    const visit = (id: string, path: Set<string>): number => {
        if (layer.has(id)) return layer.get(id)!;
        if (path.has(id)) return 0;
        const next = new Set(path);
        next.add(id);
        const value = Math.max(0, ...(incoming.get(id) || []).map(e => visit(e.from, next) + 1));
        layer.set(id, value);
        return value;
    };
    ids.forEach(id => visit(id, new Set()));
    const byLayer = new Map<number, string[]>();
    ids.forEach(id => byLayer.set(layer.get(id) || 0, [...(byLayer.get(layer.get(id) || 0) || []), id]));
    const order = new Map<string, number>();
    [...byLayer.entries()]
        .sort((a, b) => a[0] - b[0])
        .forEach(([depth, group]) => {
            group.sort((a, b) => {
                const parent = (id: string) =>
                    (incoming.get(id) || []).reduce((s, e) => s + (order.get(e.from) ?? 0), 0) /
                    Math.max(1, incoming.get(id)?.length || 0);
                return parent(a) - parent(b) || a.localeCompare(b);
            });
            group.forEach((id, i) => order.set(id, i));
            byLayer.set(depth, group);
        });
    const positions = new Map<string, { x: number; y: number }>();
    byLayer.forEach((group, depth) =>
        group.forEach((id, row) =>
            positions.set(id, { x: PAD + row * (W + GX), y: PAD + headerSpace + depth * (H + GY) }),
        ),
    );
    const width = Math.max(embedded ? 300 : 600, ...[...byLayer.values()].map(g => PAD * 2 + g.length * (W + GX) - GX));
    const height = Math.max(
        embedded ? 200 : 400,
        headerSpace + PAD * 2 + Math.max(0, ...[...byLayer.keys()]) * (H + GY) + H,
    );
    const icon = (kind: string) => {
        const cls = 'w-4 h-4 shrink-0';
        if (['wait', 'waitForEvent', 'Step.wait', 'Step.waitForEvent'].includes(kind))
            return <Clock className={`${cls} text-amber-400`} />;
        if (kind === 'map') return <List className={`${cls} text-sky-400`} />;
        if (['parallel', 'all', 'allSettled', 'race', 'when', 'branch'].includes(kind))
            return <GitFork className={`${cls} text-purple-400`} />;
        if (kind === 'http') return <Globe className={`${cls} text-sky-400`} />;
        if (kind === 'crypto') return <KeyRound className={`${cls} text-emerald-400`} />;
        if (kind === 'notification') return <Bell className={`${cls} text-amber-400`} />;
        if (kind === 'ai') return <Sparkles className={`${cls} text-purple-400`} />;
        return <Cog className={`${cls} text-blue-400`} />;
    };
    return (
        <div
            className={
                embedded
                    ? 'relative shrink-0 rounded-xl border border-[#393b40] bg-[#1e1f22]'
                    : 'relative w-full h-full overflow-auto bg-[#1e1f22]'
            }
            style={embedded ? { width, height } : undefined}
            data-workflow={workflowName}
        >
            <div className="relative" style={{ width, height }}>
                {workflowName && (
                    <header
                        className="absolute border-b border-[#393b40] pb-3"
                        style={{ left: PAD, top: 20, width: width - PAD * 2 }}
                    >
                        <div className="flex items-center gap-3">
                            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-[#dfe1e5]">
                                <button
                                    onClick={onSelectWorkflow}
                                    title={`Inspect workflow: ${workflowName}`}
                                    className="block w-full text-left truncate hover:text-sky-400 focus-visible:outline focus-visible:outline-sky-400"
                                >
                                    {workflowName}
                                </button>
                            </h2>
                            <span className="shrink-0 text-[11px] text-[#9da0a8]">{nodes.length} steps</span>
                        </div>
                        {headerSpace > 44 && (
                            <div className="mt-2 flex gap-2 text-[10px] text-[#a8adbb]">
                                {workflowProperties?.timeoutMs !== undefined && (
                                    <span
                                        title="Workflow deadline"
                                        className="truncate rounded bg-[#2b2d30] px-1.5 py-0.5"
                                    >
                                        Deadline: {workflowProperties.timeoutMs}
                                        {/^\d+(\.\d+)?$/.test(workflowProperties.timeoutMs) ? ' ms' : ''}
                                    </span>
                                )}
                                {workflowProperties?.workflowVersion !== undefined && (
                                    <span
                                        title="Workflow schema version"
                                        className="truncate rounded bg-[#2b2d30] px-1.5 py-0.5"
                                    >
                                        Version: {workflowProperties.workflowVersion}
                                    </span>
                                )}
                            </div>
                        )}
                    </header>
                )}
                <svg className="absolute inset-0 pointer-events-none" width={width} height={height}>
                    <defs>
                        <marker id={markerId} markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                            <path d="M0 0L8 3L0 6Z" fill="context-stroke" />
                        </marker>
                    </defs>
                    {edges.map(edge => {
                        const a = positions.get(edge.from),
                            b = positions.get(edge.to);
                        if (!a || !b) return null;
                        const source = outgoing.get(edge.from) || [],
                            index = source.indexOf(edge),
                            spread = (index - (source.length - 1) / 2) * 16;
                        const x1 = a.x + W / 2 + spread,
                            y1 = a.y + H,
                            x2 = b.x + W / 2,
                            y2 = b.y;
                        const active = selectedNodeId === edge.from || selectedNodeId === edge.to;
                        const color = active
                            ? '#3574f0'
                            : edge.type === 'parallel'
                              ? '#a78bfa'
                              : edge.type === 'branch'
                                ? '#38bdf8'
                                : edge.type === 'compensation'
                                  ? '#34d399'
                                  : edge.type === 'fallback'
                                    ? '#fbbf24'
                                    : '#6c707e';
                        return (
                            <g key={edge.id}>
                                <path
                                    d={`M${x1},${y1} C${x1},${y1 + GY / 2} ${x2},${y2 - GY / 2} ${x2},${y2}`}
                                    fill="none"
                                    stroke={color}
                                    strokeWidth={active ? 2 : 1.5}
                                    strokeDasharray={
                                        edge.type === 'fallback'
                                            ? '4 4'
                                            : edge.type === 'compensation'
                                              ? '6 3'
                                              : undefined
                                    }
                                    markerEnd={`url(#${markerId})`}
                                />
                                {edge.label && (
                                    <text x={(x1 + x2) / 2 + 8} y={(y1 + y2) / 2} fill={color} fontSize="11">
                                        {edge.label}
                                    </text>
                                )}
                            </g>
                        );
                    })}
                </svg>
                {nodes.map(node => {
                    const p = positions.get(node.id)!;
                    const selected = selectedNodeId === node.id;
                    return (
                        <button
                            key={node.id}
                            onClick={() => onSelectNode(node)}
                            title={node.name}
                            style={{ left: p.x, top: p.y, width: W, height: H }}
                            className={`absolute text-left rounded-lg border p-3 shadow-md transition-colors ${selected ? 'border-[#3574f0] bg-[#2e3748] ring-2 ring-[#3574f0]/40' : 'border-[#393b40] bg-[#2b2d30] hover:border-[#6c707e]'}`}
                        >
                            <span className="flex items-center gap-2 min-w-0">
                                <span>
                                    {icon(
                                        node.stepKind === 'custom'
                                            ? node.properties?.operation || node.stepKind
                                            : node.stepKind,
                                    )}
                                </span>
                                <span className="font-medium text-xs text-[#dfe1e5] truncate flex-1">{node.name}</span>
                                <span className="max-w-24 truncate shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[#393b40] text-[#9da0a8]">
                                    {node.stepKind === 'custom'
                                        ? node.properties?.operation || node.stepKind
                                        : node.stepKind}
                                </span>
                            </span>
                            <span className="mt-2 flex justify-between gap-2 text-[10px] text-[#9da0a8]">
                                <span>
                                    L{node.location.start.line + 1}:C{node.location.start.character + 1}
                                </span>
                                <span>
                                    {node.executionConfig?.retries !== undefined
                                        ? `${node.executionConfig.retries} retries`
                                        : node.executionConfig?.timeoutMs
                                          ? `${node.executionConfig.timeoutMs}ms`
                                          : ''}
                                </span>
                            </span>
                        </button>
                    );
                })}
                {unresolved.map(un => {
                    const p = positions.get(un.id)!;
                    return (
                        <div
                            key={un.id}
                            style={{ left: p.x, top: p.y, width: W, height: H }}
                            className="absolute rounded-lg border border-dashed border-amber-600/60 bg-[#2b2d30] p-3 flex flex-col justify-between overflow-hidden"
                        >
                            <div className="flex gap-2 items-center">
                                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                                <span className="text-xs text-amber-300">Unresolved expression</span>
                            </div>
                            <div title={un.expressionSnippet} className="text-[10px] text-[#9da0a8] truncate">
                                {un.expressionSnippet}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
