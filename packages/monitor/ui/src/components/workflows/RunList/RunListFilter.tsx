import React from 'react';
import { WorkflowStatus } from '../../../types';
import { WORKFLOW_STATUS_LIST } from '../../../constants/status';
import { Search } from 'lucide-react';

interface RunListFilterProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  statusFilter: WorkflowStatus | 'ALL';
  onStatusFilterChange: (status: WorkflowStatus | 'ALL') => void;
  counts: Record<string, number>;
}

export const RunListFilter: React.FC<RunListFilterProps> = ({
  searchTerm,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  counts
}) => {
  return (
    <div className="p-3 border-b border-slate-800 space-y-2">
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-500" />
        <input
          type="text"
          placeholder="Search flow or stack ID..."
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500 transition-colors"
        />
      </div>

      <div className="flex gap-1 overflow-x-auto pb-0.5 scrollbar-none text-[11px]">
        {WORKFLOW_STATUS_LIST.map((st) => (
          <button
            key={st}
            onClick={() => onStatusFilterChange(st)}
            className={`px-2 py-0.5 rounded-md font-medium whitespace-nowrap transition-colors flex items-center gap-1 ${
              statusFilter === st
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <span>{st}</span>
            <span
              className={`text-[10px] px-1 rounded-full ${
                statusFilter === st ? 'bg-sky-500/30 text-white' : 'bg-slate-800 text-slate-400'
              }`}
            >
              {counts[st] || 0}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
