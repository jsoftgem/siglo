import React from 'react';
import type { CryptoEcosystemConfig, CryptoTelemetryRecord, EcosystemInspectionData } from '@siglo/ide-protocol';
import { KeyRound, Shield, CheckCircle, XCircle, AlertTriangle, Lock } from 'lucide-react';

interface CryptoInspectorProps {
    config?: CryptoEcosystemConfig;
    telemetry?: (EcosystemInspectionData & CryptoTelemetryRecord) | null;
}

export const CryptoInspector: React.FC<CryptoInspectorProps> = ({ config, telemetry }) => {
    const operation = config?.operation || 'verifyWebhook';
    const provider = telemetry?.provider || config?.provider || 'generic';
    const algorithm = config?.algorithm || 'HMAC-SHA256';
    const tolerance = config?.toleranceSeconds !== undefined ? `${config.toleranceSeconds}s` : 'Default (300s)';
    const fields = config?.fields;

    const renderCategoryBadge = (category?: CryptoTelemetryRecord['category']) => {
        if (!category) return <span className="text-[#868a98] italic">Unavailable</span>;

        switch (category) {
            case 'verified':
                return (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950/80 text-emerald-400 border border-emerald-800/60 flex items-center gap-1">
                        <CheckCircle className="w-3 h-3 text-emerald-400" />
                        Verified
                    </span>
                );
            case 'timestamp-rejected':
                return (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950/80 text-amber-400 border border-amber-800/60 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3 text-amber-400" />
                        Timestamp Rejected
                    </span>
                );
            case 'replay-detected':
                return (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-950/80 text-rose-400 border border-rose-800/60 flex items-center gap-1">
                        <XCircle className="w-3 h-3 text-rose-400" />
                        Replay Detected
                    </span>
                );
            case 'invalid-payload':
            case 'payload-too-large':
                return (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950/80 text-amber-400 border border-amber-800/60 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3 text-amber-400" />
                        {category}
                    </span>
                );
            default:
                return (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-950/80 text-rose-400 border border-rose-800/60 flex items-center gap-1">
                        <XCircle className="w-3 h-3 text-rose-400" />
                        {category}
                    </span>
                );
        }
    };

    const renderCheckStatus = (check?: 'passed' | 'failed' | 'unavailable') => {
        if (!check || check === 'unavailable') {
            return <span className="font-mono text-[#868a98] italic text-[10px]">Unavailable</span>;
        }
        if (check === 'passed') {
            return (
                <span className="font-mono text-emerald-400 text-[10px] flex items-center gap-1">
                    <CheckCircle className="w-3 h-3" />
                    Passed
                </span>
            );
        }
        return (
            <span className="font-mono text-rose-400 text-[10px] flex items-center gap-1">
                <XCircle className="w-3 h-3" />
                Failed
            </span>
        );
    };

    return (
        <div className="space-y-4">
            {/* Configured Crypto Operation */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <h4 className="text-[11px] font-semibold uppercase text-[#6f737d] tracking-wider flex items-center gap-1.5">
                        <KeyRound className="w-3.5 h-3.5 text-purple-400" />
                        Crypto Specification
                    </h4>
                    <span className="font-mono text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-purple-950/70 text-purple-300 border border-purple-800/50">
                        {operation}
                    </span>
                </div>

                <div className="bg-[#1e1f22] rounded p-2.5 space-y-1.5 text-[11px]">
                    <div className="flex items-center justify-between">
                        <span className="text-[#868a98]">Provider:</span>
                        <span className="font-mono font-medium text-[#dfe1e5] capitalize">{provider}</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-[#868a98]">Algorithm:</span>
                        <span className="font-mono text-[#dfe1e5]">{algorithm}</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-[#868a98]">Tolerance Window:</span>
                        <span className="font-mono text-[#dfe1e5]">{tolerance}</span>
                    </div>
                    {fields && (
                        <div className="flex flex-col gap-1 pt-1 border-t border-[#2b2d30]">
                            <span className="text-[#868a98] text-[10px] uppercase">Protected Fields:</span>
                            <div className="font-mono text-[10px] text-[#a8adbb] bg-[#25262a] p-1.5 rounded border border-[#393b40]">
                                {Array.isArray(fields) ? fields.join(', ') : String(fields)}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Zero-Leakage Guarantee Badge */}
            <div className="flex items-center gap-2 p-2 rounded bg-purple-950/30 border border-purple-900/40 text-[10px] text-purple-300">
                <Lock className="w-3.5 h-3.5 shrink-0 text-purple-400" />
                <span>Zero-Leakage: Raw signatures, secrets, and private keys are never captured or rendered.</span>
            </div>

            {/* Recorded Telemetry Execution Section */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <h4 className="text-[11px] font-semibold uppercase text-[#6f737d] tracking-wider flex items-center gap-1.5">
                        <Shield className="w-3.5 h-3.5 text-emerald-400" />
                        Recorded Verification
                    </h4>
                    {telemetry ? (
                        renderCategoryBadge(telemetry.category)
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
                                <span className="text-[#868a98]">Timestamp Check:</span>
                                {renderCheckStatus(telemetry.timestampCheck)}
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-[#868a98]">Replay Check:</span>
                                {renderCheckStatus(telemetry.replayCheck)}
                            </div>
                            {telemetry.payloadBytes !== undefined && (
                                <div className="flex items-center justify-between">
                                    <span className="text-[#868a98]">Payload Size:</span>
                                    <span className="font-mono text-[#dfe1e5]">{telemetry.payloadBytes} bytes</span>
                                </div>
                            )}
                            <div className="flex items-center justify-between">
                                <span className="text-[#868a98]">Execution Duration:</span>
                                <span className="font-mono text-[#dfe1e5]">
                                    {telemetry.durationMs !== undefined ? `${telemetry.durationMs}ms` : 'Unavailable'}
                                </span>
                            </div>
                        </>
                    ) : (
                        <div className="space-y-1.5 text-[#868a98]">
                            <div className="flex items-center justify-between">
                                <span>Verification Category:</span>
                                <span className="font-mono italic text-[#6f737d]">Unavailable</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span>Timestamp Verification:</span>
                                <span className="font-mono italic text-[#6f737d]">Unavailable</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span>Replay Protection:</span>
                                <span className="font-mono italic text-[#6f737d]">Unavailable</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span>Duration:</span>
                                <span className="font-mono italic text-[#6f737d]">Unavailable</span>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
