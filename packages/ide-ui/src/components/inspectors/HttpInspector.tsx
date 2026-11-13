import React, { useState } from 'react';
import type { HttpEcosystemConfig, HttpTelemetryRecord, EcosystemInspectionData } from '@siglo/ide-protocol';
import { formatOriginCurl } from '@siglo/ide-protocol';
import { Globe, Copy, Check, Clock, RefreshCw, AlertCircle } from 'lucide-react';

interface HttpInspectorProps {
    config?: HttpEcosystemConfig;
    telemetry?: (EcosystemInspectionData & HttpTelemetryRecord) | null;
}

export const HttpInspector: React.FC<HttpInspectorProps> = ({ config, telemetry }) => {
    const [copied, setCopied] = useState(false);

    const method = telemetry?.method || config?.method || 'GET';
    const rawUrl = telemetry?.url || config?.url;
    const isDynamic = config?.isDynamicUrl;
    const curlCommand = formatOriginCurl(method, rawUrl);

    const handleCopyCurl = async () => {
        try {
            await navigator.clipboard.writeText(curlCommand);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard fallback
            const ta = document.createElement('textarea');
            ta.value = curlCommand;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const getStatusBadge = (status?: number) => {
        if (!status) return null;
        if (status >= 200 && status < 300) {
            return (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950/80 text-emerald-400 border border-emerald-800/60">
                    {status} OK
                </span>
            );
        }
        if (status >= 400 && status < 500) {
            return (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950/80 text-amber-400 border border-amber-800/60">
                    {status} Client Error
                </span>
            );
        }
        return (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-950/80 text-rose-400 border border-rose-800/60">
                {status} Error
            </span>
        );
    };

    return (
        <div className="space-y-4">
            {/* Header / Configured Endpoint */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <h4 className="text-[11px] font-semibold uppercase text-[#6f737d] tracking-wider flex items-center gap-1.5">
                        <Globe className="w-3.5 h-3.5 text-sky-400" />
                        HTTP Endpoint
                    </h4>
                    <span className="font-mono text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-sky-950/70 text-sky-300 border border-sky-800/50">
                        {method}
                    </span>
                </div>

                <div className="bg-[#1e1f22] rounded p-2.5 space-y-2 text-[11px]">
                    <div className="flex flex-col gap-1">
                        <span className="text-[#868a98] text-[10px] uppercase font-medium">Origin URL:</span>
                        <div className="flex items-center justify-between gap-2 font-mono text-[11px] bg-[#25262a] px-2 py-1.5 rounded border border-[#393b40]">
                            <span className="text-[#dfe1e5] truncate" title={rawUrl || 'Unavailable'}>
                                {rawUrl || <span className="text-[#868a98] italic">Unavailable</span>}
                            </span>
                            {isDynamic && (
                                <span className="shrink-0 text-[9px] px-1 py-0.5 rounded bg-amber-950/80 text-amber-300 border border-amber-800/60">
                                    Dynamic
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Copy Origin cURL button */}
                    <button
                        onClick={handleCopyCurl}
                        className="w-full flex items-center justify-center gap-1.5 py-1 px-2.5 rounded bg-[#2b2d30] hover:bg-[#393b40] text-[#dfe1e5] border border-[#393b40] transition-colors text-[11px]"
                        title={curlCommand}
                    >
                        {copied ? (
                            <>
                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                                <span className="text-emerald-400 font-medium">Copied origin cURL!</span>
                            </>
                        ) : (
                            <>
                                <Copy className="w-3.5 h-3.5 text-[#868a98]" />
                                <span>Copy Origin cURL</span>
                            </>
                        )}
                    </button>
                </div>
            </div>

            {/* Static Retry Policy */}
            <div>
                <h4 className="text-[11px] font-semibold uppercase text-[#6f737d] tracking-wider mb-2 flex items-center gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5 text-amber-400" />
                    Retry & Timeout Policy
                </h4>
                <div className="bg-[#1e1f22] rounded p-2.5 space-y-1.5 text-[11px]">
                    <div className="flex items-center justify-between">
                        <span className="text-[#868a98]">Max Retries:</span>
                        <span className="font-mono font-medium text-[#dfe1e5]">
                            {config?.maxRetries !== undefined ? String(config.maxRetries) : 'None'}
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-[#868a98]">Retry On Status:</span>
                        <span className="font-mono text-[#dfe1e5]">
                            {config?.retryOnStatus ? (
                                Array.isArray(config.retryOnStatus) ? (
                                    config.retryOnStatus.join(', ')
                                ) : (
                                    String(config.retryOnStatus)
                                )
                            ) : (
                                <span className="text-[#868a98] italic">Default (5xx, 429)</span>
                            )}
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-[#868a98]">Timeout:</span>
                        <span className="font-mono text-[#dfe1e5]">
                            {config?.timeoutMs !== undefined ? (
                                `${config.timeoutMs}ms`
                            ) : (
                                <span className="text-[#868a98] italic">Default</span>
                            )}
                        </span>
                    </div>
                    {config?.allowNotFound !== undefined && (
                        <div className="flex items-center justify-between">
                            <span className="text-[#868a98]">Allow 404 (Not Found):</span>
                            <span className="font-mono text-[#dfe1e5]">{String(config.allowNotFound)}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Recorded Telemetry Execution Section */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <h4 className="text-[11px] font-semibold uppercase text-[#6f737d] tracking-wider flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-emerald-400" />
                        Recorded Run
                    </h4>
                    {telemetry ? (
                        getStatusBadge(telemetry.status)
                    ) : (
                        <span className="text-[10px] text-[#868a98] italic">No recording loaded</span>
                    )}
                </div>

                <div className="bg-[#1e1f22] rounded p-2.5 space-y-2 text-[11px]">
                    {telemetry ? (
                        <>
                            <div className="flex items-center justify-between">
                                <span className="text-[#868a98]">Outcome:</span>
                                <span
                                    className={`font-mono font-semibold uppercase text-[10px] px-1.5 py-0.5 rounded ${
                                        telemetry.outcome === 'success'
                                            ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/60'
                                            : 'bg-rose-950/80 text-rose-400 border border-rose-800/60'
                                    }`}
                                >
                                    {telemetry.outcome}
                                </span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-[#868a98]">Duration:</span>
                                <span className="font-mono text-[#dfe1e5]">
                                    {telemetry.durationMs !== undefined ? (
                                        `${telemetry.durationMs}ms`
                                    ) : (
                                        <span className="text-[#868a98] italic">Unavailable</span>
                                    )}
                                </span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-[#868a98]">Request Attempt:</span>
                                <span className="font-mono text-[#dfe1e5]">{telemetry.requestAttempt ?? 1}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-[#868a98]">Retries Observed:</span>
                                <span className="font-mono text-[#dfe1e5]">{telemetry.retryAttempts ?? 0}</span>
                            </div>
                            {telemetry.retryDelayMs !== undefined && (
                                <div className="flex items-center justify-between">
                                    <span className="text-[#868a98]">Retry Delay:</span>
                                    <span className="font-mono text-[#dfe1e5]">
                                        {telemetry.retryDelayMs}ms ({telemetry.retryDelaySource || 'backoff'})
                                    </span>
                                </div>
                            )}
                            {telemetry.retryAfterMs !== undefined && (
                                <div className="flex items-center justify-between">
                                    <span className="text-[#868a98]">Retry-After Header:</span>
                                    <span className="font-mono text-[#dfe1e5]">{telemetry.retryAfterMs}ms</span>
                                </div>
                            )}
                            {telemetry.policy && (
                                <div className="flex items-center justify-between">
                                    <span className="text-[#868a98]">Network Policy:</span>
                                    <span className="font-mono capitalize text-[#dfe1e5]">{telemetry.policy}</span>
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="space-y-1.5 text-[#868a98]">
                            <div className="flex items-center justify-between">
                                <span>Status / Outcome:</span>
                                <span className="font-mono italic text-[#6f737d]">Unavailable</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span>Duration:</span>
                                <span className="font-mono italic text-[#6f737d]">Unavailable</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span>Observed Retries:</span>
                                <span className="font-mono italic text-[#6f737d]">Unavailable</span>
                            </div>
                            <div className="mt-1 pt-1 border-t border-[#2b2d30] text-[10px] text-[#6f737d] flex items-center gap-1">
                                <AlertCircle className="w-3 h-3 text-[#6f737d]" />
                                Load an offline telemetry recording to view execution details.
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
