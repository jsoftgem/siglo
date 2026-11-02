export type HostPattern = string | RegExp;

export interface NetworkPolicyConfig {
    enabled?: boolean;
    defaultPolicy?: 'deny' | 'allow';
    allowedHosts?: HostPattern[];
    allowLocalhost?: boolean;
    allowUnixSockets?: string[];
}

export interface EffectiveNetworkPolicy {
    enabled: boolean;
    defaultPolicy: 'deny' | 'allow';
    allowedHosts: HostPattern[];
    allowLocalhost: boolean;
    allowUnixSockets?: string[];
    stepName?: string;
    flowPolicy?: EffectiveNetworkPolicy;
    stepPolicy?: EffectiveNetworkPolicy;
}

export interface ActiveNetworkPolicyContext extends EffectiveNetworkPolicy {
    stepName: string;
    inValidatedScope?: boolean;
}
