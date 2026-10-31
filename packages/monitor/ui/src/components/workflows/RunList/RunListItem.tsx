import React from 'react';
import { WorkflowRun } from '../../../types';
import { StatusBadge } from '../../ui/StatusBadge';
import { Clock } from 'lucide-react';
import { formatTime, truncateId } from '../../../utils/formatters';

interface RunListItemProps {
  run: WorkflowRun;
  isSelected: boolean;
  onSelect: (stackId: string) => void;
}

export const RunListItem: React.FC<RunListItemProps> = ({
  run,
  isSelected,
  onSelect
}) => {
  const stepCount = Object.keys(run.steps || {}).length;
  const completedSteps = Object.values(run.steps || {}).filter(
    (s) => s.status === 'COMPLETED'
  ).length;

  return (
    <div
      onClick={() => onSelect(run.stackId)}
      className={`p-3.5 cursor-pointer transition-all border-l-2 ${
        isSelected
          ? 'bg-slate-800/70 border-sky-500 shadow-sm'
          : 'border-transparent hover:bg-slate-800/30'
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <span className="font-semibold text-sm text-slate-100 truncate">
          {run.flowName || 'Workflow'}
        </span>
        <StatusBadge status={run.status} size="sm" />
      </div>

      <div className="flex items-center justify-between text-xs text-slate-400">
        <span className="font-mono text-[11px] text-slate-400 hover:text-slate-300">
          {truncateId(run.stackId, 8)}
        </span>
        <div className="flex items-center gap-1 text-[11px] text-slate-400">
          <Clock className="w-3 h-3 text-slate-500" />
          <span>{run.durationMs ? `${run.durationMs}ms` : formatTime(run.startTime)}</span>
        </div>
      </div>

      {stepCount > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 bg-slate-950 rounded-full h-1 overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${
                run.status === 'FAILED'
                  ? 'bg-rose-500'
                  : run.status === 'SUSPENDED'
                  ? 'bg-amber-400'
                  : 'bg-sky-500'
              }`}
              style={{
                width: `${Math.round((completedSteps / stepCount) * 100)}%`,
              }}
            />
          </div>
          <span className="text-[10px] text-slate-400 font-mono">
            {completedSteps}/{stepCount}
          </span>
        </div>
      )}
    </div>
  );
};
