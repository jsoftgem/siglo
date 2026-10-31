import React from 'react';
import { WorkflowStatus, StepStatus } from '../../types';
import { CheckCircle2, XCircle, PauseCircle, SkipForward, Clock } from 'lucide-react';

interface StatusBadgeProps {
  status: WorkflowStatus | StepStatus;
  size?: 'sm' | 'md';
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, size = 'md' }) => {
  const isSm = size === 'sm';
  const sizeClasses = isSm ? 'text-[10px] px-1.5 py-0.5' : 'text-[11px] px-2 py-0.5';

  switch (status) {
    case 'RUNNING':
      return (
        <span className={`inline-flex items-center gap-1 font-medium rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20 ${sizeClasses}`}>
          <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-ping" />
          RUNNING
        </span>
      );
    case 'COMPLETED':
      return (
        <span className={`inline-flex items-center gap-1 font-medium rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 ${sizeClasses}`}>
          <CheckCircle2 className={isSm ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
          COMPLETED
        </span>
      );
    case 'FAILED':
      return (
        <span className={`inline-flex items-center gap-1 font-medium rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20 ${sizeClasses}`}>
          <XCircle className={isSm ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
          FAILED
        </span>
      );
    case 'SUSPENDED':
      return (
        <span className={`inline-flex items-center gap-1 font-medium rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 ${sizeClasses}`}>
          <PauseCircle className={isSm ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
          SUSPENDED
        </span>
      );
    case 'SKIPPED':
      return (
        <span className={`inline-flex items-center gap-1 font-medium rounded-full bg-slate-500/10 text-slate-400 border border-slate-500/20 ${sizeClasses}`}>
          <SkipForward className={isSm ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
          SKIPPED
        </span>
      );
    default:
      return (
        <span className={`inline-flex items-center gap-1 font-medium rounded-full bg-slate-800 text-slate-400 ${sizeClasses}`}>
          <Clock className={isSm ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
          {status}
        </span>
      );
  }
};
