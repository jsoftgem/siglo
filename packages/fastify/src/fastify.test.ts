import { expect } from 'chai';
import { Step, flow, waitForEvent, wait, clearStorage, defaultDurableManager } from '@siglo/core';
import { sigloFastifyHandler, getErrorStatusCode } from './index';

describe('@siglo/fastify Adapter Suite', () => {
    it('executes workflow using fastify request and returns clean response', async () => {
        const stepA = Step.create(async ({ price, qty }: { price: number; qty: number }) => ({
            subtotal: price * qty,
        }));
        const orderFlow = flow(stepA);

        const handler = sigloFastifyHandler(orderFlow);

        const mockReq = {
            body: { price: 20, qty: 3 },
            headers: { 'x-namespace': 'ns-fastify', 'x-correlation-id': 'corr-fastify-99' },
        };
        const headersSet: Record<string, string> = {};
        const mockReply = {
            header(name: string, val: string) {
                headersSet[name] = val;
            },
        };

        const result = await handler(mockReq, mockReply);
        expect(result.subtotal).to.equal(60);
        expect(headersSet['X-Workflow-Stack-Id']).to.be.a('string');
        expect(headersSet['X-Correlation-Id']).to.equal('corr-fastify-99');
    });

    it('ignores x-namespace header by default and respects it only when allowHeaderNamespace is true', async () => {
        let capturedNamespace: string | undefined;
        const inspectStep = Step.create(async (param: any) => {
            capturedNamespace = typeof param.$namespace === 'function' ? param.$namespace() : param.$namespace;
            return { ok: true };
        });
        const testFlow = flow(inspectStep);

        const mockReq = {
            body: {},
            headers: { 'x-namespace': 'attacker-fastify' },
        };
        const mockReply = { header: () => {} };

        // Default: header is ignored for security
        const secureHandler = sigloFastifyHandler(testFlow);
        await secureHandler(mockReq, mockReply);
        expect(capturedNamespace).to.be.undefined;

        // With explicit opt-in: header is respected
        const optInHandler = sigloFastifyHandler(testFlow, { allowHeaderNamespace: true });
        await optInHandler(mockReq, mockReply);
        expect(capturedNamespace).to.equal('attacker-fastify');
    });

    it('sanitizes internal 500 error messages when exposeErrorDetails is false', async () => {
        const failStep = Step.create(async (): Promise<any> => {
            throw new Error('Database password incorrect in /etc/db.conf');
        });
        const handler = sigloFastifyHandler(flow(failStep), {
            exposeErrorDetails: false,
        });

        let sentStatus = 0;
        let sentBody: any;
        const mockReply = {
            status(s: number) {
                sentStatus = s;
                return this;
            },
            send(b: any) {
                sentBody = b;
                return b;
            },
        };

        await handler({}, mockReply);
        expect(sentStatus).to.equal(500);
        expect(sentBody.error).to.equal('Internal workflow execution error');
    });

    it('handles errors and maps to reply status via onError', async () => {
        const failStep = Step.create(async (): Promise<any> => {
            throw new Error('Forbidden operation');
        });
        const failingFlow = flow(failStep);

        let sentStatus = 0;
        let sentBody: any;
        const mockReply = {
            status(s: number) {
                sentStatus = s;
                return this;
            },
            send(b: any) {
                sentBody = b;
                return b;
            },
        };

        const handler = sigloFastifyHandler(failingFlow, {
            onError: (err, reply) => reply.status(403).send({ message: err.message }),
        });

        await handler({}, mockReply);
        expect(sentStatus).to.equal(403);
        expect(sentBody.message).to.equal('Forbidden operation');
    });

    it('maps default error status codes correctly without custom onError', async () => {
        const timeoutErr = new Error('Gateway timed out');
        timeoutErr.name = 'FlowTimeoutException';

        expect(getErrorStatusCode(timeoutErr)).to.equal(504);
        expect(getErrorStatusCode({ name: 'ValidationException' })).to.equal(400);

        const failingStep = Step.create(async (): Promise<any> => {
            throw timeoutErr;
        });
        const handler = sigloFastifyHandler(flow(failingStep));

        let sentStatus = 0;
        let sentBody: any;
        const mockReply = {
            status(s: number) {
                sentStatus = s;
                return this;
            },
            send(b: any) {
                sentBody = b;
                return b;
            },
        };

        await handler({}, mockReply);
        expect(sentStatus).to.equal(504);
        expect(sentBody.error).to.equal('Gateway timed out');
    });
});

describe('@siglo/fastify durable HTTP responses', () => {
    beforeEach(() => {
        clearStorage();
        defaultDurableManager.clear();
    });

    afterEach(() => {
        clearStorage();
        defaultDurableManager.clear();
    });

    function responseHarness() {
        const response = {
            statusCode: 200,
            body: undefined as any,
            headers: {} as Record<string, string>,
            header(name: string, value: string) {
                this.headers[name] = value;
            },
            setHeader(name: string, value: string) {
                this.headers[name] = value;
            },
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(body: any, status?: number) {
                if (status !== undefined) this.statusCode = status;
                this.body = body;
                return body;
            },
            send(body: any) {
                this.body = body;
                return body;
            },
        };
        return {
            response,
            async invoke(handler: any) {
                return handler({ body: {}, headers: {} }, response);
            },
        };
    }

    for (const kind of ['event', 'timer']) {
        it(`returns 202 and the suspension descriptor for a durable ${kind} wait`, async () => {
            let continued = false;
            let errorHandled = false;
            const waitStep =
                kind === 'event'
                    ? waitForEvent('approval', { correlationKey: 'order-202', timeout: '1h' })
                    : wait('1h');
            const workflow = flow(
                waitStep,
                Step.create(() => {
                    continued = true;
                    return { done: true };
                }),
            );
            const { response, invoke } = responseHarness();
            const result = await invoke(
                sigloFastifyHandler(workflow, {
                    durable: true,
                    onError: () => {
                        errorHandled = true;
                    },
                }),
            );

            expect(response.statusCode).to.equal(202);
            expect(result.status).to.equal('waiting');
            expect(result.stackId).to.equal(response.headers['X-Workflow-Stack-Id']);
            expect(result.stackId).to.be.a('string');
            expect(result.correlationKey).to.be.a('string');
            expect(result.expiresAt).to.be.a('number');
            expect(continued).to.equal(false);
            expect(errorHandled).to.equal(false);
        });
    }

    for (const enabled of [true, false, undefined]) {
        it(`resolves per-request durable=${enabled} and preserves 200 for non-durable waits`, async () => {
            const { response, invoke } = responseHarness();
            const workflow = flow(waitForEvent('approval', { correlationKey: 'order-option' }));
            let requestSeen: any;
            const result = await invoke(
                sigloFastifyHandler(workflow, {
                    durable:
                        enabled === undefined
                            ? undefined
                            : (request: any) => {
                                  requestSeen = request;
                                  return enabled;
                              },
                }),
            );
            if (enabled !== undefined) expect(requestSeen).to.exist;
            expect(response.statusCode).to.equal(enabled ? 202 : 200);
            if (enabled) expect(result.status).to.equal('waiting');
            else expect(result.waited).to.equal(true);
        });
    }

    it('leaves the response status under custom output control for a waiting workflow', async () => {
        const { response, invoke } = responseHarness();
        const result = await invoke(
            sigloFastifyHandler(flow(waitForEvent('approval', { correlationKey: 'order-custom' })), {
                durable: true,
                output: (result: any, reply: any) => reply.status(201).send(result),
            }),
        );
        expect(response.statusCode).to.equal(201);
        expect(result.status).to.equal('waiting');
    });

    it('returns 200 when a durable workflow completes without waiting', async () => {
        const { response, invoke } = responseHarness();
        const result = await invoke(sigloFastifyHandler(flow(Step.create(() => ({ done: true }))), { durable: true }));
        expect(response.statusCode).to.equal(200);
        expect(result.done).to.equal(true);
    });
});
