import React, { useState, useEffect } from 'react';
import type { GraphDocument, GraphNode } from '@siglo/ide-protocol';
import { bridge, HostMessage } from './bridge';
import { GraphCanvas } from './components/GraphCanvas';
import { WorkflowInspector } from './components/WorkflowInspector';
import { InspectorPanel } from './components/InspectorPanel';
import { Layers, CheckCircle2, RotateCw } from 'lucide-react';
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
    const [doc, setDoc] = useState<GraphDocument>(EMPTY_DOCUMENT);
    const [selectedFlowName, setSelectedFlowName] = useState<string | null>(null);
    const [inspectedWorkflowName, setInspectedWorkflowName] = useState<string | null>(null);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [autoReload, setAutoReload] = useState<boolean>(true);
    const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

    useEffect(() => {
        const unsubscribe = bridge.subscribe((msg: HostMessage) => {
            if (msg.type === 'setGraph') {
                setDoc(msg.document);
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

    const selectedNode = displayNodes.find(n => n.id === selectedNodeId) || null;

    const handleSelectNode = (node: GraphNode) => {
        setInspectedWorkflowName(null);
        setSelectedNodeId(node.id);
        bridge.notifyNodeSelected(node);
    };

    const handleManualReload = () => {
        setIsRefreshing(true);
        bridge.sendToHost({ type: 'reload' });
    };

    const handleToggleAutoReload = () => {
        const nextVal = !autoReload;
        setAutoReload(nextVal);
        bridge.sendToHost({ type: 'setAutoReload', enabled: nextVal });
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
                                        setSelectedFlowName(e.target.value);
                                        setInspectedWorkflowName(e.target.value === '__ALL__' ? null : e.target.value);
                                        setSelectedNodeId(null);
                                    }}
                                    className="w-full bg-[#1e1f22] text-[#dfe1e5] border border-[#393b40] rounded pl-2 pr-6 py-0.5 text-xs cursor-pointer focus:outline-none focus:border-[#3574f0] focus:ring-1 focus:ring-[#3574f0] appearance-none truncate [color-scheme:dark]"
                                    style={{ colorScheme: 'dark' }}
                                >
                                    <option
                                        value="__ALL__"
                                        className="bg-[#1e1f22] text-[#dfe1e5]"
                                        style={{ backgroundColor: '#1e1f22', color: '#dfe1e5' }}
                                    >
                                        All Flows ({availableWorkflows.length})
                                    </option>
                                    {availableWorkflows.map(w => (
                                        <option
                                            key={w.name}
                                            value={w.name}
                                            className="bg-[#1e1f22] text-[#dfe1e5]"
                                            style={{ backgroundColor: '#1e1f22', color: '#dfe1e5' }}
                                        >
                                            {w.name} ({w.nodes.length} steps)
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

            {/* Main Content Area */}
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
                                        onSelectWorkflow={() => inspectWorkflow(workflow.name)}
                                        embedded
                                        nodes={workflow.nodes}
                                        edges={workflow.edges}
                                        unresolved={workflow.unresolved}
                                        selectedNodeId={selectedNodeId}
                                        onSelectNode={handleSelectNode}
                                    />
                                ))}
                            </div>
                        </div>
                    ) : (
                        <GraphCanvas
                            workflowName={displayTitle}
                            workflowProperties={activeWorkflow.properties}
                            onSelectWorkflow={() => inspectWorkflow(displayTitle)}
                            nodes={displayNodes}
                            edges={displayEdges}
                            unresolved={displayUnresolved}
                            selectedNodeId={selectedNodeId}
                            onSelectNode={handleSelectNode}
                        />
                    )}
                </main>
                {inspectedWorkflow ? (
                    <WorkflowInspector
                        workflow={inspectedWorkflow}
                        onSelectNode={handleSelectNode}
                        onOpenRelatedFile={uri => bridge.notifyOpenRelatedFile(uri)}
                    />
                ) : (
                    <InspectorPanel selectedNode={selectedNode} diagnostics={displayDiagnostics} />
                )}
            </div>
        </div>
    );
};
