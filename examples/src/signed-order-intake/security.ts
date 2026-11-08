import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import type { WebhookDedupStore, WebhookProtocol } from '@siglo/crypto';

// Deliberately narrow signed-order POST profile, not a general RFC 9421 parser.
const components = '("@method" "@path" "content-digest")';
const inputPattern =
    /^sig1=\("@method" "@path" "content-digest"\);created=(\d{1,12});keyid="([A-Za-z0-9_-]{1,80})";nonce="([A-Za-z0-9_-]{16,128})"$/;
export const windowSeconds = 300; // Tutorial policy; independent of any external service.
export interface SignedRequest {
    method: string;
    target: string;
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
}
export interface ClientKey {
    publicKey: string;
    clientId: string;
    active: boolean;
}
export class RequestError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}
export function singleHeader(headers: SignedRequest['headers'], name: string): string {
    const value = headers[name];
    if (typeof value !== 'string') throw new RequestError(401, 'Invalid signed request');
    return value;
}
export function parseInput(value: string) {
    const match = inputPattern.exec(value);
    if (!match) throw new RequestError(401, 'Invalid signed request');
    return { created: Number(match[1]), keyId: match[2], nonce: match[3], params: value.slice(5) };
}
export function digest(body: string | Buffer): string {
    return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
}
export function signatureBase(method: string, path: string, contentDigest: string, params: string): string {
    return `"@method": ${method}\n"@path": ${path}\n"content-digest": ${contentDigest}\n"@signature-params": ${params}`;
}
export function signRequest(
    body: Buffer,
    privateKey: string,
    options: {
        nonce: string;
        created: number;
        keyId?: string;
        method?: string;
        target?: string;
    },
): SignedRequest {
    const method = options.method ?? 'POST';
    const target = options.target ?? '/orders';
    const params = `${components};created=${options.created};keyid="${options.keyId ?? 'shop-demo-key'}";nonce="${options.nonce}"`;
    const contentDigest = digest(body);
    // RFC 9421 Ed25519 signatures use raw signature bytes and standard Base64.
    const signature = sign(null, Buffer.from(signatureBase(method, target, contentDigest, params)), privateKey);
    return {
        method,
        target,
        rawBody: body,
        headers: {
            'content-type': 'application/json',
            'content-digest': contentDigest,
            'signature-input': `sig1=${params}`,
            signature: `sig1=:${signature.toString('base64')}:`,
        },
    };
}
export function resolveClient(request: SignedRequest, keys: ReadonlyMap<string, ClientKey>): ClientKey {
    const { keyId } = parseInput(singleHeader(request.headers, 'signature-input'));
    const key = keys.get(keyId);
    if (!key?.active) throw new RequestError(401, 'Invalid signed request');
    return key;
}
export function createRequestProtocol(
    request: SignedRequest,
    client: ClientKey,
    nonces: WebhookDedupStore,
    now = () => Date.now(),
): WebhookProtocol {
    return {
        name: 'signed-order-post-profile',
        async verify({ secret, rawPayload, headers, signatureHeader }) {
            const input = parseInput(singleHeader(headers, 'signature-input'));
            if (request.method !== 'POST' || request.target !== '/orders') return false;
            if (Math.abs(Math.floor(now() / 1000) - input.created) > windowSeconds) return false;
            const contentDigest = singleHeader(headers, 'content-digest');
            if (contentDigest !== digest(rawPayload)) return false;
            const match = /^sig1=:([A-Za-z0-9+/]+={0,2}):$/.exec(signatureHeader);
            if (!match) return false;
            const signature = Buffer.from(match[1], 'base64');
            if (signature.length !== 64 || signature.toString('base64') !== match[1]) return false;
            const key = createPublicKey(secret);
            if (key.asymmetricKeyType !== 'ed25519') return false;
            if (
                !verify(
                    null,
                    Buffer.from(signatureBase(request.method, request.target, contentDigest, input.params)),
                    key,
                    signature,
                )
            )
                return false;
            // Claim only after authentication, scoped by client rather than key/signature.
            // Include the entire possible future timestamp acceptance interval.
            return nonces.claim(`${client.clientId}:${input.nonce}`, 2 * windowSeconds + 1);
        },
    };
}
// Exact TTLs keep the tutorial's replay window explicit. Single process only.
export class LocalNonceStore implements WebhookDedupStore {
    private readonly expires = new Map<string, number>();
    constructor(private readonly now = () => Date.now()) {}
    claim(key: string, ttlSeconds: number): boolean {
        const now = this.now();
        for (const [id, expiry] of this.expires) if (expiry <= now) this.expires.delete(id);
        if (this.expires.has(key)) return false;
        this.expires.set(key, now + ttlSeconds * 1000);
        return true;
    }
}
