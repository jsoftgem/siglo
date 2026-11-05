import { parseNumericIPv4, extractMappedIPv4 } from './ip';
import { expect } from 'chai';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import {
    Step,
    flow,
    NetworkPolicyViolationException,
    isPrivateOrRestrictedIP,
    normalizeIP,

    validateAndPinTarget,
    isUnixSocket,
    isUnixSocketAllowed,
    networkPolicyStorage,
    installNetworkInterceptors,
    uninstallNetworkInterceptors
} from '../../index';

describe('Phase 3: Zero-Trust Network Perimeter Acceptance Tests', () => {
    let server: http.Server;
    let serverPort: number;

    before((done) => {
        installNetworkInterceptors();
        server = http.createServer((req, res) => {
            if (req.url === '/safe') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok' }));
            } else if (req.url === '/redirect-to-metadata') {
                res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
                res.end();
            } else if (req.url === '/redirect-to-private') {
                res.writeHead(302, { Location: 'http://10.0.0.1/internal-api' });
                res.end();
            } else if (req.url === '/redirect-to-localhost') {
                res.writeHead(302, { Location: 'http://127.0.0.1:9999/secret' });
                res.end();
            } else if (req.url === '/redirect-loop-1') {
                res.writeHead(302, { Location: `/redirect-loop-2` });
                res.end();
            } else if (req.url === '/redirect-loop-2') {
                res.writeHead(302, { Location: `/redirect-loop-1` });
                res.end();
            } else if (req.url === '/redirect-safe-chain') {
                res.writeHead(302, { Location: `/safe` });
                res.end();
            } else if (req.url === '/redirect-303') {
                res.writeHead(303, { Location: `/safe` });
                res.end();
            } else if (req.url === '/redirect-no-location') {
                res.writeHead(302);
                res.end();
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        server.listen(0, '127.0.0.1', () => {
            serverPort = (server.address() as net.AddressInfo).port;
            done();
        });
    });

    afterEach(() => {
        try { networkPolicyStorage.disable(); } catch {}
    });

    after((done) => {
        uninstallNetworkInterceptors();
        try { networkPolicyStorage.disable(); } catch {}
        (server as any).closeAllConnections?.();
        server.close(done);
    });

    describe('Canonical IP Normalization & Encoding Defense', () => {
        it('normalizes integer and DWORD IP representations into canonical IPv4', () => {
            expect(parseNumericIPv4('2130706433')).to.equal('127.0.0.1');
            expect(normalizeIP('2130706433')).to.equal('127.0.0.1');
            expect(normalizeIP('http://2130706433')).to.be.undefined; // full URL is not raw IP
            expect(parseNumericIPv4('0')).to.equal('0.0.0.0');
            expect(parseNumericIPv4('')).to.be.undefined;
            expect(parseNumericIPv4('invalid')).to.be.undefined;
            expect(parseNumericIPv4('-1')).to.be.undefined;
        });

        it('normalizes hexadecimal and octal IP representations', () => {
            expect(normalizeIP('0x7f000001')).to.equal('127.0.0.1');
            expect(normalizeIP('017700000001')).to.equal('127.0.0.1');
            expect(parseNumericIPv4('017700000001')).to.equal('127.0.0.1');
            expect(normalizeIP('0x7f.0.0.1')).to.equal('127.0.0.1');
            expect(normalizeIP('0177.0.0.1')).to.equal('127.0.0.1');
            expect(normalizeIP('127.1')).to.equal('127.0.0.1');
            expect(normalizeIP('10.1.2')).to.equal('10.1.0.2');
        });

        it('normalizes IPv6-mapped IPv4 representations', () => {
            expect(extractMappedIPv4('::ffff:127.0.0.1')).to.equal('127.0.0.1');
            expect(extractMappedIPv4('[::ffff:7f00:1]')).to.equal('127.0.0.1');
            expect(extractMappedIPv4('::ffff:a9fe:a9fe')).to.equal('169.254.169.254');
            expect(normalizeIP('::ffff:169.254.169.254')).to.equal('169.254.169.254');
            expect(extractMappedIPv4('::1')).to.be.undefined;
            expect(extractMappedIPv4('')).to.be.undefined;
            expect(extractMappedIPv4('::ffff:invalid:invalid')).to.be.undefined;
        });

        it('correctly classifies private, loopback, link-local, and cloud metadata IPs', () => {
            // Cloud metadata & link-local
            expect(isPrivateOrRestrictedIP('169.254.169.254')).to.be.true;
            expect(isPrivateOrRestrictedIP('169.254.1.1')).to.be.true;

            // Private RFC 1918 CIDRs
            expect(isPrivateOrRestrictedIP('10.0.0.1')).to.be.true;
            expect(isPrivateOrRestrictedIP('172.16.0.1')).to.be.true;
            expect(isPrivateOrRestrictedIP('172.31.255.255')).to.be.true;
            expect(isPrivateOrRestrictedIP('172.32.0.1')).to.be.false;
            expect(isPrivateOrRestrictedIP('192.168.1.1')).to.be.true;

            // Loopback & Unspecified
            expect(isPrivateOrRestrictedIP('127.0.0.1', false)).to.be.true;
            expect(isPrivateOrRestrictedIP('127.0.0.1', true)).to.be.false;
            expect(isPrivateOrRestrictedIP('0.0.0.0', false)).to.be.true;
            expect(isPrivateOrRestrictedIP('0.0.0.0', true)).to.be.false;
            expect(isPrivateOrRestrictedIP('255.255.255.255')).to.be.true;
            expect(isPrivateOrRestrictedIP('100.64.0.1')).to.be.true; // CGNAT

            // IPv6
            expect(isPrivateOrRestrictedIP('::1', false)).to.be.true;
            expect(isPrivateOrRestrictedIP('::1', true)).to.false;
            expect(isPrivateOrRestrictedIP('::', false)).to.be.true;
            expect(isPrivateOrRestrictedIP('::', true)).to.be.false;
            expect(isPrivateOrRestrictedIP('fe80::1')).to.be.true; // Link-local
            expect(isPrivateOrRestrictedIP('fc00::1')).to.be.true; // ULA

            // Public IPs
            expect(isPrivateOrRestrictedIP('8.8.8.8')).to.be.false;
            expect(isPrivateOrRestrictedIP('1.1.1.1')).to.be.false;
            expect(isPrivateOrRestrictedIP('2606:4700:4700::1111')).to.be.false;
            expect(isPrivateOrRestrictedIP('invalid-ip')).to.be.false;
        });
    });

    describe('Pre-flight DNS Resolution & Socket IP Pinning Defense', () => {
        it('blocks DNS rebinding when domain resolves to 169.254.169.254 (cloud metadata)', async () => {
            const fakeDns = async (_host: string) => [
                { address: '169.254.169.254', family: 4 }
            ];

            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['api.attacker.com'],
                allowLocalhost: false
            };

            try {
                await validateAndPinTarget(new URL('http://api.attacker.com/v1/credentials'), policy, fakeDns);
                expect.fail('Should have thrown NetworkPolicyViolationException');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.message).to.include('169.254.169.254');
            }
        });

        it('blocks DNS rebinding when domain resolves to private RFC 1918 IP (10.0.0.1)', async () => {
            const fakeDns = async (_host: string) => [
                { address: '10.0.0.1', family: 4 }
            ];

            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['internal.attacker.com'],
                allowLocalhost: false
            };

            try {
                await validateAndPinTarget(new URL('http://internal.attacker.com/data'), policy, fakeDns);
                expect.fail('Should have thrown NetworkPolicyViolationException');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.message).to.include('10.0.0.1');
            }
        });

        it('blocks direct numeric IP if restricted and not in allowlist', async () => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: [],
                allowLocalhost: false
            };

            try {
                await validateAndPinTarget(new URL('http://169.254.169.254/meta-data'), policy);
                expect.fail('Should have thrown NetworkPolicyViolationException');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
            }
        });

        it('permits direct numeric IP if explicitly allowlisted', async () => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['169.254.169.254'],
                allowLocalhost: false
            };

            const ips = await validateAndPinTarget(new URL('http://169.254.169.254/meta-data'), policy);
            expect(ips).to.deep.equal(['169.254.169.254']);
        });

        it('throws NetworkPolicyViolationException when DNS lookup fails', async () => {
            const throwingDns = async () => {
                throw new Error('ENOTFOUND');
            };

            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['unresolvable.domain.xyz'],
                allowLocalhost: false
            };

            try {
                await validateAndPinTarget(new URL('http://unresolvable.domain.xyz/'), policy, throwingDns);
                expect.fail('Should have thrown NetworkPolicyViolationException');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.message).to.include('ENOTFOUND');
            }
        });
    });

    describe('HTTP 30x Redirect Traversal & Re-evaluation Defense', () => {
        it('blocks 302 redirect attempting SSRF to 169.254.169.254 cloud metadata', async () => {
            const step = Step.create('redirectStep', async () => {
                const res = await fetch(`http://127.0.0.1:${serverPort}/redirect-to-metadata`);
                return res.json();
            }).networkPolicy({
                allowedHosts: [`127.0.0.1:${serverPort}`],
                allowLocalhost: true
            });

            try {
                await flow(step).run();
                expect.fail('Should have blocked redirect to metadata');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.requestedUrl).to.include('169.254.169.254');
            }
        });

        it('blocks 302 redirect attempting egress to private VPC IP 10.0.0.1', async () => {
            const step = Step.create('redirectStep', async () => {
                const res = await fetch(`http://127.0.0.1:${serverPort}/redirect-to-private`);
                return res.json();
            }).networkPolicy({
                allowedHosts: [`127.0.0.1:${serverPort}`],
                allowLocalhost: true
            });

            try {
                await flow(step).run();
                expect.fail('Should have blocked redirect to private IP');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.requestedUrl).to.include('10.0.0.1');
            }
        });

        it('blocks 302 redirect to localhost when allowLocalhost is false', async () => {
            const step = Step.create('redirectStep', async () => {
                const res = await fetch(`http://127.0.0.1:${serverPort}/redirect-to-localhost`);
                return res.json();
            }).networkPolicy({
                allowedHosts: [`127.0.0.1:${serverPort}`],
                allowLocalhost: false
            });

            try {
                await flow(step).run();
                expect.fail('Should have blocked redirect to localhost');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
            }
        });

        it('allows valid multi-hop redirect chain within policy', async () => {
            const step = Step.create('redirectStep', async () => {
                const res = await fetch(`http://127.0.0.1:${serverPort}/redirect-safe-chain`);
                return res.json();
            }).networkPolicy({
                allowedHosts: [`127.0.0.1:${serverPort}`],
                allowLocalhost: true
            });

            const result: any = await flow(step).run();
            expect(result.status).to.equal('ok');
        });

        it('honors explicit manual and error redirect modes without following the target', async () => {
            for (const redirect of ['manual', 'error'] as const) {
                const step = Step.create('explicitRedirect', async () => {
                    const response = await fetch(`http://127.0.0.1:${serverPort}/redirect-to-metadata`, { redirect });
                    const status = response.status;
                    await response.body?.cancel();
                    return { status };
                }).networkPolicy({ allowedHosts: [`127.0.0.1:${serverPort}`], allowLocalhost: true });
                if (redirect === 'manual') {
                    const result = await flow(step).run();
                    expect(result.status).to.equal(302);
                } else {
                    try {
                        await flow(step).run();
                        expect.fail('Expected redirect error');
                    } catch (error: any) {
                        expect(error.message).to.include('redirect is forbidden');
                    }
                }
            }
        });

        it('handles 303 redirect with method change to GET', async () => {
            const step = Step.create('redirectStep', async () => {
                const res = await fetch(`http://127.0.0.1:${serverPort}/redirect-303`, { method: 'POST', body: 'data' });
                return res.json();
            }).networkPolicy({
                allowedHosts: [`127.0.0.1:${serverPort}`],
                allowLocalhost: true
            });

            const result: any = await flow(step).run();
            expect(result.status).to.equal('ok');
        });

        it('returns response when redirect header has no Location', async () => {
            const step = Step.create('redirectStep', async () => {
                const res = await fetch(`http://127.0.0.1:${serverPort}/redirect-no-location`);
                return { status: res.status };
            }).networkPolicy({
                allowedHosts: [`127.0.0.1:${serverPort}`],
                allowLocalhost: true
            });

            const result: any = await flow(step).run();
            expect(result.status).to.equal(302);
        });

        it('blocks infinite redirect loops exceeding maximum redirect limit', async () => {
            const step = Step.create('loopStep', async () => {
                await fetch(`http://127.0.0.1:${serverPort}/redirect-loop-1`);
            }).networkPolicy({
                allowedHosts: [`127.0.0.1:${serverPort}`],
                allowLocalhost: true
            });

            try {
                await flow(step).run();
                expect.fail('Should have thrown maximum redirect exceeded');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.message).to.include('Maximum redirect count exceeded');
            }
        });
    });

    describe('Unix Domain Socket Lockdown & Container Escape Prevention', () => {
        it('strictly blocks unauthorized connection to /var/run/docker.sock by default', (done) => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true, // Localhost does NOT grant Unix socket access!
                stepName: 'containerStep'
            };

            networkPolicyStorage.run(policy, () => {
                const socket = new net.Socket();
                socket.on('error', (err: any) => {
                    expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                    expect(err.requestedUrl).to.equal('unix:///var/run/docker.sock');
                    done();
                });
                socket.connect('/var/run/docker.sock');
            });
        });

        it('allows unix socket connection when explicitly configured in allowUnixSockets', (done) => {
            const safeSocketPath = `/tmp/siglo_safe_test_${Date.now()}_${process.pid}.sock`;
            try { fs.unlinkSync(safeSocketPath); } catch {}
            const unixServer = net.createServer((sock) => {
                sock.end('hello unix');
            });

            unixServer.listen(safeSocketPath, () => {
                const policy = {
                    enabled: true,
                    defaultPolicy: 'deny' as const,
                    allowedHosts: [],
                    allowLocalhost: false,
                    allowUnixSockets: [safeSocketPath],
                    stepName: 'safeUnixStep'
                };

                networkPolicyStorage.run(policy, () => {
                    const client = net.connect(safeSocketPath, () => {
                        client.on('data', (d) => {
                            expect(d.toString()).to.equal('hello unix');
                            client.end();
                            unixServer.close(() => {
                                try { fs.unlinkSync(safeSocketPath); } catch {}
                                done();
                            });
                        });
                    });
                });
            });
        });

        it('step.allowUnixSockets() declarative API adds unix socket permission', () => {
            const s = Step.create('test', () => ({})).allowUnixSockets(['/tmp/app.sock']);
            expect(s.networkPolicy()?.allowUnixSockets).to.deep.equal(['/tmp/app.sock']);
            expect(s.networkPolicy()?.allowLocalhost).to.be.false;
        });
    });

    describe('BlockedClientRequest HTTP Client Compatibility', () => {
        it('BlockedClientRequest is an instanceof http.ClientRequest and http.OutgoingMessage', (done) => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: [],
                allowLocalhost: false,
                stepName: 'compatStep'
            };

            networkPolicyStorage.run(policy, () => {
                const req = http.request('http://unauthorized.com/test');
                expect(req).to.be.instanceOf(http.ClientRequest);
                expect(req).to.be.instanceOf(http.OutgoingMessage);

                // Verify dummy methods can be called safely without crashing
                req.setHeader('X-Test', '1');
                expect(req.getHeader('X-Test')).to.be.undefined;
                expect(req.getHeaders()).to.deep.equal({});
                expect(req.getHeaderNames()).to.deep.equal([]);
                expect(req.hasHeader('X-Test')).to.be.false;
                req.removeHeader('X-Test');
                expect(req.write('chunk')).to.be.false;
                req.setTimeout(100);
                req.setNoDelay(true);
                req.setSocketKeepAlive(true, 100);
                req.flushHeaders();
                req.abort();
                req.destroy();
                req.end();

                req.on('error', (err: any) => {
                    expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                    expect(err.stepName).to.equal('compatStep');
                    networkPolicyStorage.disable();
                    done();
                });
            });
        });
    });
});
