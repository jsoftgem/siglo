import React from 'react';
import type { GraphNode, WorkflowGraph } from '@siglo/ide-protocol';
import { Layers, Clock, Shield, GitBranch, FileCode } from 'lucide-react';

function Property({ label, value, fallback = 'Not configured' }: { label: string; value?: string; fallback?: string }) {
    return (
        <div className="py-2.5 first:pt-0 last:pb-0">
            <dt className="text-[11px] text-[#9da0a8]">{label}</dt>
            <dd className="mt-1 text-xs text-[#dfe1e5] whitespace-pre-wrap break-words [overflow-wrap:anywhere] select-text">
                {value === undefined ? fallback : value === 'true' ? 'Enabled' : value === 'false' ? 'Disabled' : value}
            </dd>
        </div>
    );
}

export function WorkflowInspector({
    workflow,
    onSelectNode,
    onOpenRelatedFile,
}: {
    workflow: WorkflowGraph;
    onSelectNode: (node: GraphNode) => void;
    onOpenRelatedFile?: (uri: string) => void;
}): React.ReactElement {
    const properties = workflow.properties || {};
    const relatedFiles = Array.from(
        workflow.nodes
            .reduce((map, node) => {
                if (node.sourceUri && node.sourceUri !== workflow.uri && !map.has(node.sourceUri)) {
                    const label =
                        node.properties?.importedFrom?.replace(/:\d+$/, '') ||
                        node.sourceUri.split('/').pop() ||
                        node.sourceUri;
                    map.set(node.sourceUri, label);
                }
                return map;
            }, new Map<string, string>())
            .entries(),
    );
    const networkLabels: Record<string, string> = {
        enabled: 'Network policy',
        defaultPolicy: 'Default policy',
        allowedHosts: 'Allowed hosts',
        allowLocalhost: 'Allow localhost',
        allowUnixSockets: 'Allowed Unix sockets',
        source: 'Policy expression',
    };
    const network = Object.entries(properties).filter(([key]) => key.startsWith('network.'));
    return (
        <aside className="w-full sm:w-80 max-w-none sm:max-w-[45vw] min-w-0 sm:min-w-[240px] max-h-[45%] sm:max-h-none shrink-0 border-l border-[#393b40] bg-[#25262a] flex flex-col h-full text-xs overflow-y-auto">
            <header className="p-4 border-b border-[#393b40]">
                <div className="flex items-center gap-2 text-[#9da0a8] mb-2">
                    <Layers className="w-4 h-4" />
                    <span>Workflow properties</span>
                </div>
                <h2 className="font-semibold text-sm text-[#dfe1e5] break-words [overflow-wrap:anywhere]">
                    {workflow.name}
                </h2>
                <p className="mt-2 text-[11px] text-[#9da0a8]">
                    {workflow.nodes.length} graph nodes · {workflow.edges.length} connections
                </p>
            </header>
            <div className="p-4 space-y-5">
                <section>
                    <p className="text-[11px] text-[#9da0a8] mb-3">
                        Declared flow settings. Execution options can change effective values.
                    </p>
                    <h3 className="flex items-center gap-1.5 font-semibold text-[#bcbec4] mb-3">
                        <Clock className="w-3.5 h-3.5 text-sky-400" />
                        Execution defaults
                    </h3>
                    <dl className="rounded-lg border border-[#393b40] bg-[#1e1f22] p-3 divide-y divide-[#393b40]">
                        <Property
                            label="Workflow deadline"
                            value={
                                properties.timeoutMs === undefined
                                    ? undefined
                                    : /^\d+(\.\d+)?$/.test(properties.timeoutMs)
                                      ? `${properties.timeoutMs} ms`
                                      : properties.timeoutMs
                            }
                        />
                        <Property label="Schema version" value={properties.workflowVersion} fallback="Not declared" />
                        <Property label="Monitor" value={properties.monitor} />
                    </dl>
                </section>
                <section>
                    <h3 className="flex items-center gap-1.5 font-semibold text-[#bcbec4] mb-3">
                        <Shield className="w-3.5 h-3.5 text-emerald-400" />
                        Network perimeter
                    </h3>
                    {network.length ? (
                        <dl className="rounded-lg border border-[#393b40] bg-[#1e1f22] p-3 divide-y divide-[#393b40]">
                            {network.map(([key, value]) => (
                                <Property key={key} label={networkLabels[key.slice(8)] || key.slice(8)} value={value} />
                            ))}
                        </dl>
                    ) : (
                        <p className="text-[11px] text-[#9da0a8]">No flow policy configured.</p>
                    )}
                </section>
                {relatedFiles.length > 0 && onOpenRelatedFile && (
                    <section>
                        <h3 className="flex items-center gap-1.5 font-semibold text-[#bcbec4] mb-3">
                            <FileCode className="w-3.5 h-3.5 text-amber-400" />
                            Related files
                        </h3>
                        <div className="space-y-1">
                            {relatedFiles.map(([uri, label]) => (
                                <button
                                    key={uri}
                                    onClick={() => onOpenRelatedFile(uri)}
                                    className="block w-full text-left truncate rounded px-2 py-2 text-sky-400 hover:bg-[#393b40] focus-visible:outline focus-visible:outline-sky-400"
                                    title={uri}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </section>
                )}
                <section>
                    <h3 className="flex items-center gap-1.5 font-semibold text-[#bcbec4] mb-3">
                        <GitBranch className="w-3.5 h-3.5 text-purple-400" />
                        Graph nodes
                    </h3>
                    <div className="space-y-1">
                        {workflow.nodes.map(node => (
                            <button
                                key={node.id}
                                onClick={() => onSelectNode(node)}
                                className="block w-full text-left truncate rounded px-2 py-2 text-[#dfe1e5] hover:bg-[#393b40] focus-visible:outline focus-visible:outline-sky-400"
                                title={node.name}
                            >
                                {node.name}
                            </button>
                        ))}
                    </div>
                </section>
            </div>
        </aside>
    );
}
