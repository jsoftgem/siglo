import {
    networkPolicyStorage,
    isHostAllowed,
    NetworkPolicyViolationException,
    type EffectiveNetworkPolicy,
    type NetworkPolicyConfig,
} from '@siglo/core';

export interface HostInfo {
    hostname: string;
    host: string;
    port?: string;
}

/**
 * Safely parses the destination hostname, host with port, and port from a target URL string.
 */
export function extractHostInfo(targetUrl: string): HostInfo {
    try {
        const urlToParse = targetUrl.includes('://') ? targetUrl : `http://${targetUrl}`;
        const parsed = new URL(urlToParse);
        return {
            hostname: parsed.hostname,
            host: parsed.host,
            port: parsed.port || undefined,
        };
    } catch {
        // Fallback if URL constructor still fails on malformed input
        const withoutProto = targetUrl.replace(/^[a-z]+:\/\//, '');
        const slashIdx = withoutProto.indexOf('/');
        const hostPart = slashIdx !== -1 ? withoutProto.slice(0, slashIdx) : withoutProto;
        const colonIdx = hostPart.lastIndexOf(':');
        if (colonIdx !== -1) {
            return {
                hostname: hostPart.slice(0, colonIdx),
                host: hostPart,
                port: hostPart.slice(colonIdx + 1),
            };
        }
        return {
            hostname: hostPart,
            host: hostPart,
        };
    }
}

/**
 * Verifies that the resolved URL's hostname is permitted by the active AsyncLocalStorage
 * network egress perimeter policy.
 *
 * If blocked, throws a non-retryable NetworkPolicyViolationException tagged with `phase: 'before'`.
 */
export function assertNetworkPolicy(
    stepName: string,
    resolvedUrl: string,
    host: string,
    port?: string | number,
    fallbackPolicy?: EffectiveNetworkPolicy | NetworkPolicyConfig,
): void {
    const activeStore = networkPolicyStorage.getStore() || fallbackPolicy;
    if (!activeStore || activeStore.enabled === false) {
        return;
    }

    const effectivePolicy: EffectiveNetworkPolicy = {
        ...activeStore,
        enabled: activeStore.enabled ?? true,
        defaultPolicy: activeStore.defaultPolicy ?? 'deny',
        allowedHosts: activeStore.allowedHosts ?? [],
        allowLocalhost: activeStore.allowLocalhost ?? false,
        allowUnixSockets: activeStore.allowUnixSockets,
    };

    const allowed = isHostAllowed(resolvedUrl, host, effectivePolicy, port);
    if (!allowed) {
        const allowedHosts = effectivePolicy.allowedHosts || [];
        const exception = new NetworkPolicyViolationException(stepName, resolvedUrl, host, allowedHosts, {
            phase: 'before',
            retryable: false,
        });
        // Explicitly guarantee phase: 'before' and retryable: false as specified in roadmap
        Object.defineProperty(exception, 'phase', {
            get: () => 'before',
            set: () => {},
            configurable: true,
        });
        (exception as unknown as { retryable: boolean }).retryable = false;
        throw exception;
    }
}

/**
 * Extracts a static hostname from a URL option if it is provided as a static string.
 */
export function extractStaticHostname(urlOption: unknown): string | undefined {
    if (typeof urlOption !== 'string') {
        return undefined;
    }
    try {
        const parsed = new URL(urlOption);
        return parsed.hostname;
    } catch {
        return undefined;
    }
}
