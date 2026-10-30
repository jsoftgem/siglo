import { EffectiveNetworkPolicy, HostPattern } from './types';

export function isLocalhost(hostOrTarget: string): boolean {
    if (!hostOrTarget || typeof hostOrTarget !== 'string') {
        return false;
    }
    const clean = hostOrTarget.trim().toLowerCase();

    // Local Unix domain sockets or IPC paths
    if (clean.startsWith('unix:') || clean.startsWith('/') || clean.includes('.sock')) {
        return true;
    }

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
    if (hostname === '127.0.0.1' || hostname.startsWith('127.')) {
        return true;
    }
    if (hostname === '::1') {
        return true;
    }
    if (hostname === '0.0.0.0' || hostname === '::') {
        return true;
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

    const allowLocalhost = policy.allowLocalhost !== false;
    if (allowLocalhost && (isLocalhost(requestedHost) || isLocalhost(requestedUrl))) {
        return true;
    }

    const { hostname, port: parsedPort, hostWithPort } = parseHostAndPort(requestedHost, port);

    const allowedHosts = policy.allowedHosts || [];
    for (const pattern of allowedHosts) {
        if (matchesPattern(hostWithPort, hostname, parsedPort, pattern)) {
            return true;
        }
    }

    return policy.defaultPolicy === 'allow';
}
