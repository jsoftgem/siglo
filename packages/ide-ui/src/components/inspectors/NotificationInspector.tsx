import React from 'react';
import type { NotificationEcosystemConfig, NotificationTelemetryRecord, EcosystemInspectionData } from '@siglo/ide-protocol';
import { Bell, CheckSquare, Clock, Mail, MessageSquare, AlertCircle, ShieldCheck } from 'lucide-react';

interface NotificationInspectorProps {
    config?: NotificationEcosystemConfig;
    telemetry?: (EcosystemInspectionData & NotificationTelemetryRecord) | null;
}

export const NotificationInspector: React.FC<NotificationInspectorProps> = ({ config, telemetry }) => {
    const channel = telemetry?.channel || config?.channel || 'notification';
    const isApproval = telemetry?.approval ?? config?.isApproval ?? false;
    const approvalExpires = config?.approvalExpiresIn !== undefined ? String(config.approvalExpiresIn) : 'Default';
    const subject = config?.subject || 'Dynamic';
    const template = config?.template;

    const renderApprovalBadge = (state?: NotificationTelemetryRecord['approvalState']) => {
        if (!state) return <span className="text-[#868a98] italic">Unavailable</span>;

        switch (state) {
            case 'approved':
                return (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950/80 text-emerald-400 border border-emerald-800/60">
                        Approved
                    </span>
                );
            case 'requested':
                return (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-sky-950/80 text-sky-400 border border-sky-800/60">
                        Pending Approval
                    </span>
                );
            case 'rejected':
            case 'forbidden':
            case 'cancelled':
            case 'failed':
                return (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-950/80 text-rose-400 border border-rose-800/60">
                        {state}
                    </span>
                );
            case 'expired':
                return (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950/80 text-amber-400 border border-amber-800/60">
                        Expired
                    </span>
                );
            default:
                return (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-[#393b40] text-[#dfe1e5]">
                        {state}
                    </span>
                );
        }
    };

    const getChannelIcon = (ch: string) => {
        const c = ch.toLowerCase();
        if (c.includes('email') || c.includes('mail')) return <Mail className="w-3.5 h-3.5 text-sky-400" />;
        if (c.includes('slack') || c.includes('discord') || c.includes('chat')) return <MessageSquare className="w-3.5 h-3.5 text-emerald-400" />;
        return <Bell className="w-3.5 h-3.5 text-amber-400" />;
    };

    return (
        <div className="space-y-4">
            {/* Notification Configuration */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <h4 className="text-[11px] font-semibold uppercase text-[#6f737d] tracking-wider flex items-center gap-1.5">
                        {getChannelIcon(channel)}
                        Notification Config
                    </h4>
                    <span className="font-mono text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-[#393b40] text-[#dfe1e5]">
                        {channel}
                    </span>
                </div>

                <div className="bg-[#1e1f22] rounded p-2.5 space-y-1.5 text-[11px]">
                    <div className="flex items-center justify-between">
                        <span className="text-[#868a98]">Type:</span>
                        <span className="font-medium text-[#dfe1e5]">
                            {isApproval ? 'Interactive Approval' : 'Broadcast / Dispatch'}
                        </span>
                    </div>
                    {isApproval && (
                        <div className="flex items-center justify-between">
                            <span className="text-[#868a98]">Approval Expiration:</span>
                            <span className="font-mono text-[#dfe1e5]">{approvalExpires}</span>
                        </div>
                    )}
                    <div className="flex items-center justify-between">
                        <span className="text-[#868a98]">Subject:</span>
                        <span className="font-mono text-[#dfe1e5] truncate max-w-[150px]">{subject}</span>
                    </div>
                    {template && (
                        <div className="flex items-center justify-between">
                            <span className="text-[#868a98]">Template ID:</span>
                            <span className="font-mono text-[#dfe1e5]">{template}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Recorded Telemetry Execution Section */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <h4 className="text-[11px] font-semibold uppercase text-[#6f737d] tracking-wider flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-emerald-400" />
                        Recorded Delivery
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
                            {isApproval && (
                                <div className="flex items-center justify-between">
                                    <span className="text-[#868a98]">Approval State:</span>
                                    {renderApprovalBadge(telemetry.approvalState)}
                                </div>
                            )}
                            {telemetry.tokenStatus && (
                                <div className="flex items-center justify-between">
                                    <span className="text-[#868a98]">Token Status:</span>
                                    <span className="font-mono capitalize text-[#dfe1e5]">{telemetry.tokenStatus}</span>
                                </div>
                            )}
                            {telemetry.notificationId && (
                                <div className="flex items-center justify-between">
                                    <span className="text-[#868a98]">Notification ID:</span>
                                    <span className="font-mono text-[10px] text-[#a8adbb] truncate max-w-[140px]">
                                        {telemetry.notificationId}
                                    </span>
                                </div>
                            )}
                            <div className="flex items-center justify-between">
                                <span className="text-[#868a98]">Delivery Latency:</span>
                                <span className="font-mono text-[#dfe1e5]">
                                    {telemetry.durationMs !== undefined ? `${telemetry.durationMs}ms` : 'Unavailable'}
                                </span>
                            </div>

                            {/* Sandboxed & Redacted Content Preview */}
                            {telemetry.contentPreview && (
                                <div className="mt-2 pt-2 border-t border-[#2b2d30] space-y-1.5">
                                    <div className="text-[10px] font-semibold uppercase text-[#6f737d]">
                                        Sandboxed Preview (Sanitized)
                                    </div>
                                    {telemetry.contentPreview.recipientMasked && (
                                        <div className="flex items-center justify-between font-mono text-[10px]">
                                            <span className="text-[#868a98]">Recipient:</span>
                                            <span className="text-[#dfe1e5]">{telemetry.contentPreview.recipientMasked}</span>
                                        </div>
                                    )}
                                    {telemetry.contentPreview.subject && (
                                        <div className="flex items-center justify-between font-mono text-[10px]">
                                            <span className="text-[#868a98]">Subject:</span>
                                            <span className="text-[#dfe1e5] truncate max-w-[150px]">{telemetry.contentPreview.subject}</span>
                                        </div>
                                    )}
                                    {telemetry.contentPreview.bodySnippet && (
                                        <div className="bg-[#25262a] border border-[#393b40] rounded p-2 text-[10px] font-mono text-[#a8adbb] break-words">
                                            {telemetry.contentPreview.bodySnippet}
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="space-y-1.5 text-[#868a98]">
                            <div className="flex items-center justify-between">
                                <span>Delivery Outcome:</span>
                                <span className="font-mono italic text-[#6f737d]">Unavailable</span>
                            </div>
                            {isApproval && (
                                <div className="flex items-center justify-between">
                                    <span>Approval State:</span>
                                    <span className="font-mono italic text-[#6f737d]">Unavailable</span>
                                </div>
                            )}
                            <div className="flex items-center justify-between">
                                <span>Preview Content:</span>
                                <span className="font-mono italic text-[#6f737d]">Unavailable</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span>Delivery Latency:</span>
                                <span className="font-mono italic text-[#6f737d]">Unavailable</span>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
