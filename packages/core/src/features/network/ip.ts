import net from 'node:net';
import dns from 'node:dns/promises';
import { EffectiveNetworkPolicy } from './types';
import { NetworkPolicyViolationException } from '../executer/exceptions';

/**
 * Normalizes decimal, hexadecimal, octal, or integer representations of IPv4 addresses.
 */
export function parseNumericIPv4(str: string): string | undefined {
    if (!str || typeof str !== 'string') return undefined;
    const trimmed = str.trim();

    // Plain integer, hex, or octal format (e.g. 2130706433 or 0x7f000001 or 017700000001)
    if (/^0x[0-9a-fA-F]+$/i.test(trimmed)) {
        const num = parseInt(trimmed, 16);
        if (!isNaN(num) && num >= 0 && num <= 0xffffffff) {
            return [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');
        }
    } else if (/^0[0-7]+$/.test(trimmed)) {
        const num = parseInt(trimmed, 8);
        if (!isNaN(num) && num >= 0 && num <= 0xffffffff) {
            return [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');
        }
    } else if (/^\d+$/.test(trimmed)) {
        const num = parseInt(trimmed, 10);
        if (!isNaN(num) && num >= 0 && num <= 0xffffffff) {
            return [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');
        }
    }

    // Dotted notation (supports 2, 3, or 4 parts with hex, octal, or decimal)
    const parts = trimmed.split('.');
    if (parts.length >= 2 && parts.length <= 4) {
        const nums: number[] = [];
        for (const p of parts) {
            if (/^0x[0-9a-fA-F]+$/i.test(p)) {
                nums.push(parseInt(p, 16));
            } else if (/^0[0-7]+$/.test(p)) {
                nums.push(parseInt(p, 8));
            } else if (/^\d+$/.test(p)) {
                nums.push(parseInt(p, 10));
            } else {
                return undefined;
            }
        }
        if (nums.some(n => isNaN(n) || n < 0)) return undefined;

        let val: number;
        if (nums.length === 2) {
            if (nums[0] > 255 || nums[1] > 0xffffff) return undefined;
            val = ((nums[0] << 24) | nums[1]) >>> 0;
        } else if (nums.length === 3) {
            if (nums[0] > 255 || nums[1] > 255 || nums[2] > 0xffff) return undefined;
            val = ((nums[0] << 24) | (nums[1] << 16) | nums[2]) >>> 0;
        } else {
            if (nums.some(n => n > 255)) return undefined;
            val = ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
        }

        return [(val >>> 24) & 255, (val >>> 16) & 255, (val >>> 8) & 255, val & 255].join('.');
    }
    return undefined;
}

/**
 * Extracts and canonicalizes IPv4 addresses mapped into IPv6 format.
 * (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
 */
export function extractMappedIPv4(str: string): string | undefined {
    if (!str || typeof str !== 'string') return undefined;
    const clean = str
        .replace(/^\[|\]$/g, '')
        .trim()
        .toLowerCase();
    if (clean.startsWith('::ffff:')) {
        const rest = clean.slice(7);
        if (net.isIPv4(rest)) return rest;
        const parts = rest.split(':');
        if (parts.length === 2) {
            const high = parseInt(parts[0], 16);
            const low = parseInt(parts[1], 16);
            if (!isNaN(high) && !isNaN(low) && high >= 0 && high <= 0xffff && low >= 0 && low <= 0xffff) {
                return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join('.');
            }
        }
    }
    return undefined;
}

/**
 * Normalizes an IP string to canonical dotted-quad IPv4 or lowercase IPv6.
 * Returns undefined if the string is not an IP address (e.g. a domain name).
 */
export function normalizeIP(raw: string): string | undefined {
    if (!raw || typeof raw !== 'string') return undefined;
    const clean = raw.trim().replace(/^\[|\]$/g, '');
    const mapped = extractMappedIPv4(clean);
    if (mapped) return mapped;
    if (net.isIPv4(clean)) return clean;
    if (net.isIPv6(clean)) return clean.toLowerCase();
    const numeric = parseNumericIPv4(clean);
    if (numeric && net.isIPv4(numeric)) return numeric;
    return undefined;
}

/**
 * Checks whether an IP address is within private, loopback, link-local, carrier-grade NAT,
 * or cloud instance metadata (169.254.169.254) ranges.
 */
export function isPrivateOrRestrictedIP(ip: string, allowLocalhost: boolean = false): boolean {
    const norm = normalizeIP(ip);
    if (!norm) return false;

    if (net.isIPv4(norm)) {
        const parts = norm.split('.').map(Number);
        const [a, b, c, d] = parts;
        // 127.0.0.0/8 (Loopback)
        if (a === 127) return !allowLocalhost;
        // 0.0.0.0/8 (Current network / default route)
        if (a === 0) return !allowLocalhost;
        // 10.0.0.0/8 (Private)
        if (a === 10) return true;
        // 172.16.0.0/12 (Private)
        if (a === 172 && b >= 16 && b <= 31) return true;
        // 192.168.0.0/16 (Private)
        if (a === 192 && b === 168) return true;
        // 169.254.0.0/16 (Link-Local & Cloud Metadata 169.254.169.254)
        if (a === 169 && b === 254) return true;
        // 100.64.0.0/10 (Carrier-Grade NAT)
        if (a === 100 && b >= 64 && b <= 127) return true;
        // 255.255.255.255 (Broadcast)
        if (a === 255 && b === 255 && c === 255 && d === 255) return true;
        return false;
    }

    if (net.isIPv6(norm)) {
        // ::1 (Loopback)
        if (norm === '::1' || norm === '0:0:0:0:0:0:0:1') return !allowLocalhost;
        // :: (Unspecified)
        if (norm === '::' || norm === '0:0:0:0:0:0:0:0') return !allowLocalhost;
        // fe80::/10 (Link-Local)
        if (/^[fF][eE][89abAB]/.test(norm)) return true;
        // fc00::/7 (Unique Local Address / Private)
        if (/^[fF][cdCD]/.test(norm)) return true;
        return false;
    }

    return false;
}

/**
 * Validates target host via pre-flight DNS lookup against private and link-local ranges.
 * Throws NetworkPolicyViolationException if any resolved IP violates the perimeter.\n */
export async function validateAndPinTarget(
    targetUrl: URL,
    policy: EffectiveNetworkPolicy,
    dnsLookupFn?: (host: string, opts: any) => Promise<Array<{ address: string; family: number }>>,
): Promise<string[]> {
    const rawHostname = targetUrl.hostname;
    const directIP = normalizeIP(rawHostname);

    if (directIP) {
        if (isPrivateOrRestrictedIP(directIP, policy.allowLocalhost)) {
            // Check if explicitly allowlisted
            const isExplicitlyAllowed = (policy.allowedHosts || []).some(pat => {
                if (typeof pat === 'string') {
                    const normPat = normalizeIP(pat);
                    return normPat === directIP || pat === directIP;
                }
                return false;
            });
            if (!isExplicitlyAllowed) {
                throw new NetworkPolicyViolationException(
                    policy.stepName || 'flow',
                    targetUrl.href,
                    targetUrl.host,
                    policy.allowedHosts || [],
                );
            }
        }
        return [directIP];
    }

    // Domain name: pre-flight DNS lookup
    let addresses: Array<{ address: string; family: number }>;
    try {
        if (dnsLookupFn) {
            addresses = await dnsLookupFn(rawHostname, { all: true });
        } else {
            addresses = await dns.lookup(rawHostname, { all: true });
        }
    } catch (err: any) {
        // DNS lookup failure
        throw new NetworkPolicyViolationException(
            policy.stepName || 'flow',
            targetUrl.href,
            targetUrl.host,
            policy.allowedHosts || [],
            { reason: `DNS lookup failed for ${rawHostname}: ${err.message}` } as any,
        );
    }

    const pinnedIps: string[] = [];
    for (const addr of addresses) {
        if (isPrivateOrRestrictedIP(addr.address, policy.allowLocalhost)) {
            const isExplicitlyAllowed = (policy.allowedHosts || []).some(pat => {
                if (typeof pat === 'string') {
                    const normPat = normalizeIP(pat);
                    return normPat === addr.address || pat === addr.address;
                }
                return false;
            });
            if (!isExplicitlyAllowed) {
                throw new NetworkPolicyViolationException(
                    policy.stepName || 'flow',
                    targetUrl.href,
                    targetUrl.host,
                    policy.allowedHosts || [],
                    { reason: `Target host '${rawHostname}' resolved to restricted IP: ${addr.address}` } as any,
                );
            }
        }
        pinnedIps.push(addr.address);
    }

    return pinnedIps;
}
