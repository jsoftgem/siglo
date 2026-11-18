import type { WorkflowQueryEngine } from '../engine';
import { formatWorkflowDetail, resolveMcpNamespace, type McpTenantScopeOptions } from './tools';

export const WORKFLOW_MCP_PROMPTS = [
    {
        name: 'diagnose_failure',
        description:
            'Diagnose why a workflow execution failed, inspect step history and error diagnostics, and recommend remediation steps.',
        arguments: [
            {
                name: 'stackId',
                description: 'The workflow execution stackId to diagnose.',
                required: false,
            },
            {
                name: 'workflowId',
                description: 'Optional workflowId to search for recent failed executions.',
                required: false,
            },
            {
                name: 'namespace',
                description: 'Tenant partition namespace.',
                required: false,
            },
        ],
    },
];

export interface McpPromptContext extends McpTenantScopeOptions {
    engine: WorkflowQueryEngine;
}

export async function getMcpPrompt(
    name: string,
    args: Record<string, string> | undefined,
    ctx: McpPromptContext,
): Promise<{
    description: string;
    messages: Array<{
        role: 'user' | 'assistant';
        content: { type: 'text'; text: string };
    }>;
}> {
    if (name !== 'diagnose_failure') {
        throw new Error(`Unknown MCP prompt: '${name}'`);
    }

    const namespace = resolveMcpNamespace(args?.namespace, ctx);
    const stackId = args?.stackId?.trim();
    const workflowId = args?.workflowId?.trim();

    if (stackId) {
        const execution = await ctx.engine.findById(stackId, {
            namespace,
            includeContext: true,
            redact: true,
        });

        if (!execution) {
            return {
                description: `Diagnose workflow failure for stack '${stackId}' in namespace '${namespace}'`,
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: [
                                `Workflow execution '${stackId}' was not found in namespace '${namespace}'.`,
                                `Use the 'search_workflows' tool with { "namespace": "${namespace}", "status": "FAILED"${workflowId ? `, "workflowId": "${workflowId}"` : ''} } to locate the failed workflow, then call 'inspect_workflow' to analyze its step history and error diagnostics.`,
                            ].join('\n\n'),
                        },
                    },
                ],
            };
        }

        const snapshot = formatWorkflowDetail(execution, true);
        return {
            description: `Root-cause failure diagnosis for workflow '${stackId}'`,
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: [
                            `Diagnose the failure for Siglo workflow execution '${stackId}' in namespace '${namespace}'.`,
                            `Here is the redacted workflow execution snapshot:`,
                            '```json',
                            JSON.stringify(snapshot, null, 2),
                            '```',
                            `Please provide:`,
                            `1. **Failing Step & Root Cause**: Identify which step failed and the specific exception or error reason.`,
                            `2. **Execution Context State**: Summarize the relevant state accumulated prior to the failure.`,
                            `3. **Saga & Compensation Status**: Note whether any compensations ran or require operator attention.`,
                            `4. **Remediation Plan**: Recommend concrete recovery or retry actions.`,
                        ].join('\n'),
                    },
                },
            ],
        };
    }

    return {
        description: `Diagnose recent workflow failures in namespace '${namespace}'`,
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: [
                        `Diagnose recent workflow failures in namespace '${namespace}'${workflowId ? ` for workflowId '${workflowId}'` : ''}.`,
                        `Step 1: Call 'search_workflows' with { "namespace": "${namespace}", "status": "FAILED"${workflowId ? `, "workflowId": "${workflowId}"` : ''} }.`,
                        `Step 2: For the failed execution(s), call 'inspect_workflow' with { "stackId": "<stackId>", "namespace": "${namespace}", "includeSteps": true }.`,
                        `Step 3: Report the failing step, error cause, compensation status, and recommended remediation.`,
                    ].join('\n'),
                },
            },
        ],
    };
}
