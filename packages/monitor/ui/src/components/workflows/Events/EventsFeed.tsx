import React, { useState } from 'react';
import { MonitoringEvent } from '../../../types';
import { EventRow } from './EventRow';
import { EmptyState } from '../../ui/EmptyState';
import { Terminal } from 'lucide-react';

interface EventsFeedProps {
    events: MonitoringEvent[];
}

export const EventsFeed: React.FC<EventsFeedProps> = ({ events }) => {
    const [filterType, setFilterType] = useState<string>('ALL');
    const [selectedEventIndex, setSelectedEventIndex] = useState<number | null>(null);

    const eventTypes = Array.from(new Set(events.map(e => e.type)));

    const filtered = events.filter(e => (filterType === 'ALL' ? true : e.type === filterType));

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-2">
                <div className="flex items-center gap-1.5 overflow-x-auto text-xs scrollbar-none">
                    <button
                        onClick={() => setFilterType('ALL')}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                            filterType === 'ALL'
                                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                                : 'text-slate-400 hover:text-slate-200'
                        }`}
                    >
                        All Events ({events.length})
                    </button>
                    {eventTypes.map(t => (
                        <button
                            key={t}
                            onClick={() => setFilterType(t)}
                            className={`px-2 py-1 rounded-md text-[11px] font-mono transition-colors ${
                                filterType === t
                                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                                    : 'text-slate-400 hover:text-slate-200'
                            }`}
                        >
                            {t}
                        </button>
                    ))}
                </div>
            </div>

            {filtered.length === 0 ? (
                <EmptyState
                    icon={Terminal}
                    title="No Telemetry Events"
                    description="Execution events will stream in chronologically as they happen."
                />
            ) : (
                <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1 font-mono text-xs">
                    {filtered.map((ev, idx) => (
                        <EventRow
                            key={idx}
                            event={ev}
                            isSelected={selectedEventIndex === idx}
                            onToggle={() => setSelectedEventIndex(selectedEventIndex === idx ? null : idx)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};
