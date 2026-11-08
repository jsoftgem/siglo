#!/usr/bin/env node

import readline from 'readline';
import {
    PROTOCOL_METHODS,
    JsonRpcErrorCode,
    createResponse,
    createErrorResponse,
    isJsonRpcRequest,
} from '@siglo/ide-protocol';
import { parseWorkflowFile, resolveLocationInDocument, discoverWorkflows } from './parser';

const SERVER_VERSION = '1.2.0';
const PROTOCOL_VERSION = '1.0.0';

const SUPPORTED_SYNTAX_MATRIX = [
    'flow',
    'workflow',
    'pipe',
    'Step.create',
    'new Step',
    'defineStep',
    'Func.create',
    'new Func',
    'Chain.create',
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
    } catch (err: any) {
        send(createErrorResponse(null, JsonRpcErrorCode.ParseError, 'JSON parse error', String(err?.message || err)));
    }
});

function handleRequest(req: { id: string | number; method: string; params?: any }) {
    const { id, method, params } = req;

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
            const workflows = discoverWorkflows(params || {});
            send(createResponse(id, { workflows }));
            break;
        }

        case PROTOCOL_METHODS.GET_GRAPH: {
            if (!params || !params.uri) {
                send(createErrorResponse(id, JsonRpcErrorCode.InvalidParams, 'Missing uri in params'));
                return;
            }
            const graph = parseWorkflowFile({
                uri: params.uri,
                documentVersion: params.documentVersion ?? 1,
                content: params.content,
                workflowName: params.workflowName,
            });
            send(createResponse(id, graph));
            break;
        }

        case PROTOCOL_METHODS.RESOLVE_LOCATION: {
            if (!params || !params.uri || !params.position) {
                send(createErrorResponse(id, JsonRpcErrorCode.InvalidParams, 'Missing uri or position in params'));
                return;
            }
            const graph = parseWorkflowFile({
                uri: params.uri,
                content: params.content,
                workflowName: params.workflowName,
            });
            const resolved = resolveLocationInDocument(graph, params.position);
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

function send(obj: any) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}
