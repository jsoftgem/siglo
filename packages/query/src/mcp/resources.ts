import type { WorkflowQueryEngine } from '../engine';
import { WORKFLOW_SCHEMA_SDL } from '../graphql/schema';
import { formatWorkflowDetail, formatWorkflowSummary, resolveMcpNamespace, type McpTenantScopeOptions } from './tools';

export const WORKFLOW_MCP_RESOURCES = [
    {
        uri: 'siglo://workflows/active',
        name: 'Active Workflows',
        description: 'Live list of currently executing (RUNNING) or waiting (WAITING) workflows.',
        mimeType: 'application/json',
    },
    {
        uri: 'siglo://schema/graphql',
        name: 'Siglo Workflow GraphQL Schema',
        description: 'The full GraphQL SDL contract, allowing AI assistants to construct valid queries.',
        mimeType: 'text/plain',
    },
];

export const WORKFLOW_MCP_RESOURCE_TEMPLATES = [
    {
        uriTemplate: 'siglo://workflows/{stackId}',
        name: 'Workflow Execution Snapshot',
        description: 'Real-time status, step breakdown, and redacted context snapshot of a specific workflow.',
        mimeType: 'application/json',
    },
];

export interface McpResourceContext extends McpTenantScopeOptions {
    engine: WorkflowQueryEngine;
}

export async function readMcpResource(
    uri: string,
    ctx: McpResourceContext,
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
    let parsed: URL;
    try {
        parsed = new URL(uri);
    } catch {
        throw new Error(`Invalid MCP resource URI: '${uri}'`);
    }

    if (parsed.protocol !== 'siglo:') {
        throw new Error(`Unsupported MCP resource protocol: '${parsed.protocol}'`);
    }

    const host = parsed.hostname;
    const pathname = parsed.pathname.replace(/^\/+/, '');
    const queryNamespaceParam = parsed.searchParams.get('namespace') ?? undefined;

    if (host === 'schema' && pathname === 'graphql') {
        return {
            contents: [
                {
                    uri,
                    mimeType: 'text/plain',
                    text: WORKFLOW_SCHEMA_SDL.trim(),
                },
            ],
        };
    }

    if (host === 'workflows') {
        const namespace = resolveMcpNamespace(queryNamespaceParam, ctx);

        if (pathname === 'active') {
            const limitParam = parsed.searchParams.get('limit');
            const limit = limitParam ? Number(limitParam) : 25;

            const [runningPage, waitingPage] = await Promise.all([
                ctx.engine.findMany({
                    filter: { namespace, status: 'running' },
                    pagination: { limit },
                    select: { includeContext: false },
                }),
                ctx.engine.findMany({
                    filter: { namespace, status: 'waiting' },
                    pagination: { limit },
                    select: { includeContext: false },
                }),
            ]);

            const combined = [...runningPage.items, ...waitingPage.items].sort(
                (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
            );

            const payload = {
                namespace,
                activeCount: runningPage.totalCount + waitingPage.totalCount,
                workflows: combined.slice(0, limit).map(formatWorkflowSummary),
            };

            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify(payload, null, 2),
                    },
                ],
            };
        }

        const stackId = decodeURIComponent(pathname);
        if (!stackId || stackId.includes('/')) {
            throw new Error(`Unknown MCP workflow resource URI: '${uri}'`);
        }

        const execution = await ctx.engine.findById(stackId, {
            namespace,
            includeContext: true,
            redact: true,
        });

        if (!execution) {
            throw new Error(`Workflow '${stackId}' not found in namespace '${namespace}'`);
        }

        return {
            contents: [
                {
                    uri,
                    mimeType: 'application/json',
                    text: JSON.stringify(formatWorkflowDetail(execution, true), null, 2),
                },
            ],
        };
    }

    throw new Error(`Unknown MCP resource URI: '${uri}'`);
}
