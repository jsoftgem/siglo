import React from 'react';
import { StepProperties } from './StepProperties';
import type {
    GraphNode,
    Diagnostic,
    TelemetryRecordingDocument,
    HttpEcosystemConfig,
    CryptoEcosystemConfig,
    NotificationEcosystemConfig,
    AiEcosystemConfig,
    HttpTelemetryRecord,
    CryptoTelemetryRecord,
    NotificationTelemetryRecord,
    AiTelemetryRecord,
    EcosystemInspectionData,
} from '@siglo/ide-protocol';
import { matchTelemetryRecord } from '@siglo/ide-protocol';
import { HttpInspector } from './inspectors/HttpInspector';
import { CryptoInspector } from './inspectors/CryptoInspector';
import { NotificationInspector } from './inspectors/NotificationInspector';
import { AiInspector } from './inspectors/AiInspector';
import { ShieldAlert, Clock, RefreshCw, FileCode, CornerDownRight, Database } from 'lucide-react';

interface InspectorPanelProps {
    selectedNode: GraphNode | null;
    diagnostics: Diagnostic[];
    workflowName?: string;
    workflowVersion?: number | string;
    telemetryDocument?: TelemetryRecordingDocument | null;
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
    selectedNode,
    diagnostics,
    workflowName,
    workflowVersion,
    telemetryDocument,
}) => {
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
            (d.range.start.line >= selectedNode.location.start.line &&
                d.range.end.line <= selectedNode.location.end.line) ||
            (d.range.start.line >= selectedNode.declarationRange.start.line &&
                d.range.end.line <= selectedNode.declarationRange.end.line) ||
            d.message.includes(`"${selectedNode.name}"`),
    );

    // Find matched telemetry record (if recording document loaded)
    const telemetryRecords = telemetryDocument?.records || [];
    const matchedEnvelope = telemetryRecords.find(rec =>
        matchTelemetryRecord(rec, workflowName || '', workflowVersion, selectedNode),
    );

    const hasTelemetryDocument = Boolean(telemetryDocument);
    const hasMatchedTelemetry = Boolean(matchedEnvelope);
    const isWorkflowMismatch = Boolean(
        telemetryDocument &&
        workflowName &&
        telemetryRecords.length > 0 &&
        telemetryRecords.every(r => r.workflowName !== workflowName),
    );

    return (
        <div className="w-full sm:w-80 max-w-none sm:max-w-[45vw] min-w-0 sm:min-w-[240px] max-h-[45%] sm:max-h-none shrink-0 border-l border-[#393b40] bg-[#25262a] flex flex-col h-full text-xs overflow-y-auto">
            {/* Header */}
            <div className="p-4 border-b border-[#393b40]">
                <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-semibold text-sm text-[#dfe1e5] min-w-0 truncate">{selectedNode.name}</span>
                    <span className="shrink-0 font-mono text-[10px] uppercase px-1.5 py-0.5 rounded bg-[#393b40] text-[#a8adbb]">
                        {selectedNode.stepKind}
                    </span>
                </div>
                <p className="font-mono text-[11px] text-[#868a98] break-all">{selectedNode.id}</p>
                {hasTelemetryDocument && (
                    <div className="mt-2 flex items-center gap-1.5 text-[10px]">
                        <Database className="w-3 h-3 text-[#868a98]" />
                        {hasMatchedTelemetry ? (
                            <span className="text-emerald-400 font-medium">Telemetry recording linked</span>
                        ) : isWorkflowMismatch ? (
                            <span
                                className="text-amber-400/90 italic"
                                title={`Recording is for "${telemetryRecords[0]?.workflowName}". Active workflow is "${workflowName}".`}
                            >
                                Recording is for &quot;{telemetryRecords[0]?.workflowName}&quot;
                            </span>
                        ) : (
                            <span className="text-amber-400/90 italic">No telemetry record for this step</span>
                        )}
                    </div>
                )}
            </div>

            {hasTelemetryDocument && isWorkflowMismatch && (
                <div className="mx-4 mt-3 p-2.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[11px] leading-relaxed">
                    <span className="font-semibold block mb-0.5">Workflow Mismatch</span>
                    Recording <span className="font-mono text-amber-200">{telemetryDocument?.fileName}</span> is for
                    workflow{' '}
                    <code className="text-amber-200 bg-amber-950/40 px-1 py-0.5 rounded">
                        {telemetryRecords[0]?.workflowName}
                    </code>
                    , but the active flow is{' '}
                    <code className="text-amber-200 bg-amber-950/40 px-1 py-0.5 rounded">{workflowName}</code>. Open{' '}
                    <span className="font-semibold underline">{telemetryRecords[0]?.workflowName}.workflow.ts</span> to
                    view runtime traces.
                </div>
            )}

            <div className="p-4 space-y-4 flex-1">
                {/* Dedicated Ecosystem Deep-Dive Inspectors (Milestone 4) */}
                {selectedNode.stepKind === 'http' && (
                    <HttpInspector
                        config={selectedNode.ecosystemConfig as HttpEcosystemConfig | undefined}
                        telemetry={
                            matchedEnvelope?.inspection.kind === 'http'
                                ? (matchedEnvelope.inspection as EcosystemInspectionData & HttpTelemetryRecord)
                                : null
                        }
                    />
                )}

                {selectedNode.stepKind === 'crypto' && (
                    <CryptoInspector
                        config={selectedNode.ecosystemConfig as CryptoEcosystemConfig | undefined}
                        telemetry={
                            matchedEnvelope?.inspection.kind === 'crypto'
                                ? (matchedEnvelope.inspection as EcosystemInspectionData & CryptoTelemetryRecord)
                                : null
                        }
                    />
                )}

                {selectedNode.stepKind === 'notification' && (
                    <NotificationInspector
                        config={selectedNode.ecosystemConfig as NotificationEcosystemConfig | undefined}
                        telemetry={
                            matchedEnvelope?.inspection.kind === 'notification'
                                ? (matchedEnvelope.inspection as EcosystemInspectionData & NotificationTelemetryRecord)
                                : null
                        }
                    />
                )}

                {selectedNode.stepKind === 'ai' && (
                    <AiInspector
                        config={selectedNode.ecosystemConfig as AiEcosystemConfig | undefined}
                        telemetry={
                            matchedEnvelope?.inspection.kind === 'ai'
                                ? (matchedEnvelope.inspection as EcosystemInspectionData & AiTelemetryRecord)
                                : null
                        }
                    />
                )}

                {/* Source Coordinates */}
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

                {/* Generic Execution Configuration (retries / timeout / compensation) */}
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

                {/* Input Contract Specifications (.spec / .schema) */}
                <StepProperties key={selectedNode.id} node={selectedNode} />

                {/* Diagnostics */}
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
