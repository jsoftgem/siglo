import React, { useState } from 'react';
import { WorkflowRun, WorkflowStatus } from '../../../types';
import { RunListFilter } from './RunListFilter';
import { RunListItem } from './RunListItem';

interface RunListProps {
  runs: WorkflowRun[];
  selectedStackId: string | null;
  onSelectRun: (stackId: string) => void;
}

export const RunList: React.FC<RunListProps> = ({
  runs,
  selectedStackId,
  onSelectRun
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<WorkflowStatus | 'ALL'>('ALL');

  const filteredRuns = runs.filter((run) => {
    const matchesSearch =
      (run.flowName || 'Workflow').toLowerCase().includes(searchTerm.toLowerCase()) ||
      run.stackId.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (run.namespace || '').toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = statusFilter === 'ALL' || run.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const counts: Record<string, number> = {
    ALL: runs.length,
    RUNNING: runs.filter((r) => r.status === 'RUNNING').length,
    SUSPENDED: runs.filter((r) => r.status === 'SUSPENDED').length,
    FAILED: runs.filter((r) => r.status === 'FAILED').length,
    COMPLETED: runs.filter((r) => r.status === 'COMPLETED').length
  };

  return (
    <aside className="w-80 border-r border-slate-800 bg-slate-900/50 flex flex-col shrink-0 h-full">
      <RunListFilter
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        counts={counts}
      />

      <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60">
        {filteredRuns.length === 0 ? (
          <div className="p-6 text-center text-slate-500 text-xs">
            No workflows found.
          </div>
        ) : (
          filteredRuns.map((run) => (
            <RunListItem
              key={run.stackId}
              run={run}
              isSelected={selectedStackId === run.stackId}
              onSelect={onSelectRun}
            />
          ))
        )}
      </div>
    </aside>
  );
};
