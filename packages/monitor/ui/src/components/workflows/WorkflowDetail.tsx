import React, { useState } from 'react';
import { WorkflowRun, MonitoringEvent } from '../../types';
import { DagView } from './Dag/DagView';
import { WaterfallView } from './Waterfall/WaterfallView';
import { ContextViewer } from './Context/ContextViewer';
import { EventsFeed } from './Events/EventsFeed';
import { ResumeModal } from './ResumeModal/ResumeModal';
import { StatusBadge } from '../ui/StatusBadge';
import { useClipboard } from '../../hooks/useClipboard';
import { formatDuration } from '../../utils/formatters';
import {
  GitFork,
  BarChart2,
  Code2,
  ListOrdered,
  Play,
  RotateCw,
  Copy,
  Check,
  AlertTriangle
} from 'lucide-react';

interface WorkflowDetailProps {
  run: WorkflowRun;
  events: MonitoringEvent[];
  onResume: (stackId: string, eventName: string, payload: any) => Promise<void>;
  onReplay: (stackId: string) => Promise<void>;
}

export const WorkflowDetail: React.FC<WorkflowDetailProps> = ({
  run,
  events,
  onResume,
  onReplay
}) => {
  const [activeTab, setActiveTab] = useState<'dag' | 'waterfall' | 'context' | 'events'>('dag');
  const [isResumeModalOpen, setIsResumeModalOpen] = useState(false);
  const { copied, copy } = useClipboard();
  const [isReplaying, setIsReplaying] = useState(false);
  const [replaySuccess, setReplaySuccess] = useState(false);

  const handleReplayClick = async () => {
    try {
      setIsReplaying(true);
      await onReplay(run.stackId);
      setReplaySuccess(true);
      setTimeout(() => setReplaySuccess(false), 2500);
    } catch (err) {
      console.error(err);
    } finally {
      setIsReplaying(false);
    }
  };

  const tabs = [
    { id: 'dag', label: 'Topology (DAG)', icon: GitFork },
    { id: 'waterfall', label: 'Latency Waterfall', icon: BarChart2 },
    { id: 'context', label: 'Context & State Diff', icon: Code2 },
    { id: 'events', label: 'Live Events', icon: ListOrdered }
  ] as const;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Top Banner Card */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg relative overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <h2 className="text-xl font-bold text-slate-100 tracking-tight">
                {run.flowName || 'Workflow Execution'}
              </h2>
              <StatusBadge status={run.status} />
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400 font-mono">
              <div className="flex items-center gap-1.5 bg-slate-950/80 px-2 py-0.5 rounded border border-slate-800">
                <span>Stack: {run.stackId}</span>
                <button
                  onClick={() => copy(run.stackId)}
                  className="hover:text-slate-200 transition-colors"
                  title="Copy ID"
                >
                  {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>

              {run.namespace && (
                <div className="bg-slate-950/80 px-2 py-0.5 rounded border border-slate-800 font-sans">
                  ns: <span className="text-slate-300 font-medium">{run.namespace}</span>
                </div>
              )}

              <div className="bg-slate-950/80 px-2 py-0.5 rounded border border-slate-800">
                Duration: <span className="text-slate-200 font-medium">{formatDuration(run.durationMs)}</span>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            {run.status === 'SUSPENDED' && (
              <button
                onClick={() => setIsResumeModalOpen(true)}
                className="flex h-9 items-center gap-1.5 px-3.5 rounded-xl text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 transition-all shadow-md shadow-amber-500/20 active:scale-95"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Resume</span>
              </button>
            )}

            <button
              onClick={handleReplayClick}
              disabled={isReplaying}
              className="flex h-9 items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-all active:scale-95 disabled:opacity-50"
            >
              <RotateCw className={`w-3.5 h-3.5 ${isReplaying ? 'animate-spin' : ''}`} />
              <span>{replaySuccess ? 'Replayed!' : 'Replay'}</span>
            </button>
          </div>
        </div>

        {/* Suspended Alert */}
        {run.status === 'SUSPENDED' && (
          <div className="mt-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between text-xs text-amber-300">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                Workflow paused waiting for event: <strong>{run.waitingForEvent || 'External Signal'}</strong>
              </span>
            </div>
            <button
              onClick={() => setIsResumeModalOpen(true)}
              className="text-xs font-semibold underline underline-offset-2 hover:text-amber-200"
            >
              Resume Now →
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-800 flex items-center gap-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                isActive
                  ? 'border-sky-500 text-sky-400 font-semibold'
                  : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab Panels */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
        {activeTab === 'dag' && <DagView steps={run.steps} ast={run.ast} />}
        {activeTab === 'waterfall' && (
          <WaterfallView steps={run.steps} totalDurationMs={run.durationMs} />
        )}
        {activeTab === 'context' && (
          <ContextViewer context={run.context} diffs={run.contextDiffs} />
        )}
        {activeTab === 'events' && <EventsFeed events={events} />}
      </div>

      {/* Resume Modal */}
      <ResumeModal
        stackId={run.stackId}
        waitingForEvent={run.waitingForEvent}
        isOpen={isResumeModalOpen}
        onClose={() => setIsResumeModalOpen(false)}
        onResume={async (key, eventName, payload) => {
          await onResume(key, eventName, payload);
        }}
      />
    </div>
  );
};
