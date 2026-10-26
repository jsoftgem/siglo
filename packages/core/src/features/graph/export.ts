import { toGraph } from './toGraph';
import { inspectGraph } from './inspector';

export interface MermaidExportOptions {
    direction?: 'TD' | 'LR' | 'TB';
    includeBadges?: boolean;
}

export interface DotExportOptions {
    graphName?: string;
    direction?: 'TB' | 'LR';
}

function sanitizeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

function formatBadges(node: { name: string; type: string; metadata?: any }): string {
    const badges: string[] = [];
    const meta = node.metadata;
    if (meta) {
        if (meta.timeoutMs) {
            badges.push(`⏱️ ${meta.timeoutMs}ms`);
        }
        if (meta.retryConfig) {
            const max = meta.retryConfig.maxRetries ?? meta.retryConfig.retries ?? 'auto';
            badges.push(`🔁 retry(${max})`);
        }
        if (meta.hasCompensation) {
            badges.push('⏪ saga');
        }
        if (meta.cachedLast || meta.cacheOptions) {
            badges.push('💾 cache');
        }
    }
    if (node.type === 'wait') {
        badges.push('⏳ wait');
    }
    return badges.length > 0 ? ` [${badges.join(' ')}]` : '';
}

/**
 * Exports a workflow or node to a Mermaid flowchart diagram.
 */
export function toMermaid(workflowOrNode: any, options: MermaidExportOptions = {}): string {
    const inspection = inspectGraph(workflowOrNode);
    const dir = options.direction || 'TD';
    const lines = [`flowchart ${dir}`];

    for (const node of inspection.nodes) {
        const sid = sanitizeId(node.id);
        const badges = options.includeBadges !== false ? formatBadges(node) : '';
        const label = `${node.name} (${node.type})${badges}`.replace(/"/g, "'");

        switch (node.type) {
            case 'step':
                lines.push(`    ${sid}["${label}"]`);
                break;
            case 'branch':
                lines.push(`    ${sid}{"${label}"}`);
                break;
            case 'wait':
                lines.push(`    ${sid}(["${label}"])`);
                break;
            case 'map':
                lines.push(`    ${sid}[/"${label}"/]`);
                break;
            case 'parallel':
                lines.push(`    ${sid}[["${label}"]]`);
                break;
            default:
                lines.push(`    ${sid}["${label}"]`);
                break;
        }
    }

    for (const edge of inspection.edges) {
        const fromSid = sanitizeId(edge.from);
        const toSid = sanitizeId(edge.to);
        if (edge.label) {
            lines.push(`    ${fromSid} -->|${edge.label}| ${toSid}`);
        } /* c8 ignore next 2 */ else {
            lines.push(`    ${fromSid} --> ${toSid}`);
        }
    }

    return lines.join('\n');
}

/**
 * Exports a workflow or node to a formatted JSON string.
 */
export function toJSON(workflowOrNode: any): string {
    const root = toGraph(workflowOrNode);
    return JSON.stringify(root, (key, value) => {
        // Strip cyclical or internal function pointers from serialized AST
        if (key === 'step' || key === 'action' || key === 'selector') {
            return undefined;
        }
        return value;
    }, 2);
}

/**
 * Exports a workflow or node to Graphviz DOT format.
 */
export function toDot(workflowOrNode: any, options: DotExportOptions = {}): string {
    const inspection = inspectGraph(workflowOrNode);
    const graphName = options.graphName || 'Workflow';
    const dir = options.direction || 'TB';

    const lines = [
        `digraph ${graphName} {`,
        `  rankdir=${dir};`,
        '  node [fontname="Helvetica", fontsize=11];',
        '  edge [fontname="Helvetica", fontsize=9];'
    ];

    for (const node of inspection.nodes) {
        const sid = sanitizeId(node.id);
        const badges = formatBadges(node);
        const label = `${node.name}\\n[${node.type}]${badges}`.replace(/"/g, '\\"');

        let shape = 'box';
        let style = 'rounded,filled';
        let fillcolor = '#e8f4fd';

        switch (node.type) {
            case 'branch':
                shape = 'diamond';
                fillcolor = '#fff3cd';
                break;
            case 'wait':
                shape = 'ellipse';
                fillcolor = '#d1e7dd';
                break;
            case 'parallel':
                shape = 'component';
                fillcolor = '#f8d7da';
                break;
            case 'map':
                shape = 'parallelogram';
                fillcolor = '#e2e3e5';
                break;
            case 'step':
            default:
                shape = 'box';
                fillcolor = '#f0f4f8';
                break;
        }

        lines.push(`  ${sid} [label="${label}", shape=${shape}, style="${style}", fillcolor="${fillcolor}"];`);
    }

    for (const edge of inspection.edges) {
        const fromSid = sanitizeId(edge.from);
        const toSid = sanitizeId(edge.to);
        const edgeLabel = edge.label ? ` [label="${edge.label}"]` : '';
        lines.push(`  ${fromSid} -> ${toSid}${edgeLabel};`);
    }

    lines.push('}');
    return lines.join('\n');
}
