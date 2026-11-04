import React from 'react';
import { WorkflowRun } from '../../../types';
import { Activity, CheckCircle2, XCircle, PauseCircle } from 'lucide-react';

interface StatsOverviewProps {
  runs: WorkflowRun[];
}

export const StatsOverview: React.FC<StatsOverviewProps> = ({ runs }) => {
  const activeCount = runs.filter((r) => r.status === 'RUNNING').length;
  const completedCount = runs.filter((r) => r.status === 'COMPLETED').length;
  const failedCount = runs.filter((r) => r.status === 'FAILED').length;
  const suspendedCount = runs.filter((r) => r.status === 'SUSPENDED').length;

  const stats = [
    {
      label: 'Active Flows',
      value: activeCount,
      icon: Activity,
      color: 'text-sky-400',
      bg: 'bg-sky-500/10 border-sky-500/20'
    },
    {
      label: 'Suspended',
      value: suspendedCount,
      icon: PauseCircle,
      color: 'text-amber-400',
      bg: 'bg-amber-500/10 border-amber-500/20'
    },
    {
      label: 'Completed',
      value: completedCount,
      icon: CheckCircle2,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10 border-emerald-500/20'
    },
    {
      label: 'Failed',
      value: failedCount,
      icon: XCircle,
      color: 'text-rose-400',
      bg: 'bg-rose-500/10 border-rose-500/20'
    }
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {stats.map((st) => {
        const Icon = st.icon;
        return (
          <div
            key={st.label}
            className={`p-4 rounded-xl border ${st.bg} flex items-center justify-between shadow-sm`}
          >
            <div>
              <div className="text-[11px] font-medium text-slate-400">{st.label}</div>
              <div className="text-xl font-bold text-slate-100 mt-1">{st.value}</div>
            </div>
            <Icon className={`w-5 h-5 ${st.color}`} />
          </div>
        );
      })}
    </div>
  );
};
