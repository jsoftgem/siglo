import React, { useState } from 'react';
import { ContextDiff } from '../../../types';
import { useClipboard } from '../../../hooks/useClipboard';
import { formatJson, formatTime } from '../../../utils/formatters';
import { Copy, Check } from 'lucide-react';

interface ContextViewerProps {
    context: Record<string, any>;
    diffs?: ContextDiff[];
}

export const ContextViewer: React.FC<ContextViewerProps> = ({ context, diffs = [] }) => {
    const [tab, setTab] = useState<'current' | 'diffs'>('current');
    const { copied, copy } = useClipboard();

    const jsonString = formatJson(context || {});

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-2">
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setTab('current')}
                        className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                            tab === 'current'
                                ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                                : 'text-slate-400 hover:text-slate-200'
                        }`}
                    >
                        Current State ({Object.keys(context || {}).length} keys)
                    </button>
                    {diffs.length > 0 && (
                        <button
                            onClick={() => setTab('diffs')}
                            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                                tab === 'diffs'
                                    ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                                    : 'text-slate-400 hover:text-slate-200'
                            }`}
                        >
                            Mutations ({diffs.length})
                        </button>
                    )}
                </div>

                <button
                    onClick={() => copy(jsonString)}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200 bg-slate-900 border border-slate-800 rounded-lg hover:bg-slate-800 transition-colors"
                >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? 'Copied!' : 'Copy JSON'}</span>
                </button>
            </div>

            {tab === 'current' ? (
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 overflow-hidden">
                    <pre className="font-mono text-xs text-sky-300 overflow-x-auto max-h-96 leading-relaxed">
                        {jsonString}
                    </pre>
                </div>
            ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                    {diffs.map((diff, i) => (
                        <div
                            key={i}
                            className="p-3 bg-slate-950 border border-slate-800/80 rounded-lg text-xs font-mono space-y-1"
                        >
                            <div className="flex items-center justify-between text-slate-400 text-[11px]">
                                <span className="text-amber-400 font-semibold">{diff.field}</span>
                                <span>{formatTime(diff.timestamp)}</span>
                            </div>
                            <pre className="text-slate-300 text-[11px] overflow-x-auto">{formatJson(diff.value)}</pre>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};
