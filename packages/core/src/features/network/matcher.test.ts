import { expect } from 'chai';
import {
    isLocalhost,
    isUnixSocket,
    isUnixSocketAllowed,
    parseHostAndPort,
    matchesPattern,
    isHostAllowed
} from './matcher';
import { EffectiveNetworkPolicy } from './types';

describe('Network Policy Matcher Tests', () => {
    describe('isLocalhost', () => {
        it('returns false for falsy or non-string inputs', () => {
            expect(isLocalhost('')).to.be.false;
            expect(isLocalhost(null as any)).to.be.false;
            expect(isLocalhost(undefined as any)).to.be.false;
            expect(isLocalhost(123 as any)).to.be.false;
        });

        it('identifies local Unix domain sockets and IPC paths via isUnixSocket', () => {
            expect(isUnixSocket('unix:/var/run/docker.sock')).to.be.true;
            expect(isUnixSocket('/tmp/app.sock')).to.be.true;
            expect(isUnixSocket('app.sock')).to.be.true;
            expect(isUnixSocket('')).to.be.false;
            expect(isUnixSocket(null as any)).to.be.false;
            expect(isUnixSocket('http://localhost')).to.be.false;
            expect(isUnixSocketAllowed('/var/run/docker.sock', ['/var/run/docker.sock'])).to.be.true;
            expect(isUnixSocketAllowed('/tmp/test.sock', ['*'])).to.be.true;
            expect(isUnixSocketAllowed('/var/run/docker.sock', ['/tmp/'])).to.be.false;
            expect(isUnixSocketAllowed('/var/run/docker.sock', undefined)).to.be.false;
        });

        it('identifies standard localhost and localhost subdomains', () => {
            expect(isLocalhost('localhost')).to.be.true;
            expect(isLocalhost('localhost:3000')).to.be.true;
            expect(isLocalhost('http://localhost:8080/api')).to.be.true;
            expect(isLocalhost('sub.localhost')).to.be.true;
            expect(isLocalhost('api.local.localhost:9000')).to.be.true;
        });

        it('identifies IPv4 loopback 127.0.0.0/8 and 0.0.0.0', () => {
            expect(isLocalhost('127.0.0.1')).to.be.true;
            expect(isLocalhost('127.0.0.1:5432')).to.be.true;
            expect(isLocalhost('http://127.0.0.2:8000/')).to.be.true;
            expect(isLocalhost('0.0.0.0')).to.be.true;
            expect(isLocalhost('http://0.0.0.0:3000')).to.be.true;
        });

        it('identifies IPv6 loopback ::1 and unspecified ::', () => {
            expect(isLocalhost('::1')).to.be.true;
            expect(isLocalhost('[::1]')).to.be.true;
            expect(isLocalhost('[::1]:8080')).to.be.true;
            expect(isLocalhost('http://[::1]:8080/data')).to.be.true;
            expect(isLocalhost('::')).to.be.true;
            expect(isLocalhost('[::]')).to.be.true;
        });

        it('returns false for public domains and external IPs', () => {
            expect(isLocalhost('api.stripe.com')).to.be.false;
            expect(isLocalhost('http://example.com')).to.be.false;
            expect(isLocalhost('8.8.8.8')).to.be.false;
            expect(isLocalhost('192.168.1.1')).to.be.false;
            expect(isLocalhost('[2001:db8::1]')).to.be.false;
        });
    });

    describe('parseHostAndPort', () => {
        it('handles empty or non-string inputs', () => {
            expect(parseHostAndPort('')).to.deep.equal({ hostname: '', hostWithPort: '' });
            expect(parseHostAndPort(null as any)).to.deep.equal({ hostname: '', hostWithPort: '' });
        });

        it('parses IPv6 brackets with and without port', () => {
            const res1 = parseHostAndPort('[::1]:8080');
            expect(res1.hostname).to.equal('::1');
            expect(res1.port).to.equal('8080');
            expect(res1.hostWithPort).to.equal('::1:8080');

            const res2 = parseHostAndPort('[::1]', 3000);
            expect(res2.hostname).to.equal('::1');
            expect(res2.port).to.equal('3000');
            expect(res2.hostWithPort).to.equal('::1:3000');

            const res3 = parseHostAndPort('[::1]');
            expect(res3.hostname).to.equal('::1');
            expect(res3.port).to.be.undefined;
            expect(res3.hostWithPort).to.equal('::1');
        });

        it('parses host with port and path', () => {
            const res = parseHostAndPort('http://api.stripe.com:443/v1/charges');
            expect(res.hostname).to.equal('api.stripe.com');
            expect(res.port).to.equal('443');
            expect(res.hostWithPort).to.equal('api.stripe.com:443');
        });

        it('parses host without port and uses defaultPort if provided', () => {
            const res = parseHostAndPort('api.stripe.com', 443);
            expect(res.hostname).to.equal('api.stripe.com');
            expect(res.port).to.equal('443');
            expect(res.hostWithPort).to.equal('api.stripe.com:443');

            const resNoPort = parseHostAndPort('api.stripe.com');
            expect(resNoPort.hostname).to.equal('api.stripe.com');
            expect(resNoPort.port).to.be.undefined;
            expect(resNoPort.hostWithPort).to.equal('api.stripe.com');
        });
    });

    describe('matchesPattern', () => {
        it('matches RegExp patterns', () => {
            const regex = /^api\.service\.(internal|local)$/;
            expect(matchesPattern('api.service.internal', 'api.service.internal', undefined, regex)).to.be.true;
            expect(matchesPattern('api.service.local:8080', 'api.service.local', '8080', regex)).to.be.true;
            expect(matchesPattern('api.service.com', 'api.service.com', undefined, regex)).to.be.false;
        });

        it('returns false for non-string / non-regex patterns', () => {
            expect(matchesPattern('api.stripe.com', 'api.stripe.com', undefined, null as any)).to.be.false;
            expect(matchesPattern('api.stripe.com', 'api.stripe.com', undefined, '' as any)).to.be.false;
        });

        it('matches universal wildcard *', () => {
            expect(matchesPattern('anything.io', 'anything.io', undefined, '*')).to.be.true;
        });

        it('matches exact host ignoring case', () => {
            expect(matchesPattern('api.stripe.com', 'api.stripe.com', undefined, 'api.stripe.com')).to.be.true;
            expect(matchesPattern('API.STRIPE.COM', 'API.STRIPE.COM', undefined, 'api.stripe.com')).to.be.true;
            expect(matchesPattern('api.stripe.com:443', 'api.stripe.com', '443', 'api.stripe.com')).to.be.true;
            expect(matchesPattern('stripe.com', 'stripe.com', undefined, 'api.stripe.com')).to.be.false;
            expect(matchesPattern('dev.api.stripe.com', 'dev.api.stripe.com', undefined, 'api.stripe.com')).to.be.false;
        });

        it('matches wildcard subdomain *.stripe.com', () => {
            const pat = '*.stripe.com';
            expect(matchesPattern('api.stripe.com', 'api.stripe.com', undefined, pat)).to.be.true;
            expect(matchesPattern('hooks.stripe.com', 'hooks.stripe.com', undefined, pat)).to.be.true;
            expect(matchesPattern('deep.sub.stripe.com', 'deep.sub.stripe.com', undefined, pat)).to.be.true;
            // Does NOT match base domain or hyphenated domain
            expect(matchesPattern('stripe.com', 'stripe.com', undefined, pat)).to.be.false;
            expect(matchesPattern('evil-stripe.com', 'evil-stripe.com', undefined, pat)).to.be.false;
        });

        it('matches port specifications strictly', () => {
            const pat = 'api.internal:8080';
            expect(matchesPattern('api.internal:8080', 'api.internal', '8080', pat)).to.be.true;
            expect(matchesPattern('api.internal:3000', 'api.internal', '3000', pat)).to.be.false;
            expect(matchesPattern('api.internal', 'api.internal', undefined, pat)).to.be.false;
        });

        it('matches IPv6 pattern with port', () => {
            const pat = '[::1]:9000';
            expect(matchesPattern('::1:9000', '::1', '9000', pat)).to.be.true;
            expect(matchesPattern('::1:8000', '::1', '8000', pat)).to.be.false;
        });
    });

    describe('isHostAllowed', () => {
        it('allows everything when policy is disabled or missing', () => {
            expect(isHostAllowed('http://evil.com', 'evil.com', null as any)).to.be.true;
            expect(isHostAllowed('http://evil.com', 'evil.com', { enabled: false } as any)).to.be.true;
        });

        it('exempts localhost by default when allowLocalhost is not false', () => {
            const policy: EffectiveNetworkPolicy = {
                enabled: true,
                defaultPolicy: 'deny',
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true,
                allowUnixSockets: ['/var/socket.sock']
            };
            expect(isHostAllowed('http://localhost:3000', 'localhost', policy, 3000)).to.be.true;
            expect(isHostAllowed('http://127.0.0.1:8080', '127.0.0.1', policy, 8080)).to.be.true;
            expect(isHostAllowed('unix:/var/socket.sock', '/var/socket.sock', policy)).to.be.true;
        });

        it('blocks localhost when allowLocalhost is false and not in allowedHosts', () => {
            const policy: EffectiveNetworkPolicy = {
                enabled: true,
                defaultPolicy: 'deny',
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: false
            };
            expect(isHostAllowed('http://localhost:3000', 'localhost', policy, 3000)).to.be.false;
        });

        it('allows localhost when allowLocalhost is false but localhost is explicitly in allowedHosts', () => {
            const policy: EffectiveNetworkPolicy = {
                enabled: true,
                defaultPolicy: 'deny',
                allowedHosts: ['localhost'],
                allowLocalhost: false
            };
            expect(isHostAllowed('http://localhost:3000', 'localhost', policy)).to.be.true;
        });

        it('allows matching allowedHosts and denies non-matching hosts when defaultPolicy is deny', () => {
            const policy: EffectiveNetworkPolicy = {
                enabled: true,
                defaultPolicy: 'deny',
                allowedHosts: ['api.stripe.com', '*.github.com'],
                allowLocalhost: true
            };
            expect(isHostAllowed('https://api.stripe.com/v1', 'api.stripe.com', policy)).to.be.true;
            expect(isHostAllowed('https://api.github.com/users', 'api.github.com', policy)).to.be.true;
            expect(isHostAllowed('https://evil.com', 'evil.com', policy)).to.be.false;
        });

        it('allows unmatched hosts when defaultPolicy is allow', () => {
            const policy: EffectiveNetworkPolicy = {
                enabled: true,
                defaultPolicy: 'allow',
                allowedHosts: [],
                allowLocalhost: true
            };
            expect(isHostAllowed('https://anywhere.org', 'anywhere.org', policy)).to.be.true;
        });

        it('evaluates dual policy (flowPolicy and stepPolicy)', () => {
            const flowPolicy: EffectiveNetworkPolicy = {
                enabled: true,
                defaultPolicy: 'deny',
                allowedHosts: ['api.stripe.com', 'api.sendgrid.com'],
                allowLocalhost: true
            };
            const stepPolicy: EffectiveNetworkPolicy = {
                enabled: true,
                defaultPolicy: 'deny',
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true
            };
            const compositePolicy: EffectiveNetworkPolicy = {
                enabled: true,
                defaultPolicy: 'deny',
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true,
                flowPolicy,
                stepPolicy
            };

            // Allowed by both
            expect(isHostAllowed('https://api.stripe.com', 'api.stripe.com', compositePolicy)).to.be.true;
            // Allowed by flow but narrowed out by step
            expect(isHostAllowed('https://api.sendgrid.com', 'api.sendgrid.com', compositePolicy)).to.be.false;
            // Denied by both
            expect(isHostAllowed('https://evil.com', 'evil.com', compositePolicy)).to.be.false;
        });
    });
});
