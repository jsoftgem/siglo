import { IncomingMessage, Server as HttpServer } from 'http';
import { Socket } from 'net';
import * as crypto from 'crypto';
import { WorkflowExecutionEvent, redactEvent, RedactionOptions } from 'siglo';
import { MonitorClientMessage } from '../types';

export interface WSClient {
    id: string;
    socket: Socket;
    namespace?: string;
}

const WS_MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WebSocketBroadcaster {
    private clients: Set<WSClient> = new Set();
    private redaction?: RedactionOptions;
    private onClientMessageCallback?: (message: MonitorClientMessage, client: WSClient) => void;
    private authenticateCallback?: (req: IncomingMessage) => boolean;
    private allowRemoteResume: boolean;

    constructor(options?: {
        redaction?: RedactionOptions;
        onClientMessage?: (message: MonitorClientMessage, client: WSClient) => void;
        authenticate?: (req: IncomingMessage) => boolean;
        allowRemoteResume?: boolean;
    }) {
        this.redaction = options?.redaction;
        this.onClientMessageCallback = options?.onClientMessage;
        this.authenticateCallback = options?.authenticate;
        this.allowRemoteResume = options?.allowRemoteResume !== undefined ? options.allowRemoteResume : true;
    }

    attach(server: HttpServer, path: string = '/ws'): void {
        server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
            const pathname = req.url ? new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname : '';
            if (pathname !== path) {
                return;
            }

            // Auth verification if configured
            if (this.authenticateCallback && !this.authenticateCallback(req)) {
                socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }

            const key = req.headers['sec-websocket-key'];
            if (!key || typeof key !== 'string') {
                socket.destroy();
                return;
            }

            const acceptKey = crypto
                .createHash('sha1')
                .update(key + WS_MAGIC_STRING)
                .digest('base64');

            const responseHeaders = [
                'HTTP/1.1 101 Switching Protocols',
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Accept: ${acceptKey}`,
                '\r\n'
            ].join('\r\n');

            socket.write(responseHeaders);

            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            const namespace = url.searchParams.get('namespace') || undefined;

            const client: WSClient = {
                id: Math.random().toString(36).substring(2, 11),
                socket,
                namespace
            };

            this.clients.add(client);
            this.setupSocket(client);
        });
    }

    private setupSocket(client: WSClient): void {
        let buffer = Buffer.alloc(0);

        client.socket.on('data', (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);

            while (buffer.length >= 2) {
                const firstByte = buffer[0];
                const secondByte = buffer[1];

                const opcode = firstByte & 0x0f;
                const isMasked = (secondByte & 0x80) === 0x80;
                let payloadLength = secondByte & 0x7f;
                let offset = 2;

                if (payloadLength === 126) {
                    if (buffer.length < 4) return;
                    payloadLength = buffer.readUInt16BE(2);
                    offset = 4;
                } else if (payloadLength === 127) {
                    if (buffer.length < 10) return;
                    payloadLength = Number(buffer.readBigUInt64BE(2));
                    offset = 10;
                }

                let maskKey: Buffer | null = null;
                if (isMasked) {
                    if (buffer.length < offset + 4) return;
                    maskKey = buffer.subarray(offset, offset + 4);
                    offset += 4;
                }

                if (buffer.length < offset + payloadLength) {
                    return; // Wait for full frame
                }

                let payload = buffer.subarray(offset, offset + payloadLength);
                buffer = buffer.subarray(offset + payloadLength);

                let decodedPayload: Buffer;
                if (isMasked && maskKey) {
                    decodedPayload = Buffer.alloc(payload.length);
                    for (let i = 0; i < payload.length; i++) {
                        decodedPayload[i] = payload[i] ^ maskKey[i % 4];
                    }
                } else {
                    decodedPayload = payload;
                }

                if (opcode === 0x08) {
                    // Close frame
                    this.removeClient(client);
                    client.socket.end();
                    return;
                } else if (opcode === 0x09) {
                    // Ping -> reply with Pong
                    this.sendPong(client.socket, decodedPayload);
                } else if (opcode === 0x01) {
                    // Text frame
                    const text = decodedPayload.toString('utf8');
                    this.handleMessage(client, text);
                }
            }
        });

        client.socket.on('error', () => {
            this.removeClient(client);
        });

        client.socket.on('close', () => {
            this.removeClient(client);
        });
    }

    private handleMessage(client: WSClient, text: string): void {
        try {
            const parsed = JSON.parse(text) as MonitorClientMessage;
            if (parsed.action === 'subscribe' && parsed.namespace) {
                client.namespace = parsed.namespace;
            } else if (parsed.action === 'resume' && parsed.stackId && this.allowRemoteResume) {
                // Delegated to onClientMessageCallback
            }

            if (this.onClientMessageCallback) {
                this.onClientMessageCallback(parsed, client);
            }
        } catch {
            // Ignore non-json client payloads
        }
    }

    private sendPong(socket: Socket, payload: Buffer): void {
        const frame = Buffer.concat([
            Buffer.from([0x8a, payload.length]),
            payload
        ]);
        try {
            socket.write(frame);
        } catch {
            // ignore
        }
    }

    broadcast(event: WorkflowExecutionEvent): void {
        if (!event) return;

        const sanitized = redactEvent(event, this.redaction);
        const data = JSON.stringify(sanitized);
        const frame = this.encodeTextFrame(data);

        for (const client of Array.from(this.clients)) {
            if (client.namespace && sanitized.namespace && client.namespace !== sanitized.namespace) {
                continue;
            }
            try {
                client.socket.write(frame);
            } catch {
                this.removeClient(client);
            }
        }
    }

    send(client: WSClient, message: any): void {
        const text = typeof message === "string" ? message : JSON.stringify(message);
        const frame = this.encodeTextFrame(text);
        try {
            client.socket.write(frame);
        } catch {
            this.removeClient(client);
        }
    }

    private encodeTextFrame(text: string): Buffer {
        const payload = Buffer.from(text, 'utf8');
        const length = payload.length;

        if (length < 126) {
            return Buffer.concat([
                Buffer.from([0x81, length]),
                payload
            ]);
        } else if (length < 65536) {
            const header = Buffer.alloc(4);
            header[0] = 0x81;
            header[1] = 126;
            header.writeUInt16BE(length, 2);
            return Buffer.concat([header, payload]);
        } else {
            const header = Buffer.alloc(10);
            header[0] = 0x81;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(length), 2);
            return Buffer.concat([header, payload]);
        }
    }

    removeClient(client: WSClient): void {
        this.clients.delete(client);
    }

    getClientCount(): number {
        return this.clients.size;
    }

    close(): void {
        for (const client of Array.from(this.clients)) {
            try {
                client.socket.destroy();
            } catch {
                // ignore
            }
        }
        this.clients.clear();
    }
}
