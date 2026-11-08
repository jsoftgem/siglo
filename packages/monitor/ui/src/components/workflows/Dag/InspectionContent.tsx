import * as React from 'react';
import type { EcosystemInspection } from '@siglo/core';

/** Reconstruct only inert formatting tags; every attribute and active tag is text. */
export function previewDocument(text: string): string {
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(
            /&lt;(\/?)(p|br|b|strong|i|em|ul|ol|li|pre|code|h1|h2|h3|blockquote)&gt;/gi,
            (_, close, tag) => `<${close}${tag.toLowerCase()}>`,
        );
    const meta = [
        '<meta',
        'http-equiv="Content-Security-Policy"',
        "content=\"default-src 'none'; base-uri 'none'; form-action 'none'\">",
    ].join(' ');
    return `<!doctype html><html><head>${meta}</head><body>${escaped}</body></html>`;
}

export function InspectionContent({ data }: { data: EcosystemInspection }) {
    if (!data.content || !Object.keys(data.content).length) return null;
    return (
        <div className="mt-3 space-y-2">
            {Object.entries(data.content).map(
                ([field, value]) =>
                    value && (
                        <details key={field}>
                            <summary className="text-sky-300">{field} (redacted capture)</summary>
                            {field === 'preview' && data.kind === 'notification' && data.channel === 'email' ? (
                                <iframe
                                    title="Isolated notification preview"
                                    sandbox=""
                                    referrerPolicy="no-referrer"
                                    srcDoc={previewDocument(value.text)}
                                    className="w-full bg-white"
                                />
                            ) : (
                                <pre className="whitespace-pre-wrap break-all text-slate-200">{value.text}</pre>
                            )}
                            {value.truncated && <p className="text-amber-400">Capture truncated.</p>}
                        </details>
                    ),
            )}
        </div>
    );
}
