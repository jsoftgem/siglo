import React from 'react';
import { StepRun, StepStatus } from '../../../types';
import { CheckCircle2, XCircle, Clock, RotateCw } from 'lucide-react';

interface DagNodeProps {
  step: StepRun;
  isSelected: boolean;
  onSelect: (stepId: string) => void;
}

export const DagNode: React.FC<DagNodeProps> = ({ step, isSelected, onSelect }) => {
  const getNodeStyles = (status: StepStatus, selected: boolean) => {
    let base = 'relative flex flex-col p-4 rounded-xl border transition-all cursor-pointer min-w-[200px] max-w-[260px] ';
    if (selected) {
      base += 'ring-2 ring-sky-400 ring-offset-2 ring-offset-slate-900 ';
    }

    switch (status) {
      case 'RUNNING':
        return base + 'bg-sky-950/40 border-sky-500 shadow-lg shadow-sky-500/20';
      case 'COMPLETED':
        return base + 'bg-emerald-950/20 border-emerald-500/50 hover:border-emerald-400';
      case 'FAILED':
        return base + 'bg-rose-950/30 border-rose-500/70 shadow-lg shadow-rose-500/20';
      case 'SKIPPED':
        return base + 'bg-slate-900 border-slate-800 opacity-60';
      default:
        return base + 'bg-slate-900 border-slate-800';
    }
  };

  const getStatusIcon = (status: StepStatus) => {
    switch (status) {
      case 'RUNNING':
        return <RotateCw className="w-4 h-4 text-sky-400 animate-spin" />;
      case 'COMPLETED':
        return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
      case 'FAILED':
        return <XCircle className="w-4 h-4 text-rose-400" />;
      case 'SKIPPED':
      default:
        return <Clock className="w-4 h-4 text-slate-500" />;
    }
  };

  return (
    <div
      onClick={() => onSelect(step.stepId)}
      className={getNodeStyles(step.status, isSelected)}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[10px] font-mono text-slate-400 truncate">
          {step.stepId}
        </span>
        {getStatusIcon(step.status)}
      </div>

      <div className="font-semibold text-sm text-slate-100 truncate mb-1">
        {step.stepName || step.stepId}
      </div>

      <div className="flex items-center justify-between text-xs text-slate-400 mt-2 pt-2 border-t border-slate-800/80">
        <span className="font-mono text-[11px]">
          {step.durationMs !== undefined ? `${step.durationMs}ms` : 'In progress...'}
        </span>
        {step.attempts && step.attempts > 1 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-medium">
            {step.attempts} tries
          </span>
        )}
      </div>
    </div>
  );
};
