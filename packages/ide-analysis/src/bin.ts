#!/usr/bin/env node

import readline from 'readline';
import {
    PROTOCOL_METHODS,
    JsonRpcErrorCode,
    type JsonRpcNotification,
    type JsonRpcRequest,
    type JsonRpcResponse,
    createResponse,
    createErrorResponse,
    isJsonRpcRequest,
} from '@siglo/ide-protocol';
import { parseWorkflowFile, resolveLocationInDocument, discoverWorkflows } from './parser';

const SERVER_VERSION = '1.3.0';
const PROTOCOL_VERSION = '1.0.0';

const SUPPORTED_SYNTAX_MATRIX = [
    'flow',
    'workflow',
    'pipe',
    'Step.create',
    'Step.compute',
    'new Step',
    'new ComputeStep',
    'defineStep',
    'Func.create',
    'Func.compute',
    'new Func',
    'Chain.create',
    'Chain.compute',
    'new Chain',
    'then',
    'parallel',
    'all',
    'allSettled',
    'race',
    'branch',
    'when',
    'map',
    'fallback',
    'compensate',
    'wait',
    'waitForEvent',
    'httpStep',
    'new HttpStep',
    'verifyWebhookStep',
    'sendNotificationStep',
    'sendInteractiveApprovalStep',
    'aiStep',
    'new AiStep',
    'encryptFieldsStep',
    'decryptFieldsStep',
    'maskFieldsStep',
];

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
});

rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
        const message = JSON.parse(trimmed);
        if (!isJsonRpcRequest(message)) {
            send(createErrorResponse(null, JsonRpcErrorCode.InvalidRequest, 'Invalid JSON-RPC 2.0 Request'));
            return;
        }

        handleRequest(message);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        send(createErrorResponse(null, JsonRpcErrorCode.ParseError, 'JSON parse error', message));
    }
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSourcePosition(value: unknown): value is { line: number; character: number } {
    if (!isPlainRecord(value)) return false;
    return (
        typeof value.line === 'number' &&
        Number.isFinite(value.line) &&
        typeof value.character === 'number' &&
        Number.isFinite(value.character)
    );
}

function handleRequest(req: JsonRpcRequest): void {
    const { id, method, params } = req;
    const p = isPlainRecord(params) ? params : undefined;

    switch (method) {
        case PROTOCOL_METHODS.INITIALIZE: {
            send(
                createResponse(id, {
                    serverVersion: SERVER_VERSION,
                    protocolVersion: PROTOCOL_VERSION,
                    supportedSyntaxMatrix: SUPPORTED_SYNTAX_MATRIX,
                }),
            );
            break;
        }

        case PROTOCOL_METHODS.DISCOVER_WORKFLOWS: {
            const workflows = discoverWorkflows({
                documentUri: typeof p?.documentUri === 'string' ? p.documentUri : undefined,
                workspaceUri: typeof p?.workspaceUri === 'string' ? p.workspaceUri : undefined,
            });
            send(createResponse(id, { workflows }));
            break;
        }

        case PROTOCOL_METHODS.GET_GRAPH: {
            if (!p || typeof p.uri !== 'string' || !p.uri) {
                send(createErrorResponse(id, JsonRpcErrorCode.InvalidParams, 'Missing uri in params'));
                return;
            }
            const graph = parseWorkflowFile({
                uri: p.uri,
                documentVersion:
                    typeof p.documentVersion === 'number' && Number.isFinite(p.documentVersion) ? p.documentVersion : 1,
                content: typeof p.content === 'string' ? p.content : undefined,
                workflowName: typeof p.workflowName === 'string' ? p.workflowName : undefined,
            });
            send(createResponse(id, graph));
            break;
        }

        case PROTOCOL_METHODS.RESOLVE_LOCATION: {
            if (!p || typeof p.uri !== 'string' || !p.uri || !isSourcePosition(p.position)) {
                send(
                    createErrorResponse(id, JsonRpcErrorCode.InvalidParams, 'Missing valid uri or position in params'),
                );
                return;
            }
            const graph = parseWorkflowFile({
                uri: p.uri,
                content: typeof p.content === 'string' ? p.content : undefined,
                workflowName: typeof p.workflowName === 'string' ? p.workflowName : undefined,
            });
            const resolved = resolveLocationInDocument(graph, p.position);
            send(createResponse(id, resolved));
            break;
        }

        case PROTOCOL_METHODS.SHUTDOWN: {
            send(createResponse(id, { success: true }));
            process.exit(0);
            break;
        }

        default: {
            send(createErrorResponse(id, JsonRpcErrorCode.MethodNotFound, `Method not found: ${method}`));
            break;
        }
    }
}

function send(obj: JsonRpcResponse | JsonRpcNotification): void {
    process.stdout.write(JSON.stringify(obj) + '\n');
}
