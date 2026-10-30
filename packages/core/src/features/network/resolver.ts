import { EffectiveNetworkPolicy, HostPattern, NetworkPolicyConfig } from './types';
import { matchesPattern, parseHostAndPort } from './matcher';

function isPatternPermittedByList(pattern: HostPattern, flowAllowedHosts: HostPattern[]): boolean {
    if (pattern instanceof RegExp) {
        // For regex, if flow allows all (*) or has matching regex or flow list has exact pattern
        return flowAllowedHosts.some(fp => {
            if (fp === '*') return true;
            if (fp instanceof RegExp) return fp.source === pattern.source;
            return pattern.test(String(fp));
        });
    }

    const patStr = String(pattern).trim().toLowerCase();
    if (patStr === '*') {
        return flowAllowedHosts.some(fp => fp === '*');
    }

    const { hostname, port, hostWithPort } = parseHostAndPort(patStr);

    for (const fp of flowAllowedHosts) {
        if (fp === '*') {
            return true;
        }
        if (fp instanceof RegExp) {
            if (fp.test(hostname) || fp.test(hostWithPort)) {
                return true;
            }
        } else {
            // If flow pattern is wildcard *.stripe.com and step pattern is api.stripe.com
            // or if flow pattern matches step pattern
            if (matchesPattern(hostWithPort, hostname, port, fp)) {
                return true;
            }
        }
    }

    return false;
}

export function resolveEffectiveNetworkPolicy(
    stepPolicy?: NetworkPolicyConfig,
    flowPolicy?: NetworkPolicyConfig
): EffectiveNetworkPolicy | undefined {
    if (!stepPolicy && !flowPolicy) {
        return undefined;
    }

    const stepEnabled = stepPolicy?.enabled ?? (stepPolicy !== undefined);
    const flowEnabled = flowPolicy?.enabled ?? (flowPolicy !== undefined);

    if (!stepEnabled && !flowEnabled) {
        return undefined;
    }

    if (flowPolicy && !stepPolicy) {
        if (!flowEnabled) return undefined;
        return {
            enabled: true,
            defaultPolicy: flowPolicy.defaultPolicy ?? 'deny',
            allowedHosts: flowPolicy.allowedHosts ? [...flowPolicy.allowedHosts] : [],
            allowLocalhost: flowPolicy.allowLocalhost ?? true
        };
    }

    if (stepPolicy && !flowPolicy) {
        if (!stepEnabled) return undefined;
        return {
            enabled: true,
            defaultPolicy: stepPolicy.defaultPolicy ?? 'deny',
            allowedHosts: stepPolicy.allowedHosts ? [...stepPolicy.allowedHosts] : [],
            allowLocalhost: stepPolicy.allowLocalhost ?? true
        };
    }

    // Both flowPolicy and stepPolicy are present.
    // Rule: Flow sets the outer perimeter. Step can only narrow permissions within what Flow permits.
    const resolvedFlow: EffectiveNetworkPolicy = {
        enabled: true,
        defaultPolicy: flowPolicy!.defaultPolicy ?? 'deny',
        allowedHosts: flowPolicy!.allowedHosts ? [...flowPolicy!.allowedHosts] : [],
        allowLocalhost: flowPolicy!.allowLocalhost ?? true
    };

    const resolvedStep: EffectiveNetworkPolicy = {
        enabled: true,
        defaultPolicy: stepPolicy!.defaultPolicy ?? 'deny',
        allowedHosts: stepPolicy!.allowedHosts ? [...stepPolicy!.allowedHosts] : [],
        allowLocalhost: stepPolicy!.allowLocalhost ?? true
    };

    // Effective localhost exemption: flow must allow it AND step must allow it
    const allowLocalhost = (resolvedFlow.allowLocalhost !== false) && (resolvedStep.allowLocalhost !== false);

    // Compute effective allowedHosts:
    // Filter step's allowed hosts to only those permitted by flow's outer perimeter.
    let effectiveAllowedHosts: HostPattern[] = [];
    if (stepPolicy!.allowedHosts !== undefined) {
        effectiveAllowedHosts = stepPolicy!.allowedHosts.filter(pat =>
            isPatternPermittedByList(pat, resolvedFlow.allowedHosts)
        );
    } else {
        effectiveAllowedHosts = [...resolvedFlow.allowedHosts];
    }

    return {
        enabled: true,
        defaultPolicy: 'deny',
        allowedHosts: effectiveAllowedHosts,
        allowLocalhost,
        flowPolicy: resolvedFlow,
        stepPolicy: resolvedStep
    };
}
