import type { GraphDocument, GraphNode, RunEvent, SourceRange, TelemetryRecordingDocument } from '@siglo/ide-protocol';

interface VsCodeApi {
    postMessage: (msg: unknown) => void;
    getState?: () => unknown;
    setState?: (state: unknown) => void;
}

declare global {
    interface Window {
        cefQuery?: (query: {
            request: string;
            onSuccess?: (response: string) => void;
            onFailure?: (errorCode: number, errorMessage: string) => void;
        }) => void;
        acquireVsCodeApi?: () => VsCodeApi;
        __SIGLO_BRIDGE__?: {
            dispatch: (msg: unknown) => void;
        };
    }
}

export type HostMessage =
    | RunEvent
    | { type: 'setGraph'; document: GraphDocument }
    | { type: 'setStatus'; message: string | null; level?: 'info' | 'warning' | 'error' }
    | { type: 'selectNode'; nodeId: string }
    | { type: 'clearSelection' }
    | { type: 'setTelemetry'; document: TelemetryRecordingDocument | null }
    | { type: 'clearTelemetry' };

export type OutgoingMessage =
    | { type: 'ready' }
    | { type: 'reload' }
    | { type: 'setAutoReload'; enabled: boolean }
    | { type: 'importTelemetry' }
    | {
          type: 'nodeSelected';
          nodeId: string;
          location: SourceRange;
          name: string;
          stepKind: GraphNode['stepKind'];
      }
    | { type: 'workflowSelected'; workflowName: string }
    | { type: 'openRelatedFile'; uri: string }
    | {
          type: 'runSteps';
          runId: string;
          uri: string;
          documentVersion: number;
          workflowName: string;
          nodeIds: string[];
          input: unknown;
      }
    | { type: 'cancelRun'; runId?: string }
    | { type: 'copyRunOutput'; text: string };

function isHostMessage(msg: unknown): msg is HostMessage {
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return false;
    const record = msg as Record<string, unknown>;
    switch (record.type) {
        case 'runEvent':
            return typeof record.runId === 'string' && typeof record.status === 'string';
        case 'setGraph':
            return typeof record.document === 'object' && record.document !== null;
        case 'setStatus':
            return record.message === null || typeof record.message === 'string';
        case 'selectNode':
            return typeof record.nodeId === 'string';
        case 'setTelemetry':
            return record.document === null || (typeof record.document === 'object' && record.document !== null);
        case 'clearSelection':
        case 'clearTelemetry':
            return true;
        default:
            return false;
    }
}

type MessageHandler = (msg: HostMessage) => void;

class IdeBridge {
    private handlers: Set<MessageHandler> = new Set();
    private vscodeApi?: VsCodeApi;

    constructor() {
        // Acquire VS Code API if available (can only be acquired once per session)
        if (typeof window.acquireVsCodeApi === 'function') {
            try {
                this.vscodeApi = window.acquireVsCodeApi();
            } catch {
                // Already acquired or unavailable in current context
            }
        }

        // Setup the receiver function for Kotlin JBCefBrowser executeJavaScript
        window.__SIGLO_BRIDGE__ = {
            dispatch: (msg: unknown) => {
                try {
                    const parsed: unknown = typeof msg === 'string' ? JSON.parse(msg) : msg;
                    if (isHostMessage(parsed)) {
                        this.notifyHandlers(parsed);
                    }
                } catch (err) {
                    console.error('[Siglo Bridge] Failed to parse message from host:', err);
                }
            },
        };

        // Also listen to window.message for VS Code webview or iframe contexts
        window.addEventListener('message', event => {
            if (isHostMessage(event.data)) {
                this.notifyHandlers(event.data);
            }
        });
    }

    public subscribe(handler: MessageHandler): () => void {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    private notifyHandlers(msg: HostMessage): void {
        for (const h of this.handlers) {
            try {
                h(msg);
            } catch (err) {
                console.error('[Siglo Bridge] Error in message handler:', err);
            }
        }
    }

    public sendToHost(payload: OutgoingMessage): Promise<string | void> {
        const raw = JSON.stringify(payload);
        return new Promise((resolve, reject) => {
            if (typeof window.cefQuery === 'function') {
                window.cefQuery({
                    request: raw,
                    onSuccess: res => resolve(res),
                    onFailure: (code, msg) => reject(new Error(`cefQuery failed: ${code} - ${msg}`)),
                });
            } else if (this.vscodeApi) {
                this.vscodeApi.postMessage(payload);
                resolve();
            } else {
                // Fallback / mock mode in standard browser
                console.info('[Siglo Bridge: Mock Host]', payload);
                resolve();
            }
        });
    }

    public notifyNodeSelected(node: GraphNode): void {
        void this.sendToHost({
            type: 'nodeSelected',
            nodeId: node.id,
            location: node.location,
            name: node.name,
            stepKind: node.stepKind,
        });
    }

    public notifyWorkflowSelected(workflowName: string): void {
        void this.sendToHost({
            type: 'workflowSelected',
            workflowName,
        });
    }

    public notifyOpenRelatedFile(uri: string): void {
        void this.sendToHost({
            type: 'openRelatedFile',
            uri,
        });
    }

    public notifyImportTelemetry(): void {
        void this.sendToHost({
            type: 'importTelemetry',
        });
    }
}

export const bridge = new IdeBridge();
