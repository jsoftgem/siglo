import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { request } from 'node:https';
/** Conservative public-address policy. Internal destinations require a trusted custom transport. */
export function isPublicNotificationAddress(address: string): boolean {
    const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
    if (isIP(ip) === 4) {
        const [a, b, c] = ip.split('.').map(Number);
        return !(
            a === 0 ||
            a === 10 ||
            a === 127 ||
            a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
            (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
            (a === 203 && b === 0 && c === 113)
        );
    }
    if (isIP(ip) === 6) {
        // Accept global unicast only; reject mapped IPv4, loopback, ULA, link-local,
        // multicast, transition/special-use space and documentation prefixes.
        const normalized = new URL(`https://[${ip}]/`).hostname.slice(1, -1);
        const [first, second] = normalized.split(':').map(value => parseInt(value || '0', 16));
        return (
            first >= 0x2000 &&
            first < 0x3fff &&
            first !== 0x2002 &&
            !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8))
        );
    }
    return false;
}
/** The lookup result returned here is the address used by the socket, not a preflight lookup. */
export const publicNotificationLookup: typeof lookup = ((hostname: string, options: any, callback: any) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
        if (error) {
            callback(error);
            return;
        }
        if (!addresses.length || addresses.some(entry => !isPublicNotificationAddress(entry.address))) {
            callback(new Error('Notification destination must resolve exclusively to public IP addresses'));
            return;
        }
        const candidates = options?.family ? addresses.filter(entry => entry.family === options.family) : addresses;
        if (!candidates.length) {
            callback(new Error('No public address for requested family'));
            return;
        }
        if (options?.all) callback(null, candidates);
        else callback(null, candidates[0].address, candidates[0].family);
    });
}) as typeof lookup;
/** Native HTTPS preserves hostname certificate verification/SNI while pinning validated DNS results. */
export const publicNotificationFetch = (async (input: any, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('Notification egress requires HTTPS without URL credentials');
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !isPublicNotificationAddress(literal))
        throw new Error('Private notification destination forbidden');
    return new Promise<Response>((resolve, reject) => {
        const requestHeaders: Record<string, string> = {};
        new Headers(init.headers).forEach((value, key) => {
            requestHeaders[key] = value;
        });
        const req = request(
            url,
            {
                method: init.method ?? 'POST',
                headers: requestHeaders,
                lookup: publicNotificationLookup,
                agent: false,
                signal: init.signal ?? undefined,
                timeout: 30000,
            },
            response => {
                if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) {
                    response.destroy();
                    reject(new Error('Notification redirects are forbidden'));
                    return;
                }
                const chunks: Buffer[] = [];
                let bytes = 0;
                response.on('data', chunk => {
                    bytes += chunk.length;
                    if (bytes > 1024 * 1024) {
                        response.destroy(new Error('Notification response too large'));
                        return;
                    }
                    chunks.push(Buffer.from(chunk));
                });
                response.on('error', reject);
                response.on('end', () => {
                    const headers = new Headers();
                    for (const [key, value] of Object.entries(response.headers))
                        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
                    const status = response.statusCode ?? 500;
                    resolve(
                        new Response(
                            status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks),
                            { status, headers },
                        ),
                    );
                });
            },
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Notification request timed out')));
        if (init.body) req.write(init.body);
        req.end();
    });
}) as typeof fetch;
