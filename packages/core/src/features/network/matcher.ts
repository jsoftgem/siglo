import { EffectiveNetworkPolicy, HostPattern } from './types';
import { normalizeIP, isPrivateOrRestrictedIP } from './ip';

export function isUnixSocket(hostOrTarget: string): boolean {
    if (!hostOrTarget || typeof hostOrTarget !== 'string') {
        return false;
    }
    const clean = hostOrTarget.trim().toLowerCase();
    return clean.startsWith('unix:') || clean.startsWith('/') || clean.includes('.sock');
}

export function isUnixSocketAllowed(target: string, allowedUnixSockets?: string[]): boolean {
    if (!allowedUnixSockets || !Array.isArray(allowedUnixSockets) || allowedUnixSockets.length === 0) {
        return false;
    }
    const clean = target.trim();
    const normalized = clean.startsWith('unix:') ? clean.slice(5) : clean;
    for (const pat of allowedUnixSockets) {
        const normPat = pat.trim();
        if (normPat === '*') return true;
        if (normPat === normalized || normalized.startsWith(normPat)) return true;
    }
    return false;
}

export function isLocalhost(hostOrTarget: string): boolean {
    if (!hostOrTarget || typeof hostOrTarget !== 'string') {
        return false;
    }
    const clean = hostOrTarget.trim().toLowerCase();

    // Strip protocol if present
    const withoutProto = clean.replace(/^[a-z]+:\/\//, '');

    // Extract hostname portion
    let hostname = withoutProto;
    if (withoutProto.startsWith('[')) {
        const endBracket = withoutProto.indexOf(']');
        if (endBracket !== -1) {
            hostname = withoutProto.slice(1, endBracket);
        }
    } else {
        const slashIdx = withoutProto.indexOf('/');
        const hostPart = slashIdx !== -1 ? withoutProto.slice(0, slashIdx) : withoutProto;
        const firstColon = hostPart.indexOf(':');
        const lastColon = hostPart.lastIndexOf(':');
        hostname = (firstColon !== -1 && firstColon === lastColon)
            ? hostPart.slice(0, firstColon)
            : hostPart;
    }

    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
        return true;
    }

    const normIp = normalizeIP(hostname);
    if (normIp) {
        if (normIp.startsWith('127.') || normIp === '0.0.0.0' || normIp === '::1' || normIp === '::') {
            return true;
        }
    }

    return false;
}

export function parseHostAndPort(rawHost: string, defaultPort?: string | number): {
    hostname: string;
    port?: string;
    hostWithPort: string;
} {
    if (!rawHost || typeof rawHost !== 'string') {
        return { hostname: '', hostWithPort: '' };
    }
    const clean = rawHost.trim().toLowerCase().replace(/^[a-z]+:\/\//, '');
    const slashIdx = clean.indexOf('/');
    const hostPart = slashIdx !== -1 ? clean.slice(0, slashIdx) : clean;

    let hostname = hostPart;
    let port = defaultPort !== undefined ? String(defaultPort) : undefined;

    if (hostPart.startsWith('[')) {
        const endBracket = hostPart.indexOf(']');
        if (endBracket !== -1) {
            hostname = hostPart.slice(1, endBracket);
            const rest = hostPart.slice(endBracket + 1);
            if (rest.startsWith(':')) {
                port = rest.slice(1);
            }
        }
    } else {
        const colonIdx = hostPart.lastIndexOf(':');
        if (colonIdx !== -1) {
            const possiblePort = hostPart.slice(colonIdx + 1);
            if (!isNaN(Number(possiblePort))) {
                hostname = hostPart.slice(0, colonIdx);
                port = possiblePort;
            }
        }
    }

    const hostWithPort = port ? `${hostname}:${port}` : hostname;
    return { hostname, port, hostWithPort };
}

export function matchesPattern(
    targetHost: string,
    targetHostname: string,
    targetPort: string | undefined,
    pattern: HostPattern
): boolean {
    const normTargetHostname = (targetHostname || '').toLowerCase();
    const normTargetHost = (targetHost || '').toLowerCase();

    if (pattern instanceof RegExp) {
        return pattern.test(normTargetHostname) || pattern.test(normTargetHost);
    }

    if (typeof pattern !== 'string') {
        return false;
    }

    const pat = pattern.trim().toLowerCase();
    if (pat === '*') {
        return true;
    }
    if (!pat) {
        return false;
    }

    let patHost = pat;
    let patPort: string | undefined;

    if (pat.startsWith('[')) {
        const endBracket = pat.indexOf(']');
        if (endBracket !== -1) {
            patHost = pat.slice(1, endBracket);
            const rest = pat.slice(endBracket + 1);
            if (rest.startsWith(':')) {
                patPort = rest.slice(1);
            }
        }
    } else {
        const colonIdx = pat.lastIndexOf(':');
        if (colonIdx !== -1) {
            const possiblePort = pat.slice(colonIdx + 1);
            if (!isNaN(Number(possiblePort))) {
                patHost = pat.slice(0, colonIdx);
                patPort = possiblePort;
            }
        }
    }

    if (patPort !== undefined) {
        if (!targetPort || targetPort !== patPort) {
            return false;
        }
    }

    // Canonical IP matching across alternative encodings
    const normTargetIP = normalizeIP(normTargetHostname);
    const normPatIP = normalizeIP(patHost);
    if (normTargetIP && normPatIP) {
        return normTargetIP === normPatIP;
    }

    if (patHost.startsWith('*.')) {
        const suffix = patHost.slice(1); // e.g. '.stripe.com'
        const baseDomain = patHost.slice(2); // e.g. 'stripe.com'
        return normTargetHostname.endsWith(suffix) && normTargetHostname !== baseDomain;
    }

    return normTargetHostname === patHost;
}

export function isHostAllowed(
    requestedUrl: string,
    requestedHost: string,
    policy: EffectiveNetworkPolicy,
    port?: string | number
): boolean {
    if (!policy || !policy.enabled) {
        return true;
    }

    if (policy.flowPolicy && policy.stepPolicy) {
        return isHostAllowed(requestedUrl, requestedHost, policy.flowPolicy, port) &&
               isHostAllowed(requestedUrl, requestedHost, policy.stepPolicy, port);
    }

    // Unix domain sockets check
    if (isUnixSocket(requestedHost) || isUnixSocket(requestedUrl)) {
        const rawTarget = requestedHost && isUnixSocket(requestedHost) ? requestedHost : requestedUrl;
        const targetPath = rawTarget.startsWith('unix:') ? rawTarget.slice(5) : rawTarget;
        return isUnixSocketAllowed(targetPath, policy.allowUnixSockets);
    }

    // Localhost check (defaults to false)
    const allowLocalhost = policy.allowLocalhost === true;
    if (allowLocalhost && (isLocalhost(requestedHost) || isLocalhost(requestedUrl))) {
        return true;
    }

    const { hostname, port: parsedPort, hostWithPort } = parseHostAndPort(requestedHost, port);

    // If host is an IP address, check for private/restricted ranges
    const normIp = normalizeIP(hostname);
    if (normIp) {
        const isRestricted = isPrivateOrRestrictedIP(normIp, allowLocalhost);
        if (isRestricted) {
            const allowedHosts = policy.allowedHosts || [];
            for (const pattern of allowedHosts) {
                if (pattern === '*') continue;
                if (matchesPattern(hostWithPort, hostname, parsedPort, pattern)) {
                    return true;
                }
            }
            return false;
        }
    } else {
        // If it's a localhost hostname (e.g. 'localhost' or 'api.localhost') and allowLocalhost is false:
        if (!allowLocalhost && (isLocalhost(requestedHost) || isLocalhost(requestedUrl))) {
            const allowedHosts = policy.allowedHosts || [];
            for (const pattern of allowedHosts) {
                if (pattern === '*') continue;
                if (matchesPattern(hostWithPort, hostname, parsedPort, pattern)) {
                    return true;
                }
            }
            return false;
        }
    }

    const allowedHosts = policy.allowedHosts || [];
    for (const pattern of allowedHosts) {
        if (matchesPattern(hostWithPort, hostname, parsedPort, pattern)) {
            return true;
        }
    }

    return policy.defaultPolicy === 'allow';
}
