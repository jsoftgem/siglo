import { EcosystemInspector } from './EcosystemInspector';
import React from 'react';
import { StepRun } from '../../../types';
import { Eye, AlertTriangle } from 'lucide-react';
import { formatDuration } from '../../../utils/formatters';

interface StepDetailCardProps {
  step: StepRun;
  onClose: () => void;
}

export const StepDetailCard: React.FC<StepDetailCardProps> = ({ step, onClose }) => {
  const formatError = (error: any): string => {
    if (!error) return '';
    if (typeof error === 'string') return error;
    if (typeof error === 'object') {
      return error.stack || error.message || JSON.stringify(error, null, 2);
    }
    return String(error);
  };

  return (
    <div className="min-w-0 break-words p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs animate-in fade-in duration-200">
      <div className="flex items-start justify-between gap-3 pb-2 border-b border-slate-800 mb-3">
        <div className="flex min-w-0 items-start gap-2">
          <Eye className="w-4 h-4 shrink-0 text-sky-400" />
          <span className="font-semibold text-slate-200 text-sm">
            Step Details: {step.stepName || step.stepId}
          </span>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 text-slate-500 hover:text-slate-300 transition-colors"
        >
          Close
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-3">
        <div className="col-span-2 min-w-0">
          <div className="text-slate-500 text-[11px]">Step ID</div>
          <div className="font-mono text-slate-200 font-medium">{step.stepId}</div>
        </div>
        <div>
          <div className="text-slate-500 text-[11px]">Status</div>
          <div className="font-semibold text-slate-200">{step.status}</div>
        </div>
        <div>
          <div className="text-slate-500 text-[11px]">Duration</div>
          <div className="font-mono text-slate-200">{formatDuration(step.durationMs)}</div>
        </div>
        <div>
          <div className="text-slate-500 text-[11px]">Attempts</div>
          <div className="font-mono text-slate-200">{step.attempts || 1}</div>
        </div>
      </div>

      {step.waitState && <div className="mb-3 text-slate-200">
        <p>Wait state: {step.waitState}</p>
        <p>Wait deadline (UTC): {step.waitExpiresAt === undefined ? 'Unavailable' : new Date(step.waitExpiresAt).toISOString()}</p>
      </div>}
      <EcosystemInspector step={step} />

      {step.error && (
        <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-800 text-rose-300 text-xs font-mono">
          <div className="flex items-center gap-1.5 font-semibold text-rose-400 mb-1">
            <AlertTriangle className="w-3.5 h-3.5" /> Error Encountered
          </div>
          <pre className="whitespace-pre-wrap">{formatError(step.error)}</pre>
        </div>
      )}
    </div>
  );
};
