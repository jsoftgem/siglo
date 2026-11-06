import React, { useId, useMemo, useState } from 'react';
import type { WorkflowNode } from '@siglo/core';
import { StepRun } from '../../../types';
import { DagNode } from './DagNode';
import { StepDetailCard } from './StepDetailCard';
import { EmptyState } from '../../ui/EmptyState';
import { Clock } from 'lucide-react';
import { layoutWorkflow, matchSteps, routeHighlights, NODE_HEIGHT, NODE_WIDTH } from './layout';

interface DagViewProps {
  steps: Record<string, StepRun>;
  ast?: WorkflowNode;
}

export const DagView: React.FC<DagViewProps> = ({ steps, ast }) => {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const markerId = useId().replace(/:/g, '');
  const graph = useMemo(() => ast ? layoutWorkflow(ast) : null, [ast]);
  const matches = useMemo(() => graph ? matchSteps(graph.nodes, steps || {}) : new Map<string, StepRun>(), [graph, steps]);
  const represented = new Set([...matches.values()].map(step => step.stepId));
  const highlights = graph ? routeHighlights(graph, matches) : null;
  const extraSteps = Object.values(steps || {}).filter(step => !represented.has(step.stepId));
  const selectedStep = selectedStepId ? steps?.[selectedStepId] : null;
  const select = (id: string) => setSelectedStepId(selectedStepId === id ? null : id);

  if (!graph && !extraSteps.length) {
    return <EmptyState icon={Clock} title="Awaiting Step Execution"
      description="The workflow graph will appear when its definition arrives." />;
  }

  const positions = new Map(graph?.nodes.map(node => [node.key, node]));
  return (
    <div className={`grid grid-cols-1 items-start gap-4 ${selectedStep ? 'lg:grid-cols-[minmax(0,1fr)_360px]' : ''}`}>
      <div className="min-w-0 space-y-4">
      {graph && <>
        <p className="text-xs text-slate-400">Selected routes are green; untaken routes are dimmed. Steps show their live execution status.</p>
        <div className="overflow-auto max-h-[70vh] rounded-xl border border-slate-800 bg-slate-950/40 p-4" aria-label="Workflow graph">
          <div className="relative" style={{ width: graph.width, height: graph.height }}>
            <svg className="absolute inset-0 text-slate-500" width={graph.width} height={graph.height} aria-label="Workflow connections">
              <defs>{(['taken', 'skipped', 'unknown'] as const).map(state => <marker key={state} id={`${markerId}-${state}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" className={state === 'taken' ? 'text-emerald-400' : state === 'skipped' ? 'text-slate-600' : 'text-slate-500'}><path d="M0,0 L8,4 L0,8" fill="currentColor" /></marker>)}</defs>
              {graph.edges.map((edge, i) => {
                const from = positions.get(edge.from)!;
                const to = positions.get(edge.to)!;
                const x1 = from.x + NODE_WIDTH / 2;
                const y1 = from.y + (from.height ?? NODE_HEIGHT);
                const x2 = to.x + NODE_WIDTH / 2;
                const y2 = to.y;
                const middle = to.kind === 'join' || to.kind === 'merge' ? y2 - 36 : y1 + (y2 - y1) / 2;
                const state = highlights!.edges[i];
                return <g key={i} data-route-state={state} className={state === 'taken' ? 'text-emerald-400' : state === 'skipped' ? 'text-slate-600 opacity-40' : 'text-slate-500'}>
                  <path d={`M ${x1} ${y1} V ${middle} H ${x2} V ${to.kind === 'merge' ? y2 : y2 - 4}`} fill="none" stroke="currentColor" strokeWidth={state === 'taken' ? 2.5 : 1.5} strokeDasharray={state === 'skipped' ? '5 5' : undefined} markerEnd={to.kind === 'merge' ? undefined : `url(#${markerId}-${state})`} />
                  {edge.label && <text x={x2} y={y2 - 14} textAnchor="middle" className="fill-current text-[11px]" style={{ paintOrder: 'stroke', stroke: '#020617', strokeWidth: 5, strokeLinejoin: 'round' }}>{edge.label}</text>}
                </g>;
              })}
            </svg>
            {graph.nodes.map(node => {
              if (node.kind === 'merge') return null;
              const step = matches.get(node.key);
              const state = highlights!.nodes.get(node.key);
              const placeholderStyle = node.kind === 'skip' && state === 'taken'
                ? 'border-emerald-500/50 bg-emerald-950/20 text-emerald-300'
                : `${node.kind === 'join' || node.kind === 'skip' ? 'border-dashed border-slate-700' : 'border-slate-800'} bg-slate-900 text-slate-400`;
              return <div key={node.key} data-route-state={state} className={`absolute ${state === 'skipped' ? 'opacity-40' : ''}`} style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}>
                {step ? <DagNode step={step} kind={node.kind} isSelected={selectedStepId === step.stepId} onSelect={select} />
                  : <div className={`h-full flex flex-col justify-center p-4 rounded-xl border ${placeholderStyle}`}>
                    <span className="text-[10px] uppercase tracking-wide mb-2">{node.kind}</span>
                    <span className="text-sm font-semibold text-slate-200">{node.name}</span>
                    <span className="text-xs mt-2">{state === 'skipped' ? 'Not taken' : node.kind === 'skip' && state === 'taken' ? 'Taken' : node.stepId ? 'Not observed' : ''}</span>
                  </div>}
              </div>;
            })}
          </div>
        </div>
      </>}
      {extraSteps.length > 0 && <div className="space-y-3">
        <p className="text-xs text-slate-400">{graph ? 'Other observed steps' : 'Workflow definition unavailable. Observed steps are shown without inferred connections.'}</p>
        <div className="flex flex-wrap gap-3">{extraSteps.map(step => <DagNode key={step.stepId} step={step} isSelected={selectedStepId === step.stepId} onSelect={select} />)}</div>
      </div>}
      </div>
      {selectedStep && <aside aria-label="Step details" className="fixed inset-y-0 right-0 z-40 w-full max-w-[400px] overflow-auto bg-slate-950 p-4 shadow-2xl border-l border-slate-800 lg:sticky lg:top-4 lg:z-auto lg:w-auto lg:max-w-none lg:max-h-[70vh] lg:min-w-0 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none">
        <StepDetailCard step={selectedStep} onClose={() => setSelectedStepId(null)} />
      </aside>}
    </div>
  );
};
