import React from 'react';
import { StepStatus } from '../../../types';

interface WaterfallBarProps {
  durationMs: number;
  maxDurationMs: number;
  status: StepStatus;
}

export const WaterfallBar: React.FC<WaterfallBarProps> = ({
  durationMs,
  maxDurationMs,
  status
}) => {
  const barWidthPercent = Math.min(
    100,
    Math.max(4, (durationMs / Math.max(maxDurationMs, 1)) * 100)
  );

  const getBarColor = (st: StepStatus) => {
    switch (st) {
      case 'FAILED':
        return 'bg-rose-500';
      case 'COMPLETED':
        return 'bg-emerald-500';
      case 'RUNNING':
        return 'bg-sky-500 animate-pulse';
      case 'SUSPENDED':
        return 'bg-amber-400';
      default:
        return 'bg-slate-600';
    }
  };

  return (
    <div className="w-full bg-slate-950 rounded h-3 overflow-hidden p-0.5 border border-slate-800/80">
      <div
        className={`h-full rounded-sm transition-all duration-300 ${getBarColor(status)}`}
        style={{ width: `${barWidthPercent}%` }}
      />
    </div>
  );
};
