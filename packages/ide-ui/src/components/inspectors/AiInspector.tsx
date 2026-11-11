import React from 'react';
import type { AiEcosystemConfig, AiTelemetryRecord, EcosystemInspectionData } from '@siglo/ide-protocol';
import { Sparkles, Brain, Cpu, DollarSign, Layers, Wrench, ShieldCheck, Clock } from 'lucide-react';

interface AiInspectorProps {
    config?: AiEcosystemConfig;
    telemetry?: (EcosystemInspectionData & AiTelemetryRecord) | null;
}

export const AiInspector: React.FC<AiInspectorProps> = ({ config, telemetry }) => {
    const provider = telemetry?.provider || config?.provider || 'generic';
    const model = telemetry?.model || config?.model || 'gpt-4o';
    const maxRepair = config?.maxRepairAttempts !== undefined ? String(config.maxRepairAttempts) : 'None';
    const fallbacks = config?.fallbackModels;
    const temp = config?.temperature !== undefined ? String(config.temperature) : 'Default';
    const maxTokens = config?.maxTokens !== undefined ? String(config.maxTokens) : 'Default';

    const formatCost = (cost?: number) => {
        if (cost === undefined || isNaN(cost)) return <span className="text-[#868a98] italic">Unavailable</span>;
        return `$${cost.toFixed(4)}`;
    };

    return (
        <div className="space-y-4">
            {/* AI Model Configuration */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <h4 className="text-[11px] font-semibold uppercase text-[#6f737d] tracking-wider flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                        AI Model Specification
                    </h4>
                    <span className="font-mono text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-indigo-950/70 text-indigo-300 border border-indigo-800/50">
                        {provider}
                    </span>
                </div>

                <div className="bg-[#1e1f22] rounded p-2.5 space-y-1.5 text-[11px]">
                    <div className="flex items-center justify-between">
                        <span className="text-[#868a98]">Model:</span>
                        <span className="font-mono font-medium text-[#dfe1e5]">{model}</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-[#868a98]">Max Self-Repair:</span>
                        <span className="font-mono text-[#dfe1e5]">{maxRepair}</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-[#868a98]">Temperature:</span>
                        <span className="font-mono text-[#dfe1e5]">{temp}</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-[#868a98]">Max Tokens:</span>
                        <span className="font-mono text-[#dfe1e5]">{maxTokens}</span>
                    </div>
                    {fallbacks && (
                        <div className="flex flex-col gap-1 pt-1 border-t border-[#2b2d30]">
                            <span className="text-[#868a98] text-[10px] uppercase">Fallback Models:</span>
                            <div className="font-mono text-[10px] text-[#a8adbb] bg-[#25262a] p-1.5 rounded border border-[#393b40]">
                                {Array.isArray(fallbacks) ? fallbacks.join(', ') : String(fallbacks)}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Recorded Telemetry Execution Section */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <h4 className="text-[11px] font-semibold uppercase text-[#6f737d] tracking-wider flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-emerald-400" />
                        Recorded Inference
                    </h4>
                    {telemetry ? (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                            telemetry.outcome === 'success' ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/60' : 'bg-rose-950/80 text-rose-400 border border-rose-800/60'
                        }`}>
                            {telemetry.outcome}
                        </span>
                    ) : (
                        <span className="text-[10px] text-[#868a98] italic">No recording loaded</span>
                    )}
                </div>

                <div className="bg-[#1e1f22] rounded p-2.5 space-y-2 text-[11px]">
                    {telemetry ? (
                        <>
                            <div className="flex items-center justify-between">
                                <span className="text-[#868a98]">Inference Phase:</span>
                                <span className="font-mono capitalize text-[#dfe1e5]">{telemetry.phase || 'completion'}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-[#868a98]">Latency:</span>
                                <span className="font-mono text-[#dfe1e5]">
                                    {telemetry.durationMs !== undefined ? `${telemetry.durationMs}ms` : 'Unavailable'}
                                </span>
                            </div>

                            {/* Token Metrics */}
                            <div className="p-2 rounded bg-[#25262a] border border-[#393b40] space-y-1">
                                <div className="text-[10px] font-semibold uppercase text-[#6f737d] mb-1">
                                    Token Consumption
                                </div>
                                <div className="flex items-center justify-between font-mono text-[11px]">
                                    <span className="text-[#868a98]">Prompt:</span>
                                    <span className="text-[#dfe1e5]">{telemetry.promptTokens ?? 'Unavailable'}</span>
                                </div>
                                <div className="flex items-center justify-between font-mono text-[11px]">
                                    <span className="text-[#868a98]">Completion:</span>
                                    <span className="text-[#dfe1e5]">{telemetry.completionTokens ?? 'Unavailable'}</span>
                                </div>
                                <div className="flex items-center justify-between font-mono text-[11px] pt-1 border-t border-[#393b40]">
                                    <span className="text-[#868a98] font-semibold">Total Tokens:</span>
                                    <span className="text-emerald-400 font-semibold">{telemetry.totalTokens ?? 'Unavailable'}</span>
                                </div>
                            </div>

                            <div className="flex items-center justify-between">
                                <span className="text-[#868a98]">Estimated Cost:</span>
                                <span className="font-mono font-medium text-[#dfe1e5]">
                                    {formatCost(telemetry.estimatedCostUsd)}
                                </span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-[#868a98]">Self-Repair Attempts:</span>
                                <span className="font-mono text-[#dfe1e5]">
                                    {telemetry.repairAttempts ?? 0}
                                </span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-[#868a98]">Fallback Activations:</span>
                                <span className="font-mono text-[#dfe1e5]">
                                    {telemetry.fallbackCount ?? 0}
                                </span>
                            </div>
                        </>
                    ) : (
                        <div className="space-y-1.5 text-[#868a98]">
                            <div className="flex items-center justify-between">
                                <span>Inference Outcome:</span>
                                <span className="font-mono italic text-[#6f737d]">Unavailable</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span>Token Usage (Prompt / Completion):</span>
                                <span className="font-mono italic text-[#6f737d]">Unavailable</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span>Estimated Cost:</span>
                                <span className="font-mono italic text-[#6f737d]">Unavailable</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span>Repairs & Fallbacks:</span>
                                <span className="font-mono italic text-[#6f737d]">Unavailable</span>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
