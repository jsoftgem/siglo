import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { networkPolicyStorage } from './storage';
import { isHostAllowed } from './matcher';
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

class BlockedClientRequest extends EventEmitter {
    setHeader() { return this; }
    getHeader() { return undefined; }
    getHeaders() { return {}; }
    getHeaderNames() { return []; }
    hasHeader() { return false; }
    removeHeader() { return this; }
    write() { return false; }
    end() { return this; }
    abort() { return this; }
    destroy(_err?: Error) { return this; }
    setTimeout() { return this; }
    setNoDelay() { return this; }
    setSocketKeepAlive() { return this; }
    flushHeaders() { return this; }
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

function patchedFetch(input: any, init?: any): Promise<Response> {
    const store = networkPolicyStorage.getStore();
    if (!store || !store.enabled) {
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
        const error = new NetworkPolicyViolationException(
            store.stepName,
            urlString,
            host,
            store.allowedHosts
        );
        return Promise.reject(error);
    }

    return networkPolicyStorage.run({ ...store, inValidatedScope: true }, () => {
        return origFetch!.call(globalThis, input, init);
    });
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
            store.allowedHosts
        );
        process.nextTick(() => {
            req.emit('error', error);
        });
        return req as any;
    }

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
            store.allowedHosts
        );
        process.nextTick(() => {
            req.emit('error', error);
        });
        return req as any;
    }

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
    if (!store || !store.enabled || store.inValidatedScope || this[VALIDATED_SOCKET]) {
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
        return origSocketConnect!.apply(this, args as any);
    }

    const hostWithPort = port ? `${host}:${port}` : host;
    if (!isHostAllowed(`tcp://${hostWithPort}`, host, store, port)) {
        const error = new NetworkPolicyViolationException(
            store.stepName,
            `tcp://${hostWithPort}`,
            host,
            store.allowedHosts
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
