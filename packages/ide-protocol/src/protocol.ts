import type { GraphDocument, SourcePosition, SourceRange } from './types';

export const JSONRPC_VERSION = '2.0';

export enum JsonRpcErrorCode {
    ParseError = -32700,
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams = -32602,
    InternalError = -32603,
    ServerNotInitialized = -32002,
    RequestCancelled = -32800,
}

export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}

export interface JsonRpcRequest<TParams = any> {
    jsonrpc: '2.0';
    id: string | number;
    method: string;
    params: TParams;
}

export interface JsonRpcResponse<TResult = any> {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: TResult;
    error?: JsonRpcError;
}

export interface JsonRpcNotification<TParams = any> {
    jsonrpc: '2.0';
    method: string;
    params?: TParams;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// Methods
export const PROTOCOL_METHODS = {
    INITIALIZE: 'siglo/initialize',
    DISCOVER_WORKFLOWS: 'siglo/discoverWorkflows',
    GET_GRAPH: 'siglo/getGraph',
    RESOLVE_LOCATION: 'siglo/resolveLocation',
    SHUTDOWN: 'siglo/shutdown',
} as const;

// 1. siglo/initialize
export interface InitializeParams {
    clientName: string;
    clientVersion: string;
    rootUri: string;
    capabilities: {
        dynamicRefresh: boolean;
    };
}

export interface InitializeResult {
    serverVersion: string;
    protocolVersion: '1.0.0';
    supportedSyntaxMatrix: string[];
}

// 2. siglo/discoverWorkflows
export interface DiscoverWorkflowsParams {
    documentUri?: string;
    workspaceUri?: string;
}

export interface DiscoveredWorkflow {
    id: string;
    name: string;
    uri: string;
    range: SourceRange;
}

export interface DiscoverWorkflowsResult {
    workflows: DiscoveredWorkflow[];
}

// 3. siglo/getGraph
export interface GetGraphParams {
    uri: string;
    documentVersion: number;
    content?: string;
}

export type GetGraphResult = GraphDocument;

// 4. siglo/resolveLocation
export interface ResolveLocationParams {
    uri: string;
    position: SourcePosition;
}

export interface ResolveLocationResult {
    nodeId?: string;
    edgeId?: string;
    range?: SourceRange;
}

// 5. siglo/shutdown
export type ShutdownParams = Record<string, never>;

export interface ShutdownResult {
    success: boolean;
}

// Message helpers
export function createRequest<TParams>(id: string | number, method: string, params: TParams): JsonRpcRequest<TParams> {
    return {
        jsonrpc: JSONRPC_VERSION,
        id,
        method,
        params,
    };
}

export function createResponse<TResult>(id: string | number | null, result: TResult): JsonRpcResponse<TResult> {
    return {
        jsonrpc: JSONRPC_VERSION,
        id,
        result,
    };
}

export function createErrorResponse(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown,
): JsonRpcResponse<never> {
    return {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: {
            code,
            message,
            ...(data !== undefined ? { data } : {}),
        },
    };
}

export function createNotification<TParams>(method: string, params?: TParams): JsonRpcNotification<TParams> {
    return {
        jsonrpc: JSONRPC_VERSION,
        method,
        ...(params !== undefined ? { params } : {}),
    };
}

export function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return (
        m.jsonrpc === '2.0' && (typeof m.id === 'string' || typeof m.id === 'number') && typeof m.method === 'string'
    );
}

export function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return m.jsonrpc === '2.0' && ('result' in m || 'error' in m);
}

export function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return m.jsonrpc === '2.0' && typeof m.method === 'string' && !('id' in m);
}
