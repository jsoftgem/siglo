import React from 'react';
import { RefreshCw, BarChart3, Wifi, WifiOff } from 'lucide-react';
import sigloLogo from '../../assets/siglo-logo-128.jpg';

interface HeaderProps {
  namespaces: string[];
  selectedNamespace: string;
  onSelectNamespace: (ns: string) => void;
  isConnected: boolean;
  onRefresh: () => void;
  totalRuns: number;
}

export const Header: React.FC<HeaderProps> = ({
  namespaces,
  selectedNamespace,
  onSelectNamespace,
  isConnected,
  onRefresh,
  totalRuns
}) => {
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
          <select
            value={selectedNamespace}
            onChange={(e) => onSelectNamespace(e.target.value)}
            className="bg-slate-950 border border-slate-700/80 rounded-lg px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500 transition-colors"
          >
            <option value="">All Namespaces</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
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

        {/* Manual Refresh */}
        <button
          onClick={onRefresh}
          className="text-slate-400 hover:text-slate-100 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
          title="Refresh Workflows"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
