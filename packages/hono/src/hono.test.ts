import { expect } from 'chai';
import { Step, flow, waitForEvent, wait, clearStorage, defaultDurableManager } from '@siglo/core';
import { sigloMiddleware, getErrorStatusCode } from './index';

describe('@siglo/hono Adapter Suite', () => {
    it('executes workflow using request input and sends response', async () => {
        const calculateTax = Step.create(async ({ subtotal }: { subtotal: number }) => ({
            total: Math.round(subtotal * 1.15),
        }));
        const taxFlow = flow(calculateTax);

        const handler = sigloMiddleware(taxFlow, {
            input: (c: any) => ({ subtotal: c.body.subtotal }),
            output: (result: any, c: any) => c.json(result, 200),
        });

        const mockContext = {
            body: { subtotal: 100 },
            headers: {} as Record<string, string>,
            header(name: string, val: string) {
                this.headers[name] = val;
            },
            req: {
                header(name: string) {
                    if (name.toLowerCase() === 'x-correlation-id') return 'corr-123';
                    return undefined;
                },
            },
            jsonResponse: null as any,
            statusCode: 0,
            json(data: any, status = 200) {
                this.jsonResponse = data;
                this.statusCode = status;
                return { data, status };
            },
        };

        await handler(mockContext);

        expect(mockContext.statusCode).to.equal(200);
        expect(mockContext.jsonResponse.total).to.equal(115);
        expect(mockContext.headers['X-Workflow-Stack-Id']).to.be.a('string');
        expect(mockContext.headers['X-Correlation-Id']).to.equal('corr-123');
    });

    it('ignores x-namespace header by default and respects it only when allowHeaderNamespace is true', async () => {
        let capturedNamespace: string | undefined;
        const inspectStep = Step.create(async (param: any) => {
            capturedNamespace = typeof param.$namespace === 'function' ? param.$namespace() : param.$namespace;
            return { ok: true };
        });
        const testFlow = flow(inspectStep);

        const createMockContext = () => ({
            req: {
                header(name: string) {
                    if (name.toLowerCase() === 'x-namespace') return 'attacker-hono';
                    return undefined;
                },
            },
            json: (b: any) => b,
        });

        // Default: header is ignored for security
        const secureHandler = sigloMiddleware(testFlow);
        await secureHandler(createMockContext());
        expect(capturedNamespace).to.be.undefined;

        // With explicit opt-in: header is respected
        const optInHandler = sigloMiddleware(testFlow, { allowHeaderNamespace: true });
        await optInHandler(createMockContext());
        expect(capturedNamespace).to.equal('attacker-hono');
    });

    it('sanitizes internal 500 error messages when exposeErrorDetails is false', async () => {
        const failStep = Step.create(async (): Promise<any> => {
            throw new Error('Connection refused to redis://secret_auth@10.0.0.1:6379');
        });
        const handler = sigloMiddleware(flow(failStep), {
            exposeErrorDetails: false,
        });

        const mockContext = {
            jsonResponse: null as any,
            statusCode: 0,
            json(data: any, status = 200) {
                this.jsonResponse = data;
                this.statusCode = status;
                return { data, status };
            },
        };

        await handler(mockContext);
        expect(mockContext.statusCode).to.equal(500);
        expect(mockContext.jsonResponse.error).to.equal('Internal workflow execution error');
    });

    it('maps workflow errors to error response via onError', async () => {
        const failingStep = Step.create(async (): Promise<any> => {
            throw new Error('Out of stock');
        });
        const orderFlow = flow(failingStep);

        const handler = sigloMiddleware(orderFlow, {
            onError: (err: any, c: any) => c.json({ error: err.message }, 400),
        });

        const mockContext = {
            headers: {} as Record<string, string>,
            header(name: string, val: string) {
                this.headers[name] = val;
            },
            jsonResponse: null as any,
            statusCode: 0,
            json(data: any, status = 200) {
                this.jsonResponse = data;
                this.statusCode = status;
                return { data, status };
            },
        };

        await handler(mockContext);

        expect(mockContext.statusCode).to.equal(400);
        expect(mockContext.jsonResponse.error).to.equal('Out of stock');
    });

    it('maps default error status codes correctly without custom onError', async () => {
        const timeoutErr = new Error('Step timed out');
        timeoutErr.name = 'TimeoutException';

        const validationErr = new Error('Invalid schema');
        validationErr.name = 'SpecFailedException';

        const conflictErr = new Error('Key locked');
        conflictErr.name = 'IdempotencyConflictException';

        expect(getErrorStatusCode(timeoutErr)).to.equal(504);
        expect(getErrorStatusCode(validationErr)).to.equal(400);
        expect(getErrorStatusCode(conflictErr)).to.equal(409);
        expect(getErrorStatusCode(new Error('Internal failure'))).to.equal(500);

        const failingStep = Step.create(async (): Promise<any> => {
            throw timeoutErr;
        });
        const handler = sigloMiddleware(flow(failingStep));

        const mockContext = {
            jsonResponse: null as any,
            statusCode: 0,
            json(data: any, status = 200) {
                this.jsonResponse = data;
                this.statusCode = status;
                return { data, status };
            },
        };

        await handler(mockContext);
        expect(mockContext.statusCode).to.equal(504);
        expect(mockContext.jsonResponse.error).to.equal('Step timed out');
    });
});

describe('@siglo/hono durable HTTP responses', () => {
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
                await handler(response);
                return response.body;
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
                sigloMiddleware(workflow, {
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
                sigloMiddleware(workflow, {
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
            sigloMiddleware(flow(waitForEvent('approval', { correlationKey: 'order-custom' })), {
                durable: true,
                output: (result: any, c: any) => c.json(result, 201),
            }),
        );
        expect(response.statusCode).to.equal(201);
        expect(result.status).to.equal('waiting');
    });

    it('returns 200 when a durable workflow completes without waiting', async () => {
        const { response, invoke } = responseHarness();
        const result = await invoke(sigloMiddleware(flow(Step.create(() => ({ done: true }))), { durable: true }));
        expect(response.statusCode).to.equal(200);
        expect(result.done).to.equal(true);
    });
});
