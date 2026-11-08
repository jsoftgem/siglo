import React from 'react';
import type { GraphNode, StepSpecRule } from '@siglo/ide-protocol';
import { Braces, CheckCircle2, SlidersHorizontal } from 'lucide-react';

const ruleLabels: Record<StepSpecRule['kind'], string> = {
    default: 'Default value',
    required: 'Required',
    message: 'Required message',
    validate: 'Validation',
    transform: 'Transform',
    translate: 'Translation',
    schema: 'Schema',
    options: 'Additional options',
};

function readableLabel(key: string) {
    const labels: Record<string, string> = {
        operation: 'Step type',
        idempotent: 'Idempotency',
        maxRetries: 'Maximum retries',
        timeoutMs: 'Timeout (ms)',
        correlationKey: 'Correlation key',
        preserveOrder: 'Preserve order',
        stopOnError: 'Stop on error',
        compensateWithHttp: 'HTTP compensation',
    };
    return labels[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

// Remove shared source indentation so nested callbacks remain readable in the
// narrow inspector. Preserve relative indentation and never evaluate code.
function formatSource(value: string) {
    const lines = value.trim().split('\n');
    const indentation = Math.min(
        ...lines
            .slice(1)
            .filter(line => line.trim())
            .map(line => line.match(/^\s*/)?.[0].length || 0),
    );
    return [lines[0], ...lines.slice(1).map(line => line.slice(Number.isFinite(indentation) ? indentation : 0))].join(
        '\n',
    );
}

function SourceDetails({ value, label = 'View source' }: { value: string; label?: string }) {
    return (
        <details className="mt-2 group">
            <summary className="cursor-pointer text-[11px] text-sky-400 rounded focus-visible:outline focus-visible:outline-1 focus-visible:outline-sky-400">
                {label}
            </summary>
            <pre className="mt-2 rounded bg-[#17181b] border border-[#393b40] p-2 text-[11px] leading-relaxed text-[#bcbec4] whitespace-pre-wrap break-words [overflow-wrap:anywhere] select-text">
                {formatSource(value)}
            </pre>
        </details>
    );
}

function SpecRule({ rule }: { rule: StepSpecRule }) {
    const custom = ['validate', 'transform', 'translate', 'schema'].includes(rule.kind);
    const summary =
        rule.kind === 'required'
            ? rule.expression
                ? 'Conditional'
                : rule.value === 'true'
                  ? 'Yes'
                  : rule.value === 'false'
                    ? 'No'
                    : rule.value
            : custom
              ? rule.description || (rule.kind === 'schema' ? 'Custom schema' : 'Custom function')
              : rule.expression
                ? 'Configured expression'
                : rule.value;
    return (
        <div className="py-2 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <dt className="text-[11px] text-[#9da0a8]">{ruleLabels[rule.kind]}</dt>
                {!rule.expression && !custom && (
                    <dd
                        className={`text-xs break-words [overflow-wrap:anywhere] ${rule.kind === 'required' && rule.value === 'true' ? 'text-emerald-400' : 'text-[#dfe1e5]'}`}
                    >
                        {summary === '' ? 'Empty string' : summary}
                    </dd>
                )}
            </div>
            {(custom || rule.expression) && (
                <dd className="mt-1 text-xs text-[#dfe1e5] break-words [overflow-wrap:anywhere]">
                    {summary}
                    <SourceDetails
                        value={rule.value}
                        label={rule.kind === 'schema' ? 'View schema' : 'View expression'}
                    />
                </dd>
            )}
        </div>
    );
}

export function StepProperties({ node }: { node: GraphNode }): React.ReactElement | null {
    const fields = new Map<string, StepSpecRule[]>();
    for (const spec of node.specs || []) fields.set(spec.field, [...(fields.get(spec.field) || []), ...spec.rules]);
    const properties = Object.entries(node.properties || {});
    if (!fields.size && !properties.length) return null;

    return (
        <section className="space-y-3">
            <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase text-[#9da0a8] tracking-wider">
                <SlidersHorizontal className="w-3.5 h-3.5" />
                Step properties
            </h4>
            {properties.length > 0 && (
                <dl className="rounded-lg border border-[#393b40] bg-[#1e1f22] px-3 divide-y divide-[#393b40] select-text">
                    {properties.map(([key, value]) => {
                        const complex =
                            value.includes('\n') ||
                            value.includes('=>') ||
                            value.length > 80 ||
                            /^[\[{]/.test(value.trim());
                        const literal = value.replace(/^(['"])(.*)\1$/, '$2');
                        return (
                            <div key={key} className="py-2.5">
                                <dt className="text-[11px] text-[#9da0a8]">{readableLabel(key)}</dt>
                                <dd className="mt-1 text-xs text-[#dfe1e5] break-words [overflow-wrap:anywhere]">
                                    {complex ? (
                                        <SourceDetails value={value} label="View configuration" />
                                    ) : literal === 'true' ? (
                                        'Enabled'
                                    ) : literal === 'false' ? (
                                        'Disabled'
                                    ) : (
                                        literal
                                    )}
                                </dd>
                            </div>
                        );
                    })}
                </dl>
            )}
            {fields.size > 0 && (
                <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2 text-[11px] text-[#9da0a8]">
                        <span>Input contracts</span>
                        <span>
                            {fields.size} {fields.size === 1 ? 'field' : 'fields'}
                        </span>
                    </div>
                    {[...fields.entries()].map(([field, rules]) => (
                        <article
                            key={field}
                            className="rounded-lg border border-[#393b40] overflow-hidden bg-[#1e1f22]"
                        >
                            <header className="flex flex-wrap items-center gap-2 px-3 py-2.5 bg-[#2b2d30] border-b border-[#393b40]">
                                {field === '$root$' ? (
                                    <Braces className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                                ) : (
                                    <CheckCircle2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                                )}
                                <h5 className="font-medium text-xs text-[#dfe1e5] break-all">
                                    {field === '$root$' ? 'Whole input' : field}
                                </h5>
                                <span className="ml-auto text-[10px] text-[#9da0a8]">
                                    {rules.length} {rules.length === 1 ? 'rule' : 'rules'}
                                </span>
                            </header>
                            <dl className="px-3 py-2.5 divide-y divide-[#393b40] select-text">
                                {rules.map((rule, index) => (
                                    <SpecRule key={index} rule={rule} />
                                ))}
                                {!rules.length && (
                                    <dd className="text-[11px] text-[#9da0a8]">No static rules configured.</dd>
                                )}
                            </dl>
                        </article>
                    ))}
                </div>
            )}
        </section>
    );
}
