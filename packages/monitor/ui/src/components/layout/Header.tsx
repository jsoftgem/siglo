import React, { useState, useEffect, useRef, useCallback } from 'react';
import { RefreshCw, BarChart3, Wifi, WifiOff, ChevronDown } from 'lucide-react';
import sigloLogo from '../../assets/siglo-logo-128.png';

export interface AutoRefreshOption {
    label: string;
    value: number; // Interval in milliseconds, 0 represents Off
}

export const AUTO_REFRESH_OPTIONS: AutoRefreshOption[] = [
    { label: 'Off', value: 0 },
    { label: '5s', value: 5000 },
    { label: '10s', value: 10000 },
    { label: '30s', value: 30000 },
    { label: '1m', value: 60000 },
    { label: '5m', value: 300000 },
];

export interface HeaderProps {
    namespaces: string[];
    selectedNamespace: string;
    onSelectNamespace: (ns: string) => void;
    isConnected: boolean;
    onRefresh: () => void | Promise<void>;
    totalRuns: number;
    autoRefreshInterval?: number;
    onAutoRefreshChange?: (interval: number) => void;
}

export const Header: React.FC<HeaderProps> = ({
    namespaces,
    selectedNamespace,
    onSelectNamespace,
    isConnected,
    onRefresh,
    totalRuns,
    autoRefreshInterval,
    onAutoRefreshChange,
}) => {
    const [internalInterval, setInternalInterval] = useState<number>(0);
    const [isSpinning, setIsSpinning] = useState<boolean>(false);
    const spinTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const selectedInterval = autoRefreshInterval !== undefined ? autoRefreshInterval : internalInterval;

    const onRefreshRef = useRef(onRefresh);
    useEffect(() => {
        onRefreshRef.current = onRefresh;
    }, [onRefresh]);

    useEffect(() => {
        return () => {
            if (spinTimeoutRef.current) {
                clearTimeout(spinTimeoutRef.current);
            }
        };
    }, []);

    const triggerRefresh = useCallback(async () => {
        setIsSpinning(true);
        try {
            await Promise.resolve(onRefreshRef.current());
        } catch (err) {
            console.error('Failed to refresh workflows:', err);
        } finally {
            if (spinTimeoutRef.current) {
                clearTimeout(spinTimeoutRef.current);
            }
            spinTimeoutRef.current = setTimeout(() => {
                setIsSpinning(false);
            }, 500);
        }
    }, []);

    const handleIntervalChange = (newInterval: number) => {
        if (autoRefreshInterval === undefined) {
            setInternalInterval(newInterval);
        }
        onAutoRefreshChange?.(newInterval);
    };

    useEffect(() => {
        if (selectedInterval <= 0) return;

        const timer = setInterval(() => {
            triggerRefresh();
        }, selectedInterval);

        return () => clearInterval(timer);
    }, [selectedInterval, triggerRefresh]);

    return (
        <header className="h-14 border-b border-slate-800 bg-slate-900/90 backdrop-blur px-5 flex items-center justify-between z-20 shrink-0">
            <div className="flex items-center gap-3">
                <img
                    src={sigloLogo}
                    alt="Siglo"
                    className="w-8 h-8 rounded-lg object-cover ring-1 ring-sky-500/30 shadow-md shadow-sky-500/20"
                />
                <div>
                    <div className="flex items-center gap-2">
                        <span className="font-bold text-base tracking-tight text-white">Siglo Live Monitor</span>
                        <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                            DevTools
                        </span>
                    </div>
                </div>
            </div>

            <div className="flex items-center gap-4">
                {/* Namespace Filter */}
                <div className="flex items-center gap-2">
                    <label className="text-xs text-slate-400 font-medium hidden sm:inline">Namespace:</label>
                    <div className="relative flex items-center">
                        <select
                            value={selectedNamespace}
                            onChange={e => onSelectNamespace(e.target.value)}
                            className="appearance-none bg-slate-950 border border-slate-700/80 rounded-lg pl-2.5 pr-8 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500 transition-colors cursor-pointer"
                        >
                            <option value="">All Namespaces</option>
                            {namespaces.map(ns => (
                                <option key={ns} value={ns}>
                                    {ns}
                                </option>
                            ))}
                        </select>
                        <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 pointer-events-none" />
                    </div>
                </div>

                {/* SSE Connection Status */}
                <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-slate-950 border border-slate-800 text-xs">
                    <span className="relative flex h-2 w-2">
                        {isConnected ? (
                            <>
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                            </>
                        ) : (
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
                        )}
                    </span>
                    <span className="text-slate-300 font-medium text-[11px] hidden sm:inline">
                        {isConnected ? 'SSE Live' : 'Offline'}
                    </span>
                    {isConnected ? (
                        <Wifi className="w-3 h-3 text-emerald-400" />
                    ) : (
                        <WifiOff className="w-3 h-3 text-rose-400" />
                    )}
                </div>

                {/* Prometheus Metrics Link */}
                <a
                    href="/metrics"
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition-colors flex items-center gap-1.5"
                    title="Open Prometheus Metrics"
                >
                    <BarChart3 className="w-4 h-4" />
                    <span className="hidden md:inline">Metrics</span>
                </a>

                {/* Auto Refresh Interval */}
                <div className="flex items-center gap-2">
                    <label className="text-xs text-slate-400 font-medium hidden sm:inline">Auto Refresh:</label>
                    <div className="relative flex items-center">
                        <select
                            value={selectedInterval}
                            onChange={e => handleIntervalChange(Number(e.target.value))}
                            aria-label="Auto refresh interval"
                            title="Auto refresh interval"
                            className={`appearance-none bg-slate-950 border rounded-lg pl-2.5 pr-8 py-1 text-xs transition-colors cursor-pointer focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500 ${
                                selectedInterval > 0
                                    ? 'border-sky-500/60 text-sky-400 font-medium'
                                    : 'border-slate-700/80 text-slate-200'
                            }`}
                        >
                            {AUTO_REFRESH_OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value} className="bg-slate-950 text-slate-200">
                                    {opt.label}
                                </option>
                            ))}
                        </select>
                        <ChevronDown
                            className={`w-3.5 h-3.5 absolute right-2.5 pointer-events-none transition-colors ${
                                selectedInterval > 0 ? 'text-sky-400' : 'text-slate-400'
                            }`}
                        />
                    </div>
                </div>

                {/* Manual Refresh */}
                <button
                    onClick={triggerRefresh}
                    className="text-slate-400 hover:text-slate-100 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
                    title="Refresh Workflows"
                    aria-label="Refresh workflows"
                >
                    <RefreshCw className={`w-4 h-4 ${isSpinning ? 'animate-spin text-sky-400' : ''}`} />
                </button>
            </div>
        </header>
    );
};
