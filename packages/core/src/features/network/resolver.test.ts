import { expect } from 'chai';
import { resolveEffectiveNetworkPolicy } from './resolver';

describe('Network Policy Resolver Tests', () => {
    it('returns undefined when neither stepPolicy nor flowPolicy is provided', () => {
        expect(resolveEffectiveNetworkPolicy(undefined, undefined)).to.be.undefined;
    });

    it('returns undefined when both policies are explicitly disabled', () => {
        expect(resolveEffectiveNetworkPolicy({ enabled: false }, { enabled: false })).to.be.undefined;
    });

    it('resolves flow policy when only flowPolicy is provided', () => {
        const resolved = resolveEffectiveNetworkPolicy(undefined, {
            allowedHosts: ['api.stripe.com'],
            allowLocalhost: true,
            allowUnixSockets: ['/var/run/docker.sock']
        });
        expect(resolved?.enabled).to.be.true;
        expect(resolved?.defaultPolicy).to.equal('deny');
        expect(resolved?.allowedHosts).to.deep.equal(['api.stripe.com']);
        expect(resolved?.allowLocalhost).to.be.true;
        expect(resolved?.allowUnixSockets).to.deep.equal(['/var/run/docker.sock']);

        // Disabled flow policy
        expect(resolveEffectiveNetworkPolicy(undefined, { enabled: false })).to.be.undefined;
    });

    it('resolves step policy when only stepPolicy is provided', () => {
        const resolved = resolveEffectiveNetworkPolicy({
            allowedHosts: ['api.github.com'],
            allowLocalhost: false,
            allowUnixSockets: ['/var/run/custom.sock']
        }, undefined);
        expect(resolved?.enabled).to.be.true;
        expect(resolved?.defaultPolicy).to.equal('deny');
        expect(resolved?.allowedHosts).to.deep.equal(['api.github.com']);
        expect(resolved?.allowLocalhost).to.be.false;
        expect(resolved?.allowUnixSockets).to.deep.equal(['/var/run/custom.sock']);

        // Disabled step policy
        expect(resolveEffectiveNetworkPolicy({ enabled: false }, undefined)).to.be.undefined;
    });

    it('enforces flow outer perimeter and filters unauthorized step hosts', () => {
        const flowPolicy = {
            allowedHosts: ['*.stripe.com', 'api.sendgrid.com']
        };
        const stepPolicy = {
            allowedHosts: ['api.stripe.com', 'api.github.com'] // github.com is not allowed by flow
        };

        const resolved = resolveEffectiveNetworkPolicy(stepPolicy, flowPolicy);
        expect(resolved).to.not.be.undefined;
        expect(resolved!.enabled).to.be.true;
        // api.stripe.com is allowed because it matches *.stripe.com in flow
        // api.github.com is dropped because flow does not permit it
        expect(resolved!.allowedHosts).to.deep.equal(['api.stripe.com']);
    });

    it('handles universal wildcard * in step and flow allowlist', () => {
        const flowWithWildcard = { allowedHosts: ['*'] };
        const stepWithWildcard = { allowedHosts: ['*'] };
        const resAllowed = resolveEffectiveNetworkPolicy(stepWithWildcard, flowWithWildcard);
        expect(resAllowed!.allowedHosts).to.deep.equal(['*']);

        const flowRestricted = { allowedHosts: ['api.stripe.com'] };
        const resBlocked = resolveEffectiveNetworkPolicy(stepWithWildcard, flowRestricted);
        expect(resBlocked!.allowedHosts).to.deep.equal([]);
    });

    it('allows step host when flow perimeter allows all with universal wildcard *', () => {
        const flowWithWildcard = { allowedHosts: ['*'] };
        const stepWithDomain = { allowedHosts: ['api.stripe.com'] };
        const resAllowed = resolveEffectiveNetworkPolicy(stepWithDomain, flowWithWildcard);
        expect(resAllowed!.allowedHosts).to.deep.equal(['api.stripe.com']);
    });

    it('handles step regex patterns against flow regex and string patterns', () => {
        const flowPolicy = {
            allowedHosts: [/^api\.service\.(internal|local)$/, 'exact.domain.com']
        };
        const stepPolicy = {
            allowedHosts: [
                /^api\.service\.(internal|local)$/,
                /other\.com/,
                'api.service.internal',
                'exact.domain.com',
                'unknown.com'
            ]
        };

        const resolved = resolveEffectiveNetworkPolicy(stepPolicy, flowPolicy);
        expect(resolved!.allowedHosts).to.deep.equal([
            /^api\.service\.(internal|local)$/,
            'api.service.internal',
            'exact.domain.com'
        ]);
    });

    it('allows step to inherit flow allowedHosts when step allowedHosts is undefined', () => {
        const flowPolicy = {
            allowedHosts: ['api.stripe.com']
        };
        const stepPolicy = {
            allowLocalhost: false
        };

        const resolved = resolveEffectiveNetworkPolicy(stepPolicy, flowPolicy);
        expect(resolved!.allowedHosts).to.deep.equal(['api.stripe.com']);
        expect(resolved!.allowLocalhost).to.be.false;
    });

    it('allows step to deny all external network calls via denyNetwork (empty array)', () => {
        const flowPolicy = {
            allowedHosts: ['api.stripe.com', 'api.sendgrid.com']
        };
        const stepPolicy = {
            allowedHosts: []
        };

        const resolved = resolveEffectiveNetworkPolicy(stepPolicy, flowPolicy);
        expect(resolved!.allowedHosts).to.deep.equal([]);
    });

    it('enforces flow superseding step for localhost allowance', () => {
        // Flow allows, step narrows -> false
        const res1 = resolveEffectiveNetworkPolicy({ allowLocalhost: false }, { allowLocalhost: true });
        expect(res1!.allowLocalhost).to.be.false;

        // Flow disallows, step attempts to enable -> false (Flow supersedes step)
        const res2 = resolveEffectiveNetworkPolicy({ allowLocalhost: true }, { allowLocalhost: false });
        expect(res2!.allowLocalhost).to.be.false;

        // Both allow -> true
        const res3 = resolveEffectiveNetworkPolicy({ allowLocalhost: true }, { allowLocalhost: true });
        expect(res3!.allowLocalhost).to.be.true;
    });

    it('enforces flow outer perimeter for unix domain sockets', () => {
        // Flow allows sockets, step narrows
        const flowPolicy = {
            allowUnixSockets: ['/var/run/docker.sock', '/tmp/app.sock']
        };
        const stepPolicy = {
            allowUnixSockets: ['/var/run/docker.sock', '/tmp/unauthorized.sock']
        };
        const resolved = resolveEffectiveNetworkPolicy(stepPolicy, flowPolicy);
        expect(resolved!.allowUnixSockets).to.deep.equal(['/var/run/docker.sock']);

        // Step inherits flow unix sockets when step unix sockets is undefined
        const stepWithoutSockets = {
            allowedHosts: ['api.stripe.com']
        };
        const resolvedInherited = resolveEffectiveNetworkPolicy(stepWithoutSockets, flowPolicy);
        expect(resolvedInherited!.allowUnixSockets).to.deep.equal(['/var/run/docker.sock', '/tmp/app.sock']);

        // Flow disallows sockets, step cannot grant access
        const flowWithoutSockets = {
            allowedHosts: ['api.stripe.com']
        };
        const stepWithSockets = {
            allowUnixSockets: ['/var/run/docker.sock']
        };
        const resolvedBlocked = resolveEffectiveNetworkPolicy(stepWithSockets, flowWithoutSockets);
        expect(resolvedBlocked!.allowUnixSockets).to.be.undefined;
    });
});
