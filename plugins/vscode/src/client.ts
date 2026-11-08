import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequest, isJsonRpcResponse, PROTOCOL_METHODS } from '@siglo/ide-protocol';

interface Pending {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}

/** Newline-delimited JSON-RPC transport. Only the bundled analyzer is executable. */
export class AnalyzerClient {
    private child?: ChildProcessWithoutNullStreams;
    private starting?: Promise<void>;
    private pending = new Map<number, Pending>();
    private nextId = 0;
    private stopped = false;
    private restartTimer?: ReturnType<typeof setTimeout>;
    private failures = 0;

    constructor(
        private readonly bin: string,
        private readonly rootUri: () => string,
        private readonly trusted: () => boolean,
        private readonly log: (message: string) => void,
        private readonly restarted: () => void = () => {},
        private readonly timeoutMs = 10_000,
    ) {}

    async request<T>(method: string, params: unknown): Promise<T> {
        await this.start();
        return this.send<T>(method, params);
    }

    private start(): Promise<void> {
        if (this.stopped) return Promise.reject(new Error('Analyzer client disposed'));
        if (!this.trusted()) return Promise.reject(new Error('Trust this workspace to enable Siglo analysis.'));
        if (this.starting) return this.starting;
        if (this.child) return Promise.resolve();
        this.starting = this.launch().finally(() => {
            this.starting = undefined;
        });
        return this.starting;
    }

    private async launch(): Promise<void> {
        clearTimeout(this.restartTimer);
        const child = spawn(process.execPath, [this.bin], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', NODE_PATH: '' },
        });
        this.child = child;
        const lines = createInterface({ input: child.stdout });
        lines.on('line', line => {
            try {
                const response: unknown = JSON.parse(line);
                if (!isJsonRpcResponse(response) || typeof response.id !== 'number') return;
                const pending = this.pending.get(response.id);
                if (!pending) return;
                clearTimeout(pending.timer);
                this.pending.delete(response.id);
                if (response.error) pending.reject(new Error(response.error.message));
                else pending.resolve(response.result);
            } catch {
                this.log('Ignored malformed analyzer output');
            }
        });
        child.stderr.on('data', chunk => this.log(String(chunk).trim()));
        const failed = (error: Error) => {
            if (this.child !== child) return;
            this.child = undefined;
            lines.close();
            this.rejectPending(error);
            if (!this.stopped) {
                this.log(error.message);
                const delay = Math.min(500 * 2 ** this.failures++, 30_000);
                this.restartTimer = setTimeout(() => {
                    if (!this.trusted()) return;
                    void this.start().then(
                        () => this.restarted(),
                        err => this.log(String(err)),
                    );
                }, delay);
            }
        };
        child.on('error', failed);
        child.on('exit', (code, signal) => failed(new Error(`Analyzer exited (${signal ?? code})`)));
        child.stdin.on('error', err => {
            failed(err);
            child.kill();
        });
        try {
            await this.send(PROTOCOL_METHODS.INITIALIZE, {
                clientName: 'siglo-vscode',
                clientVersion: '1.2.0',
                rootUri: this.rootUri(),
                capabilities: { dynamicRefresh: true },
            });
            this.failures = 0;
        } catch (error) {
            failed(error instanceof Error ? error : new Error(String(error)));
            child.kill();
            throw error;
        }
    }

    private send<T>(method: string, params: unknown): Promise<T> {
        const child = this.child;
        if (!child) return Promise.reject(new Error('Analyzer is unavailable'));
        const id = ++this.nextId;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Analyzer request timed out: ${method}`));
                child.kill();
            }, this.timeoutMs);
            this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
            child.stdin.write(JSON.stringify(createRequest(id, method, params)) + '\n', err => {
                if (!err) return;
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err);
                child.kill();
            });
        });
    }

    private rejectPending(error: Error): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    dispose(): void {
        this.stopped = true;
        clearTimeout(this.restartTimer);
        const child = this.child;
        if (child) {
            child.stdin.end(JSON.stringify(createRequest(++this.nextId, PROTOCOL_METHODS.SHUTDOWN, {})) + '\n');
            const kill = setTimeout(() => child.kill(), 500);
            kill.unref();
            child.once('exit', () => clearTimeout(kill));
        }
        this.rejectPending(new Error('Analyzer client disposed'));
    }
}
