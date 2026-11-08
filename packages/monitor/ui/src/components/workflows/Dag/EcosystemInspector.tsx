import { InspectionContent } from './InspectionContent';
import * as React from 'react';
import { sanitizedCurl } from './curl';
import type { EcosystemInspection } from '@siglo/core';
import type { StepRun } from '../../../types';

function Fields({ values }: { values: Record<string, unknown> }) {
    return (
        <dl className="grid grid-cols-2 gap-2">
            {Object.entries(values).map(([key, value]) => (
                <div key={key}>
                    <dt className="text-slate-500">{key}</dt>
                    <dd className="break-all text-slate-200">{value === undefined ? 'Unavailable' : String(value)}</dd>
                </div>
            ))}
        </dl>
    );
}

export function InspectionDetails({ data }: { data: EcosystemInspection }) {
    switch (data.kind) {
        case 'http':
            return (
                <>
                    <Fields
                        values={{
                            Method: data.method,
                            'URL origin (path/query omitted)': data.url,
                            Status: data.status,
                            'Duration (ms)': data.durationMs,
                            'Request attempt': data.requestAttempt,
                            'Retry delay (ms)': data.retryDelayMs,
                            'Retry delay source': data.retryDelaySource,
                            'Retry-After (ms)': data.retryAfterMs,
                            Retries: data.retryAttempts,
                            Trace: data.traceId,
                            Policy: data.policy,
                        }}
                    />
                    {sanitizedCurl(data) && (
                        <button
                            className="mt-2 text-sky-400"
                            onClick={() => {
                                void navigator.clipboard.writeText(sanitizedCurl(data)!);
                            }}
                        >
                            Copy sanitized cURL (origin only)
                        </button>
                    )}
                    <p className="text-slate-500 mt-2">
                        Only explicitly enabled fields are captured. The origin-only cURL export omits headers and
                        bodies.
                    </p>
                </>
            );
        case 'crypto':
            return (
                <Fields
                    values={{
                        Provider: data.provider,
                        Verification: data.category,
                        'Payload bytes': data.payloadBytes,
                        'Timestamp check': data.timestampCheck,
                        'Replay check': data.replayCheck,
                    }}
                />
            );
        case 'notification':
            return (
                <>
                    <Fields
                        values={{
                            Channel: data.channel,
                            'Message ID': data.notificationId,
                            Outcome: data.outcome,
                            'Approval state': data.approvalState,
                            Approval: data.approval,
                            'Action token status': data.tokenStatus,
                            'Approval expires (UTC)':
                                data.approvalExpiresAt === undefined
                                    ? undefined
                                    : new Date(data.approvalExpiresAt).toISOString(),
                        }}
                    />
                    <p className="text-slate-500 mt-2">
                        Callback credentials are never captured. Message previews require explicit capture. Approval
                        dispatch does not imply approval completion.
                    </p>
                </>
            );
        case 'ai':
            return (
                <>
                    <Fields
                        values={{
                            Provider: data.provider,
                            Model: data.model,
                            'Input tokens': data.promptTokens,
                            'Output tokens': data.completionTokens,
                            'Total tokens': data.totalTokens,
                            'Estimated cost (USD)': data.estimatedCostUsd,
                            'Duration (ms)': data.durationMs,
                            Phase: data.phase,
                            'Inference attempt': data.inferenceAttempt,
                            Repairs: data.repairAttempts,
                            Fallbacks: data.fallbackCount,
                        }}
                    />
                    <p className="text-slate-500 mt-2">
                        Prompt and output capture requires an explicit redaction policy.
                    </p>
                </>
            );
    }
}

export function EcosystemInspector({ step }: { step: StepRun }) {
    if (!step.inspections?.length) return <p className="text-slate-500 text-xs">Ecosystem diagnostics unavailable.</p>;
    return (
        <div className="space-y-3 text-xs">
            {step.inspections.map((entry, i) => (
                <section key={i} className="border border-slate-700 rounded-lg p-3">
                    <h4 className="font-semibold text-slate-200 mb-2">
                        {entry.data.kind.toUpperCase()} · attempt {entry.attempt} · {entry.data.outcome}
                    </h4>
                    <InspectionDetails data={entry.data} />
                    <InspectionContent data={entry.data} />
                    {entry.data.truncated && <p className="text-amber-400">Summary truncated.</p>}
                </section>
            ))}
        </div>
    );
}
