import { IncomingMessage, ServerResponse } from 'http';
import { WorkflowExecutionEvent, redactEvent, RedactionOptions } from 'siglo';

export interface SSEClient {
    id: string;
    res: ServerResponse;
    namespace?: string;
}

export class SSEBroadcaster {
    private clients: Set<SSEClient> = new Set();
    private redaction?: RedactionOptions;
    private heartbeatTimer?: NodeJS.Timeout;

    constructor(options?: {
        redaction?: RedactionOptions;
        heartbeatIntervalMs?: number;
    }) {
        this.redaction = options?.redaction;
        const interval = options?.heartbeatIntervalMs || 15000;
        this.heartbeatTimer = setInterval(() => {
            this.sendHeartbeat();
        }, interval);
    }

    addClient(res: ServerResponse, namespace?: string): SSEClient {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        const client: SSEClient = {
            id: Math.random().toString(36).slice(2),
            res,
            namespace
        };

        this.clients.add(client);

        // Send connected handshake
        res.write(`: connected\\n\\n`);

        res.on('close', () => {
            this.removeClient(client);
        });

        res.on('error', () => {
            this.removeClient(client);
        });

        return client;
    }

    removeClient(client: SSEClient): void {
        this.clients.delete(client);
    }

    broadcast(event: WorkflowExecutionEvent): void {
        if (!event) return;

        const sanitized = redactEvent(event, this.redaction);
        const data = JSON.stringify(sanitized);
        const message = `event: ${sanitized.type}\\ndata: ${data}\\n\\n`;

        for (const client of Array.from(this.clients)) {
            if (client.namespace && sanitized.namespace && client.namespace !== sanitized.namespace) {
                continue;
            }
            try {
                client.res.write(message);
            } catch {
                this.removeClient(client);
            }
        }
    }

    sendHeartbeat(): void {
        for (const client of Array.from(this.clients)) {
            try {
                client.res.write(':keepalive\\n\\n');
            } catch {
                this.removeClient(client);
            }
        }
    }

    getClientCount(): number {
        return this.clients.size;
    }

    close(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        for (const client of Array.from(this.clients)) {
            try {
                client.res.end();
            } catch {
                // ignore
            }
        }
        this.clients.clear();
    }
}

export function createSSEHandler(broadcaster: SSEBroadcaster) {
    return (req: IncomingMessage, res: ServerResponse): void => {
        const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
        const namespace = url.searchParams.get('namespace') || undefined;
        broadcaster.addClient(res, namespace);
    };
}
