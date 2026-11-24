import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { GraphDocument, RunRequest } from '@siglo/ide-protocol';

export class ExecutionSession implements vscode.Disposable {
    private child?: ChildProcess;
    private pending = false;
    private disposed = false;
    private runId?: string;
    constructor(
        private context: vscode.ExtensionContext,
        private post: (event: unknown) => void,
    ) {}
    async run(request: RunRequest, document?: GraphDocument): Promise<void> {
        if (this.pending || this.child) return;
        this.pending = true;
        this.runId = request.runId;
        try {
            if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running project code.');
            if (!document || document.uri !== request.uri) throw new Error('Reload the workflow before running.');
            if (vscode.workspace.textDocuments.some(doc => doc.isDirty))
                throw new Error('Save modified source files before running.');
            const source = await vscode.workspace.openTextDocument(vscode.Uri.parse(document.uri));
            if (source.version !== document.documentVersion) throw new Error('Reload the workflow before running.');
            if (this.disposed || this.runId !== request.runId) return;
            const cwd = vscode.workspace.getWorkspaceFolder(source.uri)?.uri.fsPath;
            const child = spawn(process.execPath, [this.context.asAbsolutePath('dist/supervisor.cjs')], {
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            this.child = child;
            if (!child.stdout || !child.stderr || !child.stdin) {
                child.kill();
                this.child = undefined;
                throw new Error('Execution process streams are unavailable.');
            }
            let terminal = false;
            createInterface({ input: child.stdout }).on('line', line => {
                try {
                    const event: unknown = JSON.parse(line);
                    if (
                        typeof event === 'object' &&
                        event !== null &&
                        !Array.isArray(event) &&
                        typeof (event as { status?: unknown }).status === 'string'
                    ) {
                        const status = (event as { status: string }).status;
                        if (status === 'completed' || status === 'failed' || status === 'cancelled') terminal = true;
                        this.post(event);
                    }
                } catch {
                    /* Non-protocol output is not evaluated. */
                }
            });
            child.stderr.on('data', bytes =>
                this.post({ type: 'runEvent', runId: request.runId, status: 'log', log: bytes.toString() }),
            );
            child.on('error', error => {
                terminal = true;
                this.fail(request.runId, error.message);
            });
            child.on('exit', () => {
                if (this.child === child) this.child = undefined;
                if (!terminal && !this.disposed) this.fail(request.runId, 'Execution process stopped unexpectedly.');
            });
            child.stdin.write(JSON.stringify({ ...request, document, source: source.getText(), cwd }) + '\n');
        } catch (error) {
            this.fail(request.runId, error instanceof Error ? error.message : String(error));
        } finally {
            this.pending = false;
        }
    }
    private fail(runId: string, error: string): void {
        this.post({ type: 'runEvent', runId, status: 'failed', error });
    }
    cancel(): void {
        if (this.child) this.child.stdin?.write(JSON.stringify({ type: 'cancel' }) + '\n');
        else if (this.pending) {
            if (this.runId) this.post({ type: 'runEvent', runId: this.runId, status: 'cancelled' });
            this.runId = undefined;
        }
    }
    dispose(): void {
        this.disposed = true;
        this.child?.kill();
        this.child = undefined;
    }
}
