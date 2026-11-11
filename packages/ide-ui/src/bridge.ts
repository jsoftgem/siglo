import type { GraphDocument, GraphNode, TelemetryRecordingDocument } from '@siglo/ide-protocol';

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
            dispatch: (msg: any) => void;
        };
    }
}

export type HostMessage =
    | { type: 'setGraph'; document: GraphDocument }
    | { type: 'selectNode'; nodeId: string }
    | { type: 'clearSelection' }
    | { type: 'setTelemetry'; document: TelemetryRecordingDocument | null }
    | { type: 'clearTelemetry' };

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
            dispatch: (msg: any) => {
                try {
                    const parsed = typeof msg === 'string' ? JSON.parse(msg) : msg;
                    this.notifyHandlers(parsed);
                } catch (err) {
                    console.error('[Siglo Bridge] Failed to parse message from host:', err);
                }
            },
        };

        // Also listen to window.message for VS Code webview or iframe contexts
        window.addEventListener('message', event => {
            if (event.data && typeof event.data === 'object' && event.data.type) {
                this.notifyHandlers(event.data);
            }
        });
    }

    public subscribe(handler: MessageHandler): () => void {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    private notifyHandlers(msg: HostMessage) {
        for (const h of this.handlers) {
            try {
                h(msg);
            } catch (err) {
                console.error('[Siglo Bridge] Error in message handler:', err);
            }
        }
    }

    public sendToHost(payload: Record<string, unknown>): Promise<string | void> {
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

    public notifyNodeSelected(node: GraphNode) {
        this.sendToHost({
            type: 'nodeSelected',
            nodeId: node.id,
            location: node.location,
            name: node.name,
            stepKind: node.stepKind,
        });
    }

    public notifyWorkflowSelected(workflowName: string) {
        this.sendToHost({
            type: 'workflowSelected',
            workflowName,
        });
    }

    public notifyOpenRelatedFile(uri: string) {
        this.sendToHost({
            type: 'openRelatedFile',
            uri,
        });
    }

    public notifyImportTelemetry() {
        this.sendToHost({
            type: 'importTelemetry',
        });
    }
}

export const bridge = new IdeBridge();
