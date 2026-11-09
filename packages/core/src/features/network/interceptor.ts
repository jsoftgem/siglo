import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import stream from 'node:stream';
import { networkPolicyStorage } from './storage';
import { isHostAllowed, isUnixSocketAllowed } from './matcher';
import { normalizeIP, isPrivateOrRestrictedIP, validateAndPinTarget } from './ip';
import { NetworkPolicyViolationException } from '../executer/exceptions';

const VALIDATED_SOCKET = Symbol.for('siglo.network.validated');

const nativeFetch = globalThis.fetch;
const nativeHttpRequest = http.request;
const nativeHttpGet = http.get;
const nativeHttpsRequest = https.request;
const nativeHttpsGet = https.get;
const nativeSocketConnect = net.Socket.prototype.connect;

let isInstalled = false;
let origFetch: typeof globalThis.fetch = nativeFetch;
let origHttpRequest: typeof http.request = nativeHttpRequest;
let origHttpGet: typeof http.get = nativeHttpGet;
let origHttpsRequest: typeof https.request = nativeHttpsRequest;
let origHttpsGet: typeof https.get = nativeHttpsGet;
let origSocketConnect: typeof net.Socket.prototype.connect = nativeSocketConnect;

class BlockedClientRequest extends http.ClientRequest {
    constructor() {
        const dummySocket = new stream.Duplex({
            read() {},
            /* c8 ignore next 3 */
            write(_chunk, _enc, cb) {
                cb();
            },
        });
        (dummySocket as any).connecting = false;
        (dummySocket as any).destroyed = false;
        (dummySocket as any).cork = () => {};
        (dummySocket as any).uncork = () => {};
        (dummySocket as any).setTimeout = () => dummySocket;
        (dummySocket as any).setNoDelay = () => dummySocket;
        (dummySocket as any).setKeepAlive = () => dummySocket;
        super({
            protocol: 'http:',
            hostname: 'localhost',
            path: '/',
            createConnection: () => dummySocket as any,
        });
    }

    override setHeader(_name: string, _value: any): this {
        return this;
    }
    override getHeader(_name: string): any {
        return undefined;
    }
    override getHeaders(): Record<string, any> {
        return {};
    }
    override getHeaderNames(): string[] {
        return [];
    }
    override hasHeader(_name: string): boolean {
        return false;
    }
    override removeHeader(_name: string): this {
        return this;
    }
    override write(_chunk: any): boolean {
        return false;
    }
    override end(): this {
        return this;
    }
    override abort(): this {
        return this;
    }
    override destroy(_err?: Error): this {
        return this;
    }
    override setTimeout(_msecs: number, _callback?: () => void): this {
        return this;
    }
    override setNoDelay(_noDelay?: boolean): this {
        return this;
    }
    override setSocketKeepAlive(_enable?: boolean, _initialDelay?: number): this {
        return this;
    }
    override flushHeaders(): void {}
}

function parseHttpArgs(args: any[], defaultProto: string): { urlString: string; host: string; port?: string | number } {
    const first = args[0];

    if (typeof first === 'string') {
        try {
            const u = new URL(first);
            return { urlString: first, host: u.host, port: u.port };
        } catch {
            return { urlString: first, host: first };
        }
    }
    if (first instanceof URL) {
        return { urlString: first.href, host: first.host, port: first.port };
    }
    if (first && typeof first === 'object') {
        const hostname = first.hostname || first.host || 'localhost';
        const port = first.port;
        const proto = first.protocol || defaultProto;
        const path = first.path || '/';
        const hostWithPort = port ? `${hostname}:${port}` : hostname;
        const urlString = `${proto}//${hostWithPort}${path}`;
        return { urlString, host: hostWithPort, port };
    }
    return { urlString: `${defaultProto}//localhost/`, host: 'localhost' };
}

function wrapLookup(existingLookup: any, store: any, target: { urlString: string; host: string }) {
    const baseLookup = existingLookup || dns.lookup;
    return (hostname: string, opts: any, cb: any) => {
        const callback = typeof opts === 'function' ? opts : cb;
        const lookupOpts = typeof opts === 'object' ? opts : {};
        baseLookup(hostname, lookupOpts, (err: any, address: any, family: any) => {
            if (err) return callback(err);
            const addrs = Array.isArray(address) ? address : [{ address, family }];
            for (const item of addrs) {
                if (isPrivateOrRestrictedIP(item.address, store.allowLocalhost)) {
                    const isExplicitlyAllowed = (store.allowedHosts || []).some((pat: any) => {
                        if (typeof pat === 'string') {
                            const normPat = normalizeIP(pat);
                            return normPat === item.address || pat === item.address;
                        }
                        return false;
                    });
                    if (!isExplicitlyAllowed) {
                        const blockErr = new NetworkPolicyViolationException(
                            store.stepName,
                            target.urlString,
                            target.host,
                            store.allowedHosts,
                            { reason: `Target host '${hostname}' resolved to restricted IP: ${item.address}` } as any,
                        );
                        return callback(blockErr);
                    }
                }
            }
            callback(null, address, family);
        });
    };
}

async function patchedFetch(input: any, init?: any): Promise<Response> {
    const store = networkPolicyStorage.getStore();
    if (!store || !store.enabled || store.inValidatedScope) {
        return origFetch!.call(globalThis, input, init);
    }

    let urlString: string;
    let urlObj: URL;
    try {
        if (typeof input === 'string') {
            urlString = input;
            urlObj = new URL(input);
        } else if (input instanceof URL) {
            urlString = input.href;
            urlObj = input;
        } else if (input && typeof input === 'object' && 'url' in input) {
            urlString = input.url;
            urlObj = new URL(input.url);
        } else {
            urlString = String(input);
            urlObj = new URL(urlString);
        }
    } catch {
        return origFetch!.call(globalThis, input, init);
    }

    const host = urlObj.host;
    const port = urlObj.port;

    if (!isHostAllowed(urlString, host, store, port)) {
        const error = new NetworkPolicyViolationException(store.stepName, urlString, host, store.allowedHosts);
        return Promise.reject(error);
    }

    await validateAndPinTarget(urlObj, store);

    let currentUrl = urlString;
    let currentInit = { ...init, redirect: 'manual' };
    const maxRedirects = 5;
    let redirectCount = 0;

    while (true) {
        const res = await networkPolicyStorage.run({ ...store, inValidatedScope: true }, () => {
            return origFetch!.call(globalThis, currentUrl, currentInit);
        });

        if ([301, 302, 303, 307, 308].includes(res.status)) {
            if (init?.redirect === 'manual') return res;
            if (init?.redirect === 'error') {
                await res.body?.cancel();
                throw new TypeError('Fetch redirect is forbidden by redirect: error');
            }
            const location = res.headers.get('location');
            if (!location) {
                return res;
            }
            redirectCount++;
            if (redirectCount > maxRedirects) {
                throw new NetworkPolicyViolationException(store.stepName, currentUrl, host, store.allowedHosts, {
                    reason: 'Maximum redirect count exceeded',
                } as any);
            }

            const targetUrlObj = new URL(location, currentUrl);
            const targetUrlString = targetUrlObj.href;
            const targetHost = targetUrlObj.host;
            const targetPort = targetUrlObj.port;

            if (!isHostAllowed(targetUrlString, targetHost, store, targetPort)) {
                throw new NetworkPolicyViolationException(
                    store.stepName,
                    targetUrlString,
                    targetHost,
                    store.allowedHosts,
                );
            }
            await validateAndPinTarget(targetUrlObj, store);

            currentUrl = targetUrlString;
            if (res.status === 303) {
                currentInit = { ...currentInit, method: 'GET', body: undefined };
            }
            continue;
        }

        return res;
    }
}

function patchedHttpRequest(...args: any[]): http.ClientRequest {
    const store = networkPolicyStorage.getStore();
    if (!store || !store.enabled || store.inValidatedScope) {
        return origHttpRequest!.apply(http, args as any);
    }

    const target = parseHttpArgs(args, 'http:');
    if (!isHostAllowed(target.urlString, target.host, store, target.port)) {
        const req = new BlockedClientRequest();
        const error = new NetworkPolicyViolationException(
            store.stepName,
            target.urlString,
            target.host,
            store.allowedHosts,
        );
        process.nextTick(() => {
            req.emit('error', error);
        });
        return req as any;
    }

    // prettier-ignore
    const opts = typeof args[0] === 'string' || args[0] instanceof URL ? (typeof args[1] === 'object' && args[1] !== null ? args[1] : {}) : (args[0] || {});
    opts.lookup = wrapLookup(opts.lookup, store, target);

    const req = origHttpRequest!.apply(http, args as any);
    req.on('socket', (socket: any) => {
        socket[VALIDATED_SOCKET] = true;
    });
    return req;
}

function patchedHttpGet(...args: any[]): http.ClientRequest {
    const req = patchedHttpRequest(...args);
    req.end();
    return req;
}

function patchedHttpsRequest(...args: any[]): http.ClientRequest {
    const store = networkPolicyStorage.getStore();
    if (!store || !store.enabled || store.inValidatedScope) {
        return origHttpsRequest!.apply(https, args as any);
    }

    const target = parseHttpArgs(args, 'https:');
    if (!isHostAllowed(target.urlString, target.host, store, target.port)) {
        const req = new BlockedClientRequest();
        const error = new NetworkPolicyViolationException(
            store.stepName,
            target.urlString,
            target.host,
            store.allowedHosts,
        );
        process.nextTick(() => {
            req.emit('error', error);
        });
        return req as any;
    }

    // prettier-ignore
    const opts = typeof args[0] === 'string' || args[0] instanceof URL ? (typeof args[1] === 'object' && args[1] !== null ? args[1] : {}) : (args[0] || {});
    opts.lookup = wrapLookup(opts.lookup, store, target);

    const req = origHttpsRequest!.apply(https, args as any);
    req.on('socket', (socket: any) => {
        socket[VALIDATED_SOCKET] = true;
    });
    return req;
}

function patchedHttpsGet(...args: any[]): http.ClientRequest {
    const req = patchedHttpsRequest(...args);
    req.end();
    return req;
}

function patchedSocketConnect(this: any, ...args: any[]): any {
    const store = networkPolicyStorage.getStore();
    if (!store || !store.enabled || this[VALIDATED_SOCKET]) {
        return origSocketConnect!.apply(this, args as any);
    }

    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    let host: string = 'localhost';
    let port: number | string | undefined;
    let isUnixSocket = false;

    if (typeof first === 'string') {
        isUnixSocket = true;
    } else if (typeof first === 'number') {
        port = first;
        if (typeof args[1] === 'string') {
            host = args[1];
        }
    } else if (first && typeof first === 'object') {
        if (first.path) {
            isUnixSocket = true;
        } else {
            host = first.host || first.hostname || 'localhost';
            port = first.port;
        }
    }

    if (isUnixSocket) {
        const socketPath = typeof first === 'string' ? first : first.path;
        if (!isUnixSocketAllowed(socketPath, store.allowUnixSockets)) {
            const error = new NetworkPolicyViolationException(
                store.stepName,
                `unix://${socketPath}`,
                socketPath,
                store.allowedHosts || [],
            );
            process.nextTick(() => {
                this.destroy(error);
            });
            return this;
        }
        return origSocketConnect!.apply(this, args as any);
    }

    const hostWithPort = port ? `${host}:${port}` : host;

    // Defense-in-depth against DNS rebinding (TOCTOU):
    // Even if within inValidatedScope, verify that the target host/IP is not
    // resolving to a private/restricted IP (e.g. AWS metadata 169.254.169.254, loopback 127.0.0.1)
    // unless explicitly allowed in allowedHosts or allowLocalhost is enabled.
    const normIp = normalizeIP(host);
    if (normIp && isPrivateOrRestrictedIP(normIp, store.allowLocalhost)) {
        const isExplicitlyAllowed = (store.allowedHosts || []).some(pat => {
            if (typeof pat === 'string') {
                const normPat = normalizeIP(pat);
                return normPat === normIp || pat === normIp;
            }
            return false;
        });
        if (!isExplicitlyAllowed) {
            const error = new NetworkPolicyViolationException(
                store.stepName,
                `tcp://${hostWithPort}`,
                host,
                store.allowedHosts,
                { reason: `Socket destination resolved to restricted IP: ${normIp}` } as any,
            );
            process.nextTick(() => {
                this.destroy(error);
            });
            return this;
        }
    }

    if (store.inValidatedScope) {
        return origSocketConnect!.apply(this, args as any);
    }

    if (!isHostAllowed(`tcp://${hostWithPort}`, host, store, port)) {
        const error = new NetworkPolicyViolationException(
            store.stepName,
            `tcp://${hostWithPort}`,
            host,
            store.allowedHosts,
        );
        process.nextTick(() => {
            this.destroy(error);
        });
        return this;
    }

    this[VALIDATED_SOCKET] = true;
    return origSocketConnect!.apply(this, args as any);
}

export function installNetworkInterceptors(): void {
    if (isInstalled) return;

    if (globalThis.fetch !== patchedFetch) {
        origFetch = globalThis.fetch;
    }
    if (http.request !== patchedHttpRequest) {
        origHttpRequest = http.request;
    }
    if (http.get !== patchedHttpGet) {
        origHttpGet = http.get;
    }
    if (https.request !== patchedHttpsRequest) {
        origHttpsRequest = https.request;
    }
    if (https.get !== patchedHttpsGet) {
        origHttpsGet = https.get;
    }
    if (net.Socket.prototype.connect !== patchedSocketConnect) {
        origSocketConnect = net.Socket.prototype.connect;
    }

    globalThis.fetch = patchedFetch;
    http.request = patchedHttpRequest;
    http.get = patchedHttpGet;
    https.request = patchedHttpsRequest;
    https.get = patchedHttpsGet;
    net.Socket.prototype.connect = patchedSocketConnect;

    isInstalled = true;
}

export function uninstallNetworkInterceptors(): void {
    if (!isInstalled) return;

    globalThis.fetch = origFetch || nativeFetch;
    http.request = origHttpRequest || nativeHttpRequest;
    http.get = origHttpGet || nativeHttpGet;
    https.request = origHttpsRequest || nativeHttpsRequest;
    https.get = origHttpsGet || nativeHttpsGet;
    net.Socket.prototype.connect = origSocketConnect || nativeSocketConnect;

    origFetch = nativeFetch;
    origHttpRequest = nativeHttpRequest;
    origHttpGet = nativeHttpGet;
    origHttpsRequest = nativeHttpsRequest;
    origHttpsGet = nativeHttpsGet;
    origSocketConnect = nativeSocketConnect;

    try {
        networkPolicyStorage.disable();
    } catch {}
    isInstalled = false;
}

export function isNetworkInterceptorsInstalled(): boolean {
    return isInstalled;
}

export function ensureNetworkInterceptorsInstalled(): void {
    if (!isInstalled) {
        installNetworkInterceptors();
    }
}
