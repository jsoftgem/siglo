import React from 'react';
import { StepRun } from '../../../types';
import { WaterfallBar } from './WaterfallBar';
import { StatusBadge } from '../../ui/StatusBadge';
import { EmptyState } from '../../ui/EmptyState';
import { BarChart2 } from 'lucide-react';

interface WaterfallViewProps {
    steps: Record<string, StepRun>;
    totalDurationMs?: number;
}

export const WaterfallView: React.FC<WaterfallViewProps> = ({ steps, totalDurationMs }) => {
    const stepList = Object.values(steps || {});

    if (stepList.length === 0) {
        return (
            <EmptyState
                icon={BarChart2}
                title="No Timeline Data"
                description="Step latency waterfalls will populate as steps complete."
            />
        );
    }

    const maxDuration = Math.max(totalDurationMs || 0, ...stepList.map(s => s.durationMs || 0), 1);

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
                <thead>
                    <tr className="border-b border-slate-800 text-slate-400 font-medium">
                        <th className="py-2.5 px-3">Step Name</th>
                        <th className="py-2.5 px-3">Status</th>
                        <th className="py-2.5 px-3">Attempts</th>
                        <th className="py-2.5 px-3">Duration</th>
                        <th className="py-2.5 px-3 w-2/5">Timeline</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                    {stepList.map(step => {
                        const dur = step.durationMs || 0;

                        return (
                            <tr key={step.stepId} className="hover:bg-slate-900/60 transition-colors">
                                <td className="py-2.5 px-3 font-sans font-medium text-slate-200">
                                    {step.stepName || step.stepId}
                                </td>
                                <td className="py-2.5 px-3">
                                    <StatusBadge status={step.status} size="sm" />
                                </td>
                                <td className="py-2.5 px-3 text-slate-400">{step.attempts || 1}</td>
                                <td className="py-2.5 px-3 text-slate-200">{dur} ms</td>
                                <td className="py-2.5 px-3">
                                    <WaterfallBar durationMs={dur} maxDurationMs={maxDuration} status={step.status} />
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
};
