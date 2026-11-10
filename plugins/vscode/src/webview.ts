import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { GraphDocument } from '@siglo/ide-protocol';

/** Nonce scripts and style elements; React's graph coordinates require style attributes. */
export function secureHtml(html: string): string {
    const nonce = randomBytes(24).toString('base64');
    const csp = `default-src 'none'; img-src data:; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline';`;
    // Match whole raw-text elements so tag-like strings inside bundled JavaScript
    // and CSS stay untouched (React itself contains "<script>" strings).
    return html
        .replace(
            /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi,
            (_element, tag: string, attributes: string, content: string) =>
                `<${tag} nonce="${nonce}"${attributes}>${content}</${tag}>`,
        )
        .replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
}

interface Surface {
    webview: vscode.Webview;
    ready: boolean;
    autoReload: boolean;
}

export type NavigationTarget =
    { kind: 'node'; nodeId: string } | { kind: 'workflow'; workflowName: string } | { kind: 'file'; uri: string };

export class WorkflowViews implements vscode.WebviewViewProvider, vscode.Disposable {
    private surfaces = new Set<Surface>();
    private panel?: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private document?: GraphDocument;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly refresh: () => Promise<void>,
        private readonly navigate: (target: NavigationTarget) => Promise<void>,
        private readonly report: (error: unknown) => void,
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.attach(view.webview, view.onDidDispose);
    }

    open(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'siglo.visualizer',
            'Siglo Workflow Visualizer',
            vscode.ViewColumn.Beside,
            { enableScripts: true },
        );
        this.panel = panel;
        this.disposables.push(
            panel.onDidDispose(() => {
                this.panel = undefined;
            }),
        );
        this.attach(panel.webview, panel.onDidDispose);
    }

    private attach(webview: vscode.Webview, onDispose: vscode.Event<void>): void {
        const surface: Surface = { webview, ready: false, autoReload: true };
        this.surfaces.add(surface);
        webview.options = { enableScripts: true, localResourceRoots: [] };
        const receiver = webview.onDidReceiveMessage((message: unknown) => {
            if (!message || typeof message !== 'object' || !('type' in message)) return;
            const msg = message as {
                type: unknown;
                nodeId?: unknown;
                workflowName?: unknown;
                uri?: unknown;
                enabled?: unknown;
            };
            if (msg.type === 'ready') {
                surface.ready = true;
                if (this.document) void webview.postMessage({ type: 'setGraph', document: this.document });
                else void this.refresh().catch(this.report);
            } else if (msg.type === 'reload') {
                void this.refresh().catch(this.report);
            } else if (msg.type === 'nodeSelected' && typeof msg.nodeId === 'string') {
                // Resolve IDs against the host's current graph, never trust a webview-supplied URI/range.
                void this.navigate({ kind: 'node', nodeId: msg.nodeId }).catch(this.report);
            } else if (msg.type === 'workflowSelected' && typeof msg.workflowName === 'string') {
                void this.navigate({ kind: 'workflow', workflowName: msg.workflowName }).catch(this.report);
            } else if (msg.type === 'openRelatedFile' && typeof msg.uri === 'string') {
                void this.navigate({ kind: 'file', uri: msg.uri }).catch(this.report);
            } else if (msg.type === 'setAutoReload' && typeof msg.enabled === 'boolean') {
                surface.autoReload = msg.enabled;
                if (msg.enabled) void this.refresh().catch(this.report);
            }
        });
        const disposed = onDispose(() => {
            this.surfaces.delete(surface);
            receiver.dispose();
            disposed.dispose();
        });
        this.disposables.push(receiver, disposed);
        webview.html = secureHtml(readFileSync(this.context.asAbsolutePath('dist/index.html'), 'utf8'));
    }

    setGraph(document: GraphDocument, automatic = false): void {
        this.document = document;
        for (const surface of this.surfaces) {
            if (surface.ready && (!automatic || surface.autoReload))
                void surface.webview.postMessage({ type: 'setGraph', document });
        }
    }

    selectNode(nodeId?: string): void {
        for (const surface of this.surfaces) {
            if (surface.ready)
                void surface.webview.postMessage(nodeId ? { type: 'selectNode', nodeId } : { type: 'clearSelection' });
        }
    }

    dispose(): void {
        this.panel?.dispose();
        for (const disposable of this.disposables) disposable.dispose();
        this.surfaces.clear();
    }
}
