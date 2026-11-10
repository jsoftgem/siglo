import * as vscode from 'vscode';
import { AnalyzerClient } from './client';
import { NavigationTarget, WorkflowViews } from './webview';
import { GraphDocument, GraphNode, PROTOCOL_METHODS, SourceRange } from '@siglo/ide-protocol';

const languages = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);
const supported = (document: vscode.TextDocument) =>
    languages.has(document.languageId) && ['file', 'untitled'].includes(document.uri.scheme);
const range = (location: SourceRange) =>
    new vscode.Range(location.start.line, location.start.character, location.end.line, location.end.character);
const nodes = (graph: GraphDocument): GraphNode[] => [
    ...new Map(
        [...graph.nodes, ...(graph.workflows ?? []).flatMap(workflow => workflow.nodes)].map(node => [node.id, node]),
    ).values(),
];

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('Siglo Workflow Explorer');
    const report = (error: unknown) => {
        output.appendLine(String(error));
        void vscode.window.showWarningMessage(`Siglo: ${error instanceof Error ? error.message : String(error)}`);
    };
    let active = vscode.window.activeTextEditor?.document;
    let graph: GraphDocument | undefined;
    let generation = 0;
    let edits: ReturnType<typeof setTimeout> | undefined;
    let selection: ReturnType<typeof setTimeout> | undefined;

    const client = new AnalyzerClient(
        context.asAbsolutePath('dist/analyzer.js'),
        () =>
            (active && vscode.workspace.getWorkspaceFolder(active.uri)?.uri.toString()) ??
            vscode.workspace.workspaceFolders?.[0]?.uri.toString() ??
            '',
        () => vscode.workspace.isTrusted,
        message => output.appendLine(message),
        () => {
            void refresh().catch(report);
        },
    );

    async function refresh(automatic = false): Promise<void> {
        const ticket = ++generation;
        const document = active;
        if (!vscode.workspace.isTrusted || !document || !supported(document)) {
            graph = undefined;
            views.setGraph({
                uri: '',
                documentVersion: 0,
                workflowName: vscode.workspace.isTrusted
                    ? 'No Workflow Selected'
                    : 'Trust this workspace to enable Siglo',
                nodes: [],
                edges: [],
                unresolved: [],
                diagnostics: [],
                workflows: [],
            });
            return;
        }
        const version = document.version;
        const result = await client.request<GraphDocument>(PROTOCOL_METHODS.GET_GRAPH, {
            uri: document.uri.toString(),
            documentVersion: version,
            content: document.getText(),
        });
        if (ticket !== generation || active !== document || document.version !== version) return;
        graph = result;
        views.setGraph(result, automatic);
        trackSelection();
    }

    async function openTarget(targetUri?: string, targetRange?: SourceRange): Promise<void> {
        if (!active) return;
        const selection = targetRange ? range(targetRange) : undefined;
        if (!targetUri || targetUri === active.uri.toString() || targetUri === graph?.uri) {
            await vscode.window.showTextDocument(active, {
                ...(selection ? { selection } : {}),
                viewColumn: vscode.ViewColumn.One,
                preview: false,
            });
            return;
        }
        const parsed = vscode.Uri.parse(targetUri);
        if (parsed.scheme !== 'file') return;
        const targetDoc = await vscode.workspace.openTextDocument(parsed);
        await vscode.window.showTextDocument(targetDoc, {
            ...(selection ? { selection } : {}),
            viewColumn: vscode.ViewColumn.One,
            preview: false,
        });
    }

    async function navigate(target: NavigationTarget): Promise<void> {
        if (!graph || !active || graph.uri !== active.uri.toString() || graph.documentVersion !== active.version)
            return;
        if (target.kind === 'node') {
            const node = nodes(graph).find(candidate => candidate.id === target.nodeId);
            if (!node) return;
            await openTarget(node.sourceUri, node.sourceLocation ?? node.location);
            return;
        }
        if (target.kind === 'workflow') {
            const wf = graph.workflows?.find(candidate => candidate.name === target.workflowName);
            const fallbackMatch = graph.workflowName === target.workflowName ? graph : undefined;
            if (!wf && !fallbackMatch) return;
            const targetUri = wf?.uri ?? fallbackMatch?.uri;
            const targetRange =
                wf?.location ?? fallbackMatch?.location ?? wf?.nodes[0]?.location ?? fallbackMatch?.nodes[0]?.location;
            await openTarget(targetUri, targetRange);
            return;
        }
        if (target.kind === 'file') {
            // Only permit URIs actually present in the host's trusted graph.
            const matchingNode = nodes(graph).find(candidate => candidate.sourceUri === target.uri);
            const matchingWorkflow = graph.workflows?.find(candidate => candidate.uri === target.uri);
            const isMainDoc = graph.uri === target.uri;
            if (!matchingNode && !matchingWorkflow && !isMainDoc) return;
            const targetRange =
                matchingNode?.sourceLocation ?? matchingWorkflow?.location ?? matchingNode?.location ?? graph.location;
            await openTarget(target.uri, targetRange);
        }
    }

    function trackSelection(): void {
        const editor = vscode.window.activeTextEditor;
        if (
            !graph ||
            !editor ||
            graph.uri !== editor.document.uri.toString() ||
            graph.documentVersion !== editor.document.version
        )
            return;
        const position = editor.selection.active;
        const candidates = nodes(graph).filter(node => range(node.location).contains(position));
        candidates.sort(
            (a, b) =>
                editor.document.offsetAt(range(a.location).end) -
                editor.document.offsetAt(range(a.location).start) -
                (editor.document.offsetAt(range(b.location).end) - editor.document.offsetAt(range(b.location).start)),
        );
        views.selectNode(candidates[0]?.id);
    }

    const views = new WorkflowViews(context, refresh, navigate, report);
    context.subscriptions.push(
        output,
        client,
        views,
        vscode.window.registerWebviewViewProvider('siglo.workflows', views),
        vscode.commands.registerCommand('siglo.openVisualizer', () => {
            views.open();
            void refresh().catch(report);
        }),
        vscode.commands.registerCommand('siglo.discoverWorkflows', async () => {
            if (!vscode.workspace.isTrusted) {
                report(new Error('Trust this workspace to enable Siglo analysis.'));
                return;
            }
            try {
                const files = await vscode.workspace.findFiles(
                    '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}',
                    '**/{node_modules,dist,.git,coverage,build,.idea}/**',
                    100,
                );
                const choices: { label: string; description: string; uri: vscode.Uri; location: SourceRange }[] = [];
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Discovering Siglo workflows',
                        cancellable: true,
                    },
                    async (_, token) => {
                        for (const uri of files) {
                            if (token.isCancellationRequested) break;
                            const document = await vscode.workspace.openTextDocument(uri);
                            const result = await client.request<GraphDocument>(PROTOCOL_METHODS.GET_GRAPH, {
                                uri: uri.toString(),
                                documentVersion: document.version,
                                content: document.getText(),
                            });
                            for (const workflow of result.workflows ?? []) {
                                const node = workflow.nodes[0];
                                if (node)
                                    choices.push({
                                        label: workflow.name,
                                        description: vscode.workspace.asRelativePath(uri, true),
                                        uri,
                                        location: node.location,
                                    });
                            }
                        }
                    },
                );
                if (!choices.length) {
                    void vscode.window.showInformationMessage(
                        'Siglo: No workflows found in the first 100 source files.',
                    );
                    return;
                }
                const picked = await vscode.window.showQuickPick(choices, {
                    placeHolder: 'Select a workflow (scan limited to 100 source files)',
                });
                if (picked) {
                    const editor = await vscode.window.showTextDocument(picked.uri, {
                        selection: range(picked.location),
                    });
                    active = editor.document;
                    views.open();
                    await refresh();
                }
            } catch (error) {
                report(error);
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(editor => {
            // Focusing a webview must preserve the source document it is displaying.
            if (!editor) return;
            clearTimeout(edits);
            active = editor.document;
            void refresh().catch(report);
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document !== active || !event.contentChanges.length) return;
            ++generation;
            clearTimeout(edits);
            edits = setTimeout(() => {
                if (event.document === active) void refresh(true).catch(report);
            }, 250);
        }),
        vscode.window.onDidChangeTextEditorSelection(event => {
            if (event.textEditor.document !== active) return;
            clearTimeout(selection);
            selection = setTimeout(trackSelection, 75);
        }),
        vscode.workspace.onDidGrantWorkspaceTrust(() => {
            void refresh().catch(report);
        }),
        {
            dispose: () => {
                ++generation;
                clearTimeout(edits);
                clearTimeout(selection);
            },
        },
    );
}

export function deactivate(): void {
    /* Context subscriptions own all resources. */
}
