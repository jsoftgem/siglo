import React from 'react';
import { StepProperties } from './StepProperties';
import type { GraphNode, Diagnostic } from '@siglo/ide-protocol';
import { ShieldAlert, Clock, RefreshCw, FileCode, CornerDownRight } from 'lucide-react';

interface InspectorPanelProps {
    selectedNode: GraphNode | null;
    diagnostics: Diagnostic[];
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({ selectedNode, diagnostics }) => {
    if (!selectedNode) {
        return (
            <div className="w-full sm:w-80 max-w-none sm:max-w-[45vw] min-w-0 sm:min-w-[240px] max-h-[45%] sm:max-h-none shrink-0 border-l border-[#393b40] bg-[#25262a] p-4 text-[#9da0a8] flex flex-col justify-center items-center text-center">
                <FileCode className="w-8 h-8 mb-2 opacity-50" />
                <p className="text-xs">
                    Click a step in the workflow graph to inspect properties and navigate to source.
                </p>
            </div>
        );
    }

    const nodeDiagnostics = diagnostics.filter(
        d =>
            d.range.start.line >= selectedNode.location.start.line &&
            d.range.end.line <= selectedNode.location.end.line,
    );

    return (
        <div className="w-full sm:w-80 max-w-none sm:max-w-[45vw] min-w-0 sm:min-w-[240px] max-h-[45%] sm:max-h-none shrink-0 border-l border-[#393b40] bg-[#25262a] flex flex-col h-full text-xs overflow-y-auto">
            <div className="p-4 border-b border-[#393b40]">
                <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-semibold text-sm text-[#dfe1e5] min-w-0 truncate">{selectedNode.name}</span>
                    <span className="shrink-0 font-mono text-[10px] uppercase px-1.5 py-0.5 rounded bg-[#393b40] text-[#a8adbb]">
                        {selectedNode.stepKind}
                    </span>
                </div>
                <p className="font-mono text-[11px] text-[#868a98] break-all">{selectedNode.id}</p>
            </div>

            <div className="p-4 space-y-4 flex-1">
                <div>
                    <h4 className="text-[11px] font-semibold uppercase text-[#6f737d] tracking-wider mb-2">
                        Source Coordinates
                    </h4>
                    <div className="bg-[#1e1f22] rounded p-2.5 space-y-1 font-mono text-[11px]">
                        <div className="flex flex-wrap gap-2 justify-between">
                            <span className="text-[#868a98]">Definition:</span>
                            <span className="text-[#dfe1e5]">
                                L{selectedNode.location.start.line + 1}:C{selectedNode.location.start.character + 1}{' '}
                                &rarr; L{selectedNode.location.end.line + 1}:C{selectedNode.location.end.character + 1}
                            </span>
                        </div>
                        <div className="flex flex-wrap gap-2 justify-between">
                            <span className="text-[#868a98]">Statement:</span>
                            <span className="text-[#dfe1e5]">
                                L{selectedNode.declarationRange.start.line + 1} &rarr; L
                                {selectedNode.declarationRange.end.line + 1}
                            </span>
                        </div>
                    </div>
                </div>

                <div>
                    <h4 className="text-[11px] font-semibold uppercase text-[#6f737d] tracking-wider mb-2">
                        Execution Configuration
                    </h4>
                    <div className="bg-[#1e1f22] rounded p-2.5 space-y-2 text-[11px]">
                        <div className="flex items-center justify-between">
                            <span className="flex items-center text-[#868a98]">
                                <RefreshCw className="w-3.5 h-3.5 mr-1.5 text-amber-400" />
                                Retries:
                            </span>
                            <span className="font-mono font-medium text-[#dfe1e5]">
                                {selectedNode.executionConfig?.retries ?? 'None'}
                            </span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="flex items-center text-[#868a98]">
                                <Clock className="w-3.5 h-3.5 mr-1.5 text-sky-400" />
                                Timeout:
                            </span>
                            <span className="font-mono font-medium text-[#dfe1e5]">
                                {selectedNode.executionConfig?.timeoutMs !== undefined
                                    ? `${selectedNode.executionConfig.timeoutMs}ms`
                                    : 'Default'}
                            </span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="flex items-center text-[#868a98]">
                                <CornerDownRight className="w-3.5 h-3.5 mr-1.5 text-emerald-400" />
                                Compensation:
                            </span>
                            <span className="font-mono font-medium text-[#dfe1e5]">
                                {selectedNode.executionConfig?.hasCompensation ? 'Attached' : 'None'}
                            </span>
                        </div>
                    </div>
                </div>

                <StepProperties key={selectedNode.id} node={selectedNode} />

                {nodeDiagnostics.length > 0 && (
                    <div>
                        <h4 className="text-[11px] font-semibold uppercase text-amber-500 tracking-wider mb-2 flex items-center">
                            <ShieldAlert className="w-3.5 h-3.5 mr-1" />
                            Diagnostics ({nodeDiagnostics.length})
                        </h4>
                        <div className="space-y-1.5">
                            {nodeDiagnostics.map((d, i) => (
                                <div
                                    key={i}
                                    className="bg-amber-950/40 border border-amber-800/50 rounded p-2 text-amber-300 text-[11px]"
                                >
                                    <div className="font-mono text-[10px] text-amber-400 mb-0.5">{d.code}</div>
                                    <div>{d.message}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
