import React, { useState, useEffect, useRef } from 'react';
import type { GraphDocument, GraphNode, TelemetryRecordingDocument } from '@siglo/ide-protocol';
import { sanitizeTelemetryDocument, matchTelemetryRecord } from '@siglo/ide-protocol';
import { bridge, HostMessage } from './bridge';
import { GraphCanvas } from './components/GraphCanvas';
import { WorkflowInspector } from './components/WorkflowInspector';
import { InspectorPanel } from './components/InspectorPanel';
import { Layers, CheckCircle2, RotateCw, Database, X } from 'lucide-react';
import { RunPanel } from './components/RunPanel';
import { executionRange } from '@siglo/ide-protocol';
import sigloLogo from './assets/siglo-logo-128.png';

const EMPTY_DOCUMENT: GraphDocument = {
    uri: '',
    documentVersion: 1,
    workflowName: 'No Workflow Selected',
    nodes: [],
    edges: [],
    unresolved: [],
    diagnostics: [],
    workflows: [],
};

export const App: React.FC = () => {
    const [runTab, setRunTab] = useState(false);
    const [runSelection, setRunSelection] = useState<string[]>([]);
    const [doc, setDoc] = useState<GraphDocument>(EMPTY_DOCUMENT);
    const [selectedFlowName, setSelectedFlowName] = useState<string | null>(null);
    const [inspectedWorkflowName, setInspectedWorkflowName] = useState<string | null>(null);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [autoReload, setAutoReload] = useState<boolean>(true);
    const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
    const [telemetryDoc, setTelemetryDoc] = useState<TelemetryRecordingDocument | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        const unsubscribe = bridge.subscribe((msg: HostMessage) => {
            if (msg.type === 'setGraph') {
                setDoc(msg.document);
                setRunSelection([]);
                setInspectedWorkflowName(null);
                setIsRefreshing(false);

                const workflows = msg.document.workflows || [];
                if (workflows.length > 0) {
                    setSelectedFlowName(prev => {
                        if (prev && (prev === '__ALL__' || workflows.some(w => w.name === prev))) {
                            return prev;
                        }
                        return msg.document.workflowName || workflows[0].name;
                    });
                } else {
                    setSelectedFlowName(null);
                }

                if (msg.document.nodes.length > 0) {
                    setSelectedNodeId(msg.document.nodes[0].id);
                } else {
                    setSelectedNodeId(null);
                }
            } else if (msg.type === 'selectNode') {
                setInspectedWorkflowName(null);
                setSelectedNodeId(msg.nodeId);
            } else if (msg.type === 'clearSelection') {
                setSelectedNodeId(null);
            } else if (msg.type === 'setTelemetry') {
                const sanitized = msg.document ? sanitizeTelemetryDocument(msg.document, msg.document.fileName) : null;
                setTelemetryDoc(sanitized || null);
            } else if (msg.type === 'clearTelemetry') {
                setTelemetryDoc(null);
            }
        });

        // Notify host that UI is ready
        bridge.sendToHost({ type: 'ready' });

        return () => unsubscribe();
    }, []);

    const availableWorkflows = doc.workflows || [];
    const isAllSelected = selectedFlowName === '__ALL__';
    const currentWorkflow = availableWorkflows.find(w => w.name === selectedFlowName);

    const displayNodes = isAllSelected
        ? Array.from(new Map(availableWorkflows.flatMap(w => w.nodes).map(n => [n.id, n])).values())
        : currentWorkflow
          ? currentWorkflow.nodes
          : doc.nodes;

    const displayEdges = isAllSelected
        ? Array.from(new Map(availableWorkflows.flatMap(w => w.edges).map(e => [e.id, e])).values())
        : currentWorkflow
          ? currentWorkflow.edges
          : doc.edges;

    const displayUnresolved = isAllSelected
        ? Array.from(new Map(availableWorkflows.flatMap(w => w.unresolved).map(u => [u.id, u])).values())
        : currentWorkflow
          ? currentWorkflow.unresolved
          : doc.unresolved;

    const displayDiagnostics = isAllSelected
        ? availableWorkflows.flatMap(w => w.diagnostics)
        : currentWorkflow
          ? currentWorkflow.diagnostics
          : doc.diagnostics;

    const displayTitle = isAllSelected
        ? `All Flows (${availableWorkflows.length})`
        : currentWorkflow
          ? currentWorkflow.name
          : doc.workflowName;

    const activeWorkflow = currentWorkflow || {
        name: doc.workflowName,
        uri: doc.uri,
        location: doc.location,
        properties: doc.properties,
        nodes: doc.nodes,
        edges: doc.edges,
        unresolved: doc.unresolved,
        diagnostics: doc.diagnostics,
    };
    const inspectedWorkflow = inspectedWorkflowName
        ? availableWorkflows.find(w => w.name === inspectedWorkflowName) ||
          (activeWorkflow.name === inspectedWorkflowName ? activeWorkflow : null)
        : null;
    const inspectWorkflow = (name: string) => {
        setSelectedNodeId(null);
        setInspectedWorkflowName(name);
        bridge.notifyWorkflowSelected(name);
    };

    const telemetryRecords = telemetryDoc?.records || [];
    const telemetryWorkflowName = telemetryRecords[0]?.workflowName;
    const isTelemetryWorkflowMismatch = Boolean(
        telemetryDoc &&
        telemetryWorkflowName &&
        activeWorkflow.name &&
        telemetryRecords.length > 0 &&
        telemetryRecords.every(r => r.workflowName !== activeWorkflow.name),
    );
    const telemetryMatchedCount = telemetryDoc
        ? (activeWorkflow.nodes || []).filter(node =>
              telemetryRecords.some(rec => matchTelemetryRecord(rec, activeWorkflow.name, undefined, node)),
          ).length
        : 0;

    const selectedNode = displayNodes.find(n => n.id === selectedNodeId) || null;

    const handleSelectNode = (node: GraphNode, toggle = false) => {
        setRunSelection(previous =>
            toggle
                ? previous.includes(node.id)
                    ? previous.filter(id => id !== node.id)
                    : [...previous, node.id]
                : [node.id],
        );
        setInspectedWorkflowName(null);
        setSelectedNodeId(node.id);
        if (!runTab) bridge.notifyNodeSelected(node);
    };

    let effectiveSelection = runSelection;
    try {
        effectiveSelection = executionRange(displayNodes, displayEdges, runSelection).map(node => node.id);
    } catch {
        /* Panel explains invalid selection. */
    }
    const handleManualReload = () => {
        setIsRefreshing(true);
        bridge.sendToHost({ type: 'reload' });
    };

    const handleToggleAutoReload = () => {
        const nextVal = !autoReload;
        setAutoReload(nextVal);
        bridge.sendToHost({ type: 'setAutoReload', enabled: nextVal });
    };

    const handleImportTelemetryClick = () => {
        bridge.notifyImportTelemetry();
        if (!window.cefQuery && !window.acquireVsCodeApi && fileInputRef.current) {
            fileInputRef.current.click();
        }
    };

    const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            try {
                const raw = ev.target?.result;
                if (typeof raw === 'string') {
                    const parsed = JSON.parse(raw);
                    const sanitized = sanitizeTelemetryDocument(parsed, file.name);
                    setTelemetryDoc(sanitized || null);
                }
            } catch (err) {
                console.error('Failed to parse telemetry file:', err);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    const handleClearTelemetry = (e: React.MouseEvent) => {
        e.stopPropagation();
        setTelemetryDoc(null);
    };

    return (
        <div className="flex flex-col w-screen h-screen bg-[#1e1f22] text-[#bcbec4] select-none overflow-hidden font-sans">
            {/* Top Bar */}
            <header className="min-h-10 gap-2 flex-wrap py-2 border-b border-[#393b40] bg-[#2b2d30] px-4 flex items-center justify-between text-xs flex-shrink-0">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                    <img
                        src={sigloLogo}
                        alt="Siglo"
                        className="w-5 h-5 rounded-md object-cover ring-1 ring-sky-500/40"
                    />
                    {availableWorkflows.length > 1 ? (
                        <div className="flex items-center gap-1.5 min-w-0 flex-1 max-w-sm">
                            <span className="text-[11px] text-[#868a98] font-medium">Flow:</span>
                            <div className="relative min-w-0 flex-1">
                                <select
                                    aria-label="Workflow"
                                    title={displayTitle}
                                    value={selectedFlowName || doc.workflowName}
                                    onChange={e => {
                                        setRunSelection([]);
                                        setSelectedFlowName(e.target.value);
                                        setInspectedWorkflowName(e.target.value === '__ALL__' ? null : e.target.value);
                                        setSelectedNodeId(null);
                                    }}
                                    className="w-full bg-[#1e1f22] text-[#dfe1e5] border border-[#393b40] rounded pl-2 pr-6 py-0.5 text-xs cursor-pointer focus:outline-none focus:border-[#3574f0] focus:ring-1 focus:ring-[#3574f0] appearance-none truncate [color-scheme:dark]"
                                    style={{ colorScheme: 'dark' }}
                                >
                                    <option
                                        value="__ALL__"
                                        className="bg-[#1e1f22] text-[#dfe1e5] border-0"
                                        style={{ backgroundColor: '#1e1f22', color: '#dfe1e5' }}
                                    >
                                        All Flows ({availableWorkflows.length})
                                    </option>
                                    {availableWorkflows.map(wf => (
                                        <option
                                            key={wf.name}
                                            value={wf.name}
                                            className="bg-[#1e1f22] text-[#dfe1e5] border-0"
                                            style={{ backgroundColor: '#1e1f22', color: '#dfe1e5' }}
                                        >
                                            {wf.name} ({wf.nodes.length} steps)
                                        </option>
                                    ))}
                                </select>
                                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[#868a98]">
                                    ▾
                                </span>
                            </div>
                        </div>
                    ) : (
                        <span title={displayTitle} className="font-semibold text-[#dfe1e5] truncate">
                            {displayTitle}
                        </span>
                    )}
                    {doc.uri && (
                        <span title="Source document revision" className="text-[11px] text-[#868a98]">
                            r{doc.documentVersion}
                        </span>
                    )}
                </div>
                <div className="flex items-center space-x-3 text-[11px] text-[#868a98]">
                    {/* Telemetry Import / Status Badge (Milestone 4) */}
                    {telemetryDoc ? (
                        <div
                            className={`flex items-center space-x-1.5 px-2 py-1 rounded bg-[#1e1f22] border ${
                                isTelemetryWorkflowMismatch
                                    ? 'border-amber-700/60 text-amber-300'
                                    : 'border-emerald-800/60 text-[#dfe1e5]'
                            }`}
                        >
                            <Database
                                className={`w-3.5 h-3.5 ${isTelemetryWorkflowMismatch ? 'text-amber-400' : 'text-emerald-400'}`}
                            />
                            <span
                                className="truncate max-w-[150px] font-mono text-[10px]"
                                title={
                                    isTelemetryWorkflowMismatch
                                        ? `Telemetry recording is for "${telemetryWorkflowName}", but active flow is "${activeWorkflow.name}". Open ${telemetryWorkflowName}.workflow.ts to inspect recorded traces.`
                                        : `${telemetryDoc.fileName || 'Telemetry'} (${telemetryMatchedCount}/${telemetryRecords.length} steps matched)`
                                }
                            >
                                {telemetryDoc.fileName || 'Telemetry'}{' '}
                                {isTelemetryWorkflowMismatch
                                    ? '(0 matched)'
                                    : `(${telemetryMatchedCount}/${telemetryRecords.length})`}
                            </span>
                            <button
                                onClick={handleClearTelemetry}
                                title="Clear telemetry recording"
                                className="p-0.5 hover:bg-[#393b40] rounded text-[#868a98] hover:text-[#dfe1e5] transition-colors"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                    ) : (
                        <button
                            onClick={handleImportTelemetryClick}
                            title="Import recorded telemetry JSON file"
                            className="flex items-center space-x-1 px-2 py-1 rounded bg-[#393b40] hover:bg-[#4e5157] text-[#dfe1e5] transition-colors"
                        >
                            <Database className="w-3.5 h-3.5 text-sky-400" />
                            <span>Import Telemetry</span>
                        </button>
                    )}
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".json,application/json"
                        style={{ display: 'none' }}
                        onChange={handleFileInputChange}
                    />

                    {/* Reload Button */}
                    <button
                        onClick={handleManualReload}
                        title="Reload workflow graph"
                        className="flex items-center space-x-1 px-2 py-1 rounded bg-[#393b40] hover:bg-[#4e5157] text-[#dfe1e5] transition-colors"
                    >
                        <RotateCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-[#3574f0]' : ''}`} />
                        <span>Reload</span>
                    </button>

                    {/* Auto-Reload Toggle */}
                    <label className="flex items-center space-x-1.5 cursor-pointer text-[#a8adbb] hover:text-[#dfe1e5]">
                        <input
                            type="checkbox"
                            checked={autoReload}
                            onChange={handleToggleAutoReload}
                            className="accent-[#3574f0] w-3.5 h-3.5 cursor-pointer rounded"
                        />
                        <span>Auto-Reload</span>
                    </label>

                    <div className="h-3 w-px bg-[#393b40]" />

                    <div className="flex items-center space-x-1">
                        <Layers className="w-3.5 h-3.5" />
                        <span>{displayNodes.length} steps</span>
                    </div>
                    <div className="flex items-center space-x-1 text-emerald-400">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Static AST</span>
                    </div>
                </div>
            </header>

            {/* Main Area */}
            <div className="flex flex-col sm:flex-row flex-1 min-h-0 overflow-hidden">
                <main className="flex-1 min-w-0 min-h-0 relative overflow-hidden">
                    {displayNodes.length === 0 && displayUnresolved.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-[#868a98] p-8 text-center">
                            <img
                                src={sigloLogo}
                                alt="Siglo"
                                className="w-14 h-14 rounded-xl mb-3 opacity-80 object-cover ring-1 ring-sky-500/30 shadow-lg shadow-sky-500/10"
                            />
                            <p className="text-sm font-medium text-[#dfe1e5] mb-1">No workflow detected</p>
                            <p className="text-xs max-w-sm">
                                Open or select a TypeScript file containing a Siglo workflow definition (
                                <code className="text-[#a8adbb]">flow(...)</code> or{' '}
                                <code className="text-[#a8adbb]">Step.create(...)</code>).
                            </p>
                        </div>
                    ) : isAllSelected ? (
                        <div className="h-full overflow-auto p-6">
                            <div className="flex w-max items-start gap-6">
                                {availableWorkflows.map(workflow => (
                                    <GraphCanvas
                                        key={workflow.name}
                                        workflowName={workflow.name}
                                        workflowProperties={workflow.properties}
                                        workflowVersion={
                                            workflow.properties?.workflowVersion || workflow.properties?.version
                                        }
                                        telemetryDocument={telemetryDoc}
                                        onSelectWorkflow={() => inspectWorkflow(workflow.name)}
                                        nodes={workflow.nodes}
                                        edges={workflow.edges}
                                        unresolved={workflow.unresolved}
                                        selectedNodeId={selectedNodeId}
                                        selectedNodeIds={runTab ? effectiveSelection : undefined}
                                        onSelectNode={handleSelectNode}
                                    />
                                ))}
                            </div>
                        </div>
                    ) : (
                        <GraphCanvas
                            workflowName={displayTitle}
                            workflowProperties={activeWorkflow.properties}
                            workflowVersion={
                                activeWorkflow.properties?.workflowVersion || activeWorkflow.properties?.version
                            }
                            telemetryDocument={telemetryDoc}
                            onSelectWorkflow={() => inspectWorkflow(displayTitle)}
                            nodes={displayNodes}
                            edges={displayEdges}
                            unresolved={displayUnresolved}
                            selectedNodeId={selectedNodeId}
                            selectedNodeIds={runTab ? effectiveSelection : undefined}
                            onSelectNode={handleSelectNode}
                        />
                    )}
                </main>
                <aside className="flex flex-col min-h-0 w-full sm:w-[360px] border-l border-[#393b40] bg-[#2b2d30]">
                    <div className="flex gap-4 px-3 pt-2 border-b border-[#393b40] text-xs">
                        <button
                            aria-pressed={!runTab}
                            onClick={() => setRunTab(false)}
                            className={`pb-2 -mb-px transition-colors ${
                                !runTab
                                    ? 'text-[#dfe1e5] border-b-2 border-[#3574f0] font-semibold'
                                    : 'text-[#868a98] hover:text-[#bcbec4]'
                            }`}
                        >
                            Inspect
                        </button>
                        <button
                            aria-pressed={runTab}
                            onClick={() => setRunTab(true)}
                            className={`pb-2 -mb-px transition-colors ${
                                runTab
                                    ? 'text-[#dfe1e5] border-b-2 border-[#3574f0] font-semibold'
                                    : 'text-[#868a98] hover:text-[#bcbec4]'
                            }`}
                        >
                            Run
                        </button>
                    </div>
                    <div style={{ display: runTab ? 'block' : 'none' }} className="flex-1 min-h-0">
                        <RunPanel
                            document={doc}
                            workflowName={activeWorkflow.name}
                            nodes={displayNodes}
                            edges={displayEdges}
                            selected={runSelection}
                            allFlows={isAllSelected}
                        />
                    </div>
                    <div style={{ display: runTab ? 'none' : 'contents' }}>
                        {inspectedWorkflow ? (
                            <WorkflowInspector
                                workflow={inspectedWorkflow}
                                onSelectNode={handleSelectNode}
                                onOpenRelatedFile={uri => bridge.notifyOpenRelatedFile(uri)}
                            />
                        ) : (
                            <InspectorPanel
                                selectedNode={selectedNode}
                                diagnostics={displayDiagnostics}
                                workflowName={activeWorkflow.name}
                                workflowVersion={
                                    activeWorkflow.properties?.workflowVersion || activeWorkflow.properties?.version
                                }
                                telemetryDocument={telemetryDoc}
                            />
                        )}
                    </div>
                </aside>
            </div>
        </div>
    );
};
