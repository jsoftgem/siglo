import React from 'react';
import { MonitoringEvent } from '../../../types';
import { formatTime, formatJson } from '../../../utils/formatters';

interface EventRowProps {
    event: MonitoringEvent;
    isSelected: boolean;
    onToggle: () => void;
}

export const EventRow: React.FC<EventRowProps> = ({ event, isSelected, onToggle }) => {
    const getBadgeStyle = (type: string) => {
        if (type.startsWith('flow:')) return 'bg-sky-500/15 text-sky-400';
        if (type.startsWith('step:complete')) return 'bg-emerald-500/15 text-emerald-400';
        if (type.startsWith('step:error') || type === 'flow:error') return 'bg-rose-500/15 text-rose-400';
        if (type.startsWith('flow:suspended')) return 'bg-amber-500/15 text-amber-400';
        return 'bg-slate-800 text-slate-300';
    };

    return (
        <div
            onClick={onToggle}
            className={`p-2.5 rounded-lg border transition-colors cursor-pointer ${
                isSelected
                    ? 'bg-slate-900 border-sky-500/50'
                    : 'bg-slate-950/70 border-slate-800/80 hover:bg-slate-900/40'
            }`}
        >
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500">{formatTime(event.timestamp)}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getBadgeStyle(event.type)}`}>
                        {event.type}
                    </span>
                    {event.stepName && (
                        <span className="text-slate-200 font-sans font-medium text-xs">{event.stepName}</span>
                    )}
                </div>
                {event.durationMs !== undefined && (
                    <span className="text-[11px] text-slate-400">{event.durationMs}ms</span>
                )}
            </div>

            {isSelected && (
                <pre className="mt-2.5 p-2 bg-slate-950 rounded border border-slate-800 text-[11px] text-sky-300 overflow-x-auto">
                    {formatJson(event)}
                </pre>
            )}
        </div>
    );
};
