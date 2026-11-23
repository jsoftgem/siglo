import React, { useState } from 'react';
import { useWorkflowMonitor } from './hooks/useWorkflowMonitor';
import { resumeWorkflow, replayWorkflow } from './api/workflowApi';
import { Header } from './components/layout/Header';
import { RunList } from './components/workflows/RunList/RunList';
import { WorkflowDetail } from './components/workflows/WorkflowDetail';
import { StatsOverview } from './components/workflows/Stats/StatsOverview';
import { Terminal } from 'lucide-react';
import sigloLogo from './assets/siglo-logo-128.png';

export const App: React.FC = () => {
    const [selectedStackId, setSelectedStackId] = useState<string | null>(null);
    const [selectedNamespace, setSelectedNamespace] = useState<string>(() => {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('namespace') || '';
    });

    const { workflows, events, isConnected, refresh } = useWorkflowMonitor();

    const handleResumeWorkflow = async (stackId: string, eventName: string, payload: unknown): Promise<void> => {
        await resumeWorkflow(stackId, eventName, payload);
        await refresh();
    };

    const handleReplayWorkflow = async (stackId: string) => {
        await replayWorkflow(stackId);
        await refresh();
    };

    const handleSelectNamespace = (ns: string) => {
        setSelectedNamespace(ns);
        setSelectedStackId(null);
        try {
            const url = new URL(window.location.href);
            if (ns) {
                url.searchParams.set('namespace', ns);
            } else {
                url.searchParams.delete('namespace');
            }
            window.history.replaceState({}, '', url.toString());
        } catch {
            // ignore if window.location cannot be manipulated
        }
    };

    const allRuns = Object.values(workflows).sort((a, b) => b.startTime - a.startTime);
    const discoveredNamespaces = Array.from(new Set(allRuns.map(r => r.namespace).filter(Boolean) as string[]));
    const namespaces = Array.from(
        new Set([...(selectedNamespace ? [selectedNamespace] : []), ...discoveredNamespaces]),
    );

    const filteredRuns = selectedNamespace ? allRuns.filter(r => r.namespace === selectedNamespace) : allRuns;

    const selectedRun = selectedStackId ? workflows[selectedStackId] : null;
    const isSelectedRunInNamespace = !selectedRun || !selectedNamespace || selectedRun.namespace === selectedNamespace;
    const activeRun = isSelectedRunInNamespace ? selectedRun : null;
    const selectedRunEvents = selectedStackId
        ? events.filter(e => e.stackId === selectedStackId)
        : selectedNamespace
          ? events.filter(e => !e.namespace || e.namespace === selectedNamespace)
          : events;

    return (
        <div className="flex flex-col h-screen w-screen overflow-hidden bg-slate-950 font-sans">
            <Header
                namespaces={namespaces}
                selectedNamespace={selectedNamespace}
                onSelectNamespace={handleSelectNamespace}
                isConnected={isConnected}
                onRefresh={refresh}
                totalRuns={filteredRuns.length}
            />

            <div className="flex flex-1 overflow-hidden">
                <RunList
                    runs={filteredRuns}
                    selectedStackId={activeRun ? selectedStackId : null}
                    onSelectRun={id => setSelectedStackId(id)}
                />

                <main className="flex-1 flex flex-col overflow-hidden bg-slate-950">
                    {activeRun ? (
                        <WorkflowDetail
                            run={activeRun}
                            events={selectedRunEvents}
                            onResume={handleResumeWorkflow}
                            onReplay={handleReplayWorkflow}
                        />
                    ) : (
                        <div className="flex-1 overflow-y-auto p-8 flex flex-col justify-center max-w-4xl mx-auto w-full space-y-8">
                            <div className="text-center space-y-2">
                                <img
                                    src={sigloLogo}
                                    alt="Siglo"
                                    className="w-16 h-16 rounded-2xl object-cover ring-2 ring-sky-500/30 shadow-xl shadow-sky-500/20 mx-auto mb-3"
                                />
                                <h2 className="text-2xl font-bold text-slate-100 tracking-tight">
                                    Siglo Live Telemetry &amp; DevTools
                                </h2>
                                <p className="text-slate-400 text-sm max-w-md mx-auto">
                                    Inspect active DAGs, review latency waterfalls, analyze state diffs, or resume
                                    suspended durable workflows in real time.
                                </p>
                            </div>

                            <StatsOverview runs={filteredRuns} />

                            <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 text-xs text-slate-400 space-y-2">
                                <div className="flex items-center gap-2 text-slate-200 font-semibold text-sm">
                                    <Terminal className="w-4 h-4 text-sky-400" />
                                    <span>How to attach live monitoring to workflows</span>
                                </div>
                                <pre className="p-3 bg-slate-950 rounded-xl border border-slate-800 text-[11px] text-sky-300 font-mono overflow-x-auto leading-relaxed">
                                    {`import { flow } from '@siglo/core';
import { createMonitorServer } from '@siglo/monitor';

const monitor = await createMonitorServer({ port: 4000 });

// Run your workflow with monitor attached
await orderWorkflow.run(orderData, {
  monitor: monitor.emitter
});`}
                                </pre>
                            </div>
                        </div>
                    )}
                </main>
            </div>
        </div>
    );
};

export default App;
